import AppKit
import ScreenCaptureKit
import Metal

// Preserve even one-pixel text/cursor changes. Compare actual BGRA bytes, never a
// thumbnail/hash. libc memcmp short-circuits changing frames; run off the UI queue.
func screenshotPixelsEqual(_ a: CVPixelBuffer, _ b: CVPixelBuffer) -> Bool {
    let width = CVPixelBufferGetWidth(a), height = CVPixelBufferGetHeight(a)
    guard width == CVPixelBufferGetWidth(b), height == CVPixelBufferGetHeight(b),
          CVPixelBufferGetPixelFormatType(a) == kCVPixelFormatType_32BGRA,
          CVPixelBufferGetPixelFormatType(b) == kCVPixelFormatType_32BGRA,
          !CVPixelBufferIsPlanar(a), !CVPixelBufferIsPlanar(b) else { return false }
    guard CVPixelBufferLockBaseAddress(a, .readOnly) == kCVReturnSuccess else { return false }
    defer { CVPixelBufferUnlockBaseAddress(a, .readOnly) }
    guard CVPixelBufferLockBaseAddress(b, .readOnly) == kCVReturnSuccess else { return false }
    defer { CVPixelBufferUnlockBaseAddress(b, .readOnly) }
    guard let pa = CVPixelBufferGetBaseAddress(a), let pb = CVPixelBufferGetBaseAddress(b) else { return false }
    let ra = CVPixelBufferGetBytesPerRow(a), rb = CVPixelBufferGetBytesPerRow(b)
    for y in 0..<height {
        if memcmp(pa.advanced(by: y * ra), pb.advanced(by: y * rb), width * 4) != 0 { return false }
    }
    return true
}

// All setup/submission uses ScreenshotCapture's serial comparison queue. Pixel
// buffers are mapped as IOSurface-backed textures; only a four-byte result returns
// to the CPU. No readback/copy of the full image, no main-thread GPU wait.
@available(macOS 12.3, *)
final class ScreenshotMetalComparison {
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLComputePipelineState
    private let cache: CVMetalTextureCache
    private let result: MTLBuffer
    private(set) var disabled = false

    init?() {
        guard let device = MTLCreateSystemDefaultDevice(), device.hasUnifiedMemory,
              let queue = device.makeCommandQueue(),
              let result = device.makeBuffer(length: 4, options: .storageModeShared) else { return nil }
        let source = """
        #include <metal_stdlib>
        using namespace metal;
        kernel void comparePixels(texture2d<float, access::read> a [[texture(0)]],
                                  texture2d<float, access::read> b [[texture(1)]],
                                  device atomic_uint *changed [[buffer(0)]],
                                  uint index [[thread_position_in_grid]],
                                  uint local [[thread_index_in_threadgroup]]) {
            // Once any thread proves a difference, the whole image is different.
            // Skip remaining chunks instead of contending on the result flag.
            threadgroup uint skip;
            if (local == 0) skip = atomic_load_explicit(changed, memory_order_relaxed);
            threadgroup_barrier(mem_flags::mem_threadgroup);
            if (skip != 0u) return;
            uint width = a.get_width(), count = width * a.get_height();
            // One flag write per changed chunk, rather than per changed pixel.
            for (uint i = index * 16; i < min(index * 16 + 16, count); ++i) {
                uint2 xy = uint2(i % width, i / width);
                if (any(a.read(xy) != b.read(xy))) {
                    atomic_store_explicit(changed, 1u, memory_order_relaxed);
                    return;
                }
            }
        }
        """
        guard let library = try? device.makeLibrary(source: source, options: nil),
              let function = library.makeFunction(name: "comparePixels"),
              let pipeline = try? device.makeComputePipelineState(function: function) else { return nil }
        var cache: CVMetalTextureCache?
        guard CVMetalTextureCacheCreate(nil, nil, device, nil, &cache) == kCVReturnSuccess, let cache else { return nil }
        self.device = device; self.queue = queue; self.pipeline = pipeline
        self.cache = cache; self.result = result
    }

