import AppKit
import ScreenCaptureKit
import CoreMedia

let root = URL(fileURLWithPath: "/tmp/sharecode-capture-indicator-test")
try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let isSource = Bundle.main.bundleIdentifier == "dev.sharecode.capture-source-test"
let window = NSWindow(contentRect: NSRect(x: isSource ? 180 : 700, y: 280, width: 520, height: 310),
    styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = isSource ? "ShareCode Filter Source" : "ShareCode Capture Filter Test"
window.isReleasedWhenClosed = false
window.backgroundColor = isSource ? NSColor(calibratedRed: 0.05, green: 0.8, blue: 0.15, alpha: 1) : NSColor(calibratedRed: 0.984, green: 0.004, blue: 0.976, alpha: 1)
let label = NSTextField(labelWithString: isSource ? "Synthetic source — no private data" : "Local capture test — no network or saved video")
label.frame = NSRect(x: 20, y: 210, width: 480, height: 70)
label.font = .systemFont(ofSize: 20)
label.maximumNumberOfLines = 3
window.contentView!.addSubview(label)
let preview = NSImageView(frame: NSRect(x: 10, y: 10, width: 500, height: 190))
preview.imageScaling = .scaleProportionallyUpOrDown
window.contentView!.addSubview(preview)
window.orderFrontRegardless()

@available(macOS 14, *)
final class Probe: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    var mode = "stop"
    var generation = 0
    var frames = 0
    var errors = 0
    var style = -1
    var started = Date()
    var last = Date.distantPast
    var pending = false
    var filter: SCContentFilter?
    var config: SCStreamConfiguration?
    var sourceWindowIDs: [UInt32] = []
    var green = 0
    var magenta = 0
    var message = "Ready"
    var productionState: [String: Any] = [:]
    var inspection: [String: Any] = [:]
    var lastInspection = Date.distantPast
    var checksums = Set<UInt64>()
    var maximumMagenta = 0

    func start(_ next: String) {
        generation += 1
        let ticket = generation
        mode = next
        screenShareStop()
        productionState = [:]
        pending = false
        filter = nil
        let old = stream
        stream = nil
        old?.stopCapture { _ in }
        checksums.removeAll(); maximumMagenta = 0
        frames = 0; errors = 0; started = Date(); style = -1
        guard next != "stop" else { message = "Stopped"; return }
        guard CGPreflightScreenCaptureAccess() else { message = "Screen Recording permission required"; return }
        if next == "production" {
            if let value = screenShareCommand(2, CGMainDisplayID(), 0) { screenShareFree(value) }
            message = "Starting production virtual output"
            return
        }
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            DispatchQueue.main.async {
                guard ticket == self.generation else { return }
                guard let content, let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
                    self.message = "Content unavailable: \(String(describing: error))"; return
                }
                let source = content.applications.filter { $0.bundleIdentifier == "dev.sharecode.capture-source-test" }
                let windows = content.windows.filter { $0.owningApplication?.bundleIdentifier == "dev.sharecode.capture-source-test" }
                self.sourceWindowIDs = windows.map { $0.windowID }
                guard !source.isEmpty else { self.message = "Launch source first"; return }
                let filter: SCContentFilter
                switch next {
                case "exclude":
                    filter = SCContentFilter(display: display, excludingApplications: content.applications.filter { $0.bundleIdentifier != "dev.sharecode.capture-source-test" }, exceptingWindows: [])
                case "windows": filter = SCContentFilter(display: display, including: windows)
                default: filter = SCContentFilter(display: display, including: source, exceptingWindows: [])
                }
                if #available(macOS 14.2, *) { filter.includeMenuBar = next == "apps-menu" }
                let config = SCStreamConfiguration()
                config.width = 2560; config.height = 1662
                if next == "snapshot-4k" { config.width = 3840; config.height = 2160 }
                config.pixelFormat = kCVPixelFormatType_32BGRA
                config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
                config.queueDepth = 3
                config.showsCursor = false
                config.capturesAudio = false
                self.filter = filter; self.config = config; self.style = filter.style.rawValue
                self.message = "Starting \(next)"
                if next.hasPrefix("snapshot") { self.message = "Capturing screenshots"; return }
                let stream = SCStream(filter: filter, configuration: config, delegate: self)
                do {
                    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
                    self.stream = stream
                    stream.startCapture { error in DispatchQueue.main.async {
                        guard ticket == self.generation else { return }
                        self.message = error?.localizedDescription ?? "Capturing \(next)"
                    }}
                } catch { self.message = error.localizedDescription }
            }
        }
    }
    func tick() {
        if mode == "production", !pending, Date().timeIntervalSince(lastInspection) > 1 {
            lastInspection = Date()
            if let value = screenShareCommand(0, 0, 0) {
                defer { screenShareFree(value) }
                productionState = (try? JSONSerialization.jsonObject(with: Data(String(cString: value).utf8))) as? [String: Any] ?? [:]
            }
            message = "Production: \(productionState["phase"] ?? "unknown")"
            guard let id = productionState["outputDisplay"] as? UInt32 else { return }
            let ticket = generation
            pending = true
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
                DispatchQueue.main.async {
                    guard ticket == self.generation else { return }
                    guard let display = content?.displays.first(where: { $0.displayID == id }) else { self.pending = false; return }
                    self.inspection["sources"] = content!.windows.filter { $0.owningApplication?.bundleIdentifier == "dev.sharecode.capture-source-test" }.map { ["id": $0.windowID, "frame": NSStringFromRect($0.frame), "onScreen": $0.isOnScreen] }
                    self.inspection["excludedApps"] = content!.applications.filter { CapturePolicy.excludes(bundleID: $0.bundleIdentifier, name: $0.applicationName, path: NSRunningApplication(processIdentifier: $0.processID)?.bundleURL?.path ?? "", pid: $0.processID, ownBundleID: Bundle.main.bundleIdentifier!, ownPID: ProcessInfo.processInfo.processIdentifier) }.map { $0.bundleIdentifier }
                    self.inspection["meetingWindows"] = content!.windows.filter { $0.owningApplication?.bundleIdentifier == "com.tencent.meeting" }.map { ["id": $0.windowID, "frame": NSStringFromRect($0.frame), "onScreen": $0.isOnScreen] }
                    self.inspection["sourceDisplayBounds"] = NSStringFromRect(CGDisplayBounds(CGMainDisplayID()))
                    if let output = NSApp.windows.first(where: { $0.title == "secondary monitor" }) {
                        self.inspection["outputFrame"] = NSStringFromRect(output.frame)
                        self.inspection["outputViewBounds"] = NSStringFromRect(output.contentView!.bounds)
                        self.inspection["outputLayerBounds"] = output.contentView!.layer!.sublayers!.map { NSStringFromRect($0.bounds) }
                    }
                    self.inspection["incoming"] = captureProbeFrameStats
                    let config = SCStreamConfiguration()
                    config.width = self.productionState["outputWidth"] as? Int ?? 1920
                    config.height = self.productionState["outputHeight"] as? Int ?? 1080
                    config.pixelFormat = kCVPixelFormatType_32BGRA
                    SCScreenshotManager.captureSampleBuffer(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config) { buffer, error in
                        DispatchQueue.main.async {
                            guard ticket == self.generation else { return }
                            self.pending = false
                            if let buffer { self.received(buffer) } else { self.errors += 1 }
                        }
                    }
                }
            }
            return
        }
        if mode.hasPrefix("snapshot"), !pending, let filter, let config {
            pending = true
            let ticket = generation
            SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: config) { sample, error in
                DispatchQueue.main.async {
                    guard ticket == self.generation else { return }
                    self.pending = false
                    if let sample { self.received(sample) } else { self.errors += 1; self.message = error?.localizedDescription ?? "No screenshot" }
                }
            }
        }
    }
    func received(_ sample: CMSampleBuffer) {
        frames += 1
        guard Date().timeIntervalSince(last) > 0.5, let buffer = CMSampleBufferGetImageBuffer(sample) else { return }
        last = Date(); green = 0; magenta = 0
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let data = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) else { return }
        if mode == "production" {
            let ci = CIImage(cvPixelBuffer: buffer)
            let context = CIContext(options: [.useSoftwareRenderer: false])
            if let image = context.createCGImage(ci, from: ci.extent) {
                preview.image = NSImage(cgImage: image, size: NSSize(width: 500, height: 190))
            }
        }
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        var checksum: UInt64 = 14695981039346656037
        for y in Swift.stride(from: 0, to: CVPixelBufferGetHeight(buffer), by: 12) {
            for x in Swift.stride(from: 0, to: CVPixelBufferGetWidth(buffer), by: 12) {
                let p = y * stride + x * 4
                checksum = (checksum ^ UInt64(data[p]) ^ (UInt64(data[p+1]) << 8) ^ (UInt64(data[p+2]) << 16)) &* 1099511628211
                if data[p+1] > 150 && data[p] < 100 && data[p+2] < 100 { green += 1 }
                if data[p+1] < 20 && data[p] > 230 && data[p+2] > 230 { magenta += 1 }
            }
        }
        checksums.insert(checksum)
        maximumMagenta = max(maximumMagenta, magenta)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard stream === self.stream, type == .screen else { return }
        received(sampleBuffer)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { self.message = error.localizedDescription }
    }
    func status() -> [String: Any] {
        ["mode": mode, "message": message, "permission": CGPreflightScreenCaptureAccess(),
         "frames": frames, "errors": errors, "fps": Double(frames) / max(0.001, Date().timeIntervalSince(started)),
         "style": style, "sourceWindows": sourceWindowIDs, "greenSamples": green, "excludedMagentaSamples": magenta,
         "distinctOutputSamples": checksums.count, "maximumExcludedMagenta": maximumMagenta, "production": productionState, "inspection": inspection, "timestamp": Date().timeIntervalSince1970]
    }
}
let probe = Probe()
var command = ""
var sourceFrames = 0
let timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
    if isSource {
        sourceFrames += 1
        label.stringValue = "Synthetic source — no private data\nFrame \(sourceFrames)"
        return
    }
    if let next = try? String(contentsOf: root.appendingPathComponent("command"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), next != command {
        command = next
        if next == "quit" { screenShareStop(); app.terminate(nil) }
        probe.start(next)
    }
    probe.tick()
    if let data = try? JSONSerialization.data(withJSONObject: probe.status(), options: [.sortedKeys]) {
        try? data.write(to: root.appendingPathComponent("status.json"), options: .atomic)
    }
    label.stringValue = "\(probe.message)\nFrames: \(probe.frames) · style: \(probe.style)"
}
RunLoop.main.add(timer, forMode: .common)
app.run()