    // nil means unsupported/failed: the caller runs the exact CPU fallback.
    // Caller serializes operations (including completion) to protect result/cache.
    func equal(_ a: CVPixelBuffer, _ b: CVPixelBuffer, completion: @escaping (Bool?) -> Void) {
        guard !disabled else { completion(nil); return }
        let width = CVPixelBufferGetWidth(a), height = CVPixelBufferGetHeight(a)
        guard width == CVPixelBufferGetWidth(b), height == CVPixelBufferGetHeight(b),
              CVPixelBufferGetPixelFormatType(a) == kCVPixelFormatType_32BGRA,
              CVPixelBufferGetPixelFormatType(b) == kCVPixelFormatType_32BGRA else { completion(false); return }
        func texture(_ pixels: CVPixelBuffer) -> CVMetalTexture? {
            var texture: CVMetalTexture?
            guard CVMetalTextureCacheCreateTextureFromImage(nil, cache, pixels, nil,
                .bgra8Unorm, width, height, 0, &texture) == kCVReturnSuccess else { return nil }
            return texture
        }
        guard let ta = texture(a), let tb = texture(b),
              let ma = CVMetalTextureGetTexture(ta), let mb = CVMetalTextureGetTexture(tb),
              let command = queue.makeCommandBuffer(), let encoder = command.makeComputeCommandEncoder() else {
            disabled = true; completion(nil); return
        }
        result.contents().storeBytes(of: UInt32(0), as: UInt32.self)
        encoder.setComputePipelineState(pipeline)
        encoder.setTexture(ma, index: 0); encoder.setTexture(mb, index: 1)
        encoder.setBuffer(result, offset: 0, index: 0)
        let threads = min(256, pipeline.maxTotalThreadsPerThreadgroup)
        encoder.dispatchThreads(MTLSize(width: (width * height + 15) / 16, height: 1, depth: 1),
                                threadsPerThreadgroup: MTLSize(width: threads, height: 1, depth: 1))
        encoder.endEncoding()
        command.addCompletedHandler { [self] command in
            // Keep both CVMetalTexture wrappers and source buffers alive until GPU completion.
            withExtendedLifetime((a, b, ta, tb)) {
                completion(command.status == .completed ? result.contents().load(as: UInt32.self) == 0 : nil)
            }
        }
        command.commit()
    }

    func disable() { disabled = true }
}

struct ScreenshotCadence {
    private var lastChange: TimeInterval?
    mutating func reset() { lastChange = nil }
    mutating func interval(changed: Bool, now: TimeInterval) -> TimeInterval {
        if changed || lastChange == nil { lastChange = now }
        let quiet = now - (lastChange ?? now)
        return quiet >= 1 ? 1.0 / 5 : quiet >= 0.25 ? 1.0 / 15 : 1.0 / 30
    }
}

// A bounded sequence of ScreenCaptureKit screenshots retains application allow-list
// filtering without declaring every source window to be a live shared window.
// macOS 14 introduced both this API and the per-window sharing controls.
@available(macOS 12.3, *)
final class ScreenshotCapture {
    typealias Completion = (CMSampleBuffer?, Error?) -> Void
    typealias Request = (SCContentFilter, SCStreamConfiguration, @escaping Completion) -> Void
    private let request: Request
    private var timer: Timer?
    private var filter: SCContentFilter?
    private var configuration: SCStreamConfiguration?
    private var frame: ((CMSampleBuffer) -> Void)?
    private var failure: ((String) -> Void)?
    private var revision: UInt64 = 0
    private var pending = false
    private let adaptive: Bool
    private let useMetal: Bool
    private(set) var metalComparisons = 0
    private(set) var cpuComparisons = 0
    private var metalInitialized = false
    private var metal: ScreenshotMetalComparison?
    typealias Comparison = (CVPixelBuffer, CVPixelBuffer, @escaping (Bool) -> Void) -> Void
    private let comparison: Comparison?
    private let comparisonQueue = DispatchQueue(label: "dev.sharecode.capture-comparison", qos: .userInitiated)
    private var previous: CVPixelBuffer?
    private var cadence = ScreenshotCadence()
    private var interval: TimeInterval = 1.0 / 30
    private var requestStarted: TimeInterval = 0

    init(adaptive: Bool = true, useMetal: Bool = true, comparison: Comparison? = nil, request: Request? = nil) {
        self.useMetal = useMetal
        self.comparison = comparison
        self.adaptive = adaptive
        self.request = request ?? { filter, config, completion in
            if #available(macOS 14.0, *) {
                SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: config, completionHandler: completion)
            } else {
                completion(nil, NSError(domain: "ShareCodeCapture", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Screenshot capture requires macOS 14"]))
            }
        }
    }

    func start(filter: SCContentFilter, configuration: SCStreamConfiguration,
               frame: @escaping (CMSampleBuffer) -> Void, failure: @escaping (String) -> Void) {
        precondition(Thread.isMainThread)
        stop()
        self.filter = filter
        self.configuration = configuration
        self.frame = frame
        self.failure = failure
        schedule(interval: 1.0 / 30)
        tick()
    }

    func update(filter: SCContentFilter) {
        precondition(Thread.isMainThread)
        revision &+= 1 // A result using the old allow-list must not be presented.
        self.filter = filter
        previous = nil
        cadence.reset()
        schedule(interval: 1.0 / 30)
        tick()
    }

    private func schedule(interval: TimeInterval) {
        timer?.invalidate()
        self.interval = interval
        // Deadline from request start, not a repeating timer: when GPU completion
        // narrowly misses a 30 Hz tick, resume immediately instead of losing an
        // entire extra frame interval. Never overlap capture/comparison work.
        let remaining = interval - (ProcessInfo.processInfo.systemUptime - requestStarted)
        let timer = Timer(timeInterval: max(0.001, remaining), repeats: false) { [weak self] _ in self?.tick() }
        timer.tolerance = 0.001
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func stop() {
        precondition(Thread.isMainThread)
        revision &+= 1
        timer?.invalidate()
        timer = nil
        filter = nil
        configuration = nil
        frame = nil
        failure = nil
        previous = nil
        cadence.reset()
        // SCScreenshotManager has no cancel API. Keep the pending slot occupied
        // across stop/restart until its completion arrives; never pile up requests.
    }

    func tick() {
        precondition(Thread.isMainThread)
        guard !pending, let filter, let configuration else { return }
        pending = true
        timer?.invalidate(); timer = nil
        requestStarted = ProcessInfo.processInfo.systemUptime
        let ticket = revision
        request(filter, configuration) { [weak self] buffer, error in
            DispatchQueue.main.async {
                guard let self else { return }
                guard ticket == self.revision, self.filter != nil else {
                    self.pending = false
                    if self.filter != nil { self.schedule(interval: self.interval) }
                    return
                }
                if let error { self.pending = false; self.failure?(error.localizedDescription); return }
                guard let buffer, buffer.isValid, let pixels = CMSampleBufferGetImageBuffer(buffer) else {
                    self.pending = false
                    self.failure?("Screen capture returned an invalid frame")
                    return
                }
                guard self.adaptive else {
                    self.pending = false; self.schedule(interval: 1.0 / 30); self.frame?(buffer); return
                }
                let previous = self.previous
                self.comparisonQueue.async { [weak self] in
                    guard let self else { return }
                    let deliver: (Bool, Bool) -> Void = { [weak self] equal, gpu in
                        DispatchQueue.main.async {
                            guard let self else { return }
                            self.pending = false
                            guard ticket == self.revision, self.filter != nil else {
                                if self.filter != nil { self.schedule(interval: self.interval) }
                                return
                            }
                            if previous != nil {
                                if gpu { self.metalComparisons += 1 } else { self.cpuComparisons += 1 }
                            }
                            self.previous = pixels
                            self.schedule(interval: self.cadence.interval(changed: !equal, now: ProcessInfo.processInfo.systemUptime))
                            // Idle frames also serve the controller's liveness watchdog.
                            self.frame?(buffer)
                        }
                    }
                    guard let previous else { deliver(false, false); return }
                    if let comparison = self.comparison { comparison(previous, pixels) { deliver($0, false) }; return }
                    if self.useMetal && !self.metalInitialized {
                        self.metalInitialized = true
                        self.metal = ScreenshotMetalComparison()
                    }
                    guard let metal = self.metal, !metal.disabled else {
                        deliver(screenshotPixelsEqual(previous, pixels), false); return
                    }
                    metal.equal(previous, pixels) { [weak self] equal in
                        guard let self else { return }
                        self.comparisonQueue.async {
                            if let equal { deliver(equal, true) }
                            else {
                                metal.disable()
                                deliver(screenshotPixelsEqual(previous, pixels), false)
                            }
                        }
                    }
                }
            }
        }
    }

    deinit { timer?.invalidate() }
}
