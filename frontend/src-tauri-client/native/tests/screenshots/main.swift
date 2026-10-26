import AppKit
import ScreenCaptureKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var requests: [ScreenshotCapture.Completion] = []
var frames = 0
var failures: [String] = []
let capture = ScreenshotCapture(useMetal: false, request: { _, _, done in requests.append(done) })
let filter = SCContentFilter()
let configuration = SCStreamConfiguration()
func drain() { RunLoop.main.run(until: Date().addingTimeInterval(0.002)) }
func sample(width: Int = 4, height: Int = 4, lastByte: UInt8 = 0, metal: Bool = false) -> CMSampleBuffer {
    var buffer: CVPixelBuffer?
    let options = metal ? [kCVPixelBufferIOSurfacePropertiesKey: [:], kCVPixelBufferMetalCompatibilityKey: true] as CFDictionary : nil
    precondition(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, options, &buffer) == noErr)
    CVPixelBufferLockBaseAddress(buffer!, [])
    let bytes = CVPixelBufferGetBaseAddress(buffer!)!
    let stride = CVPixelBufferGetBytesPerRow(buffer!)
    memset(bytes, 0, stride * height)
    bytes.storeBytes(of: lastByte, toByteOffset: (height - 1) * stride + width * 4 - 1, as: UInt8.self)
    CVPixelBufferUnlockBaseAddress(buffer!, [])
    var format: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescriptionOut: &format)
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
    var result: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &result)
    return result!
}
func start() {
    capture.start(filter: filter, configuration: configuration, frame: { _ in frames += 1 }, failure: { failures.append($0) })
}
start()
precondition(requests.count == 1)
for _ in 0..<100 { capture.tick() }
precondition(requests.count == 1, "Requests must never overlap")
capture.update(filter: filter)
requests.removeFirst()(sample(), nil)
drain()
precondition(frames == 0, "Old allow-list result leaked after update")
capture.tick()
requests.removeFirst()(sample(), nil)
drain()
precondition(frames == 1, "Current frame was not delivered")
capture.tick()
precondition(requests.count == 1)
capture.stop()
start()
precondition(requests.count == 1, "Restart overlapped an uncancellable screenshot")
requests.removeFirst()(sample(), nil)
drain()
precondition(frames == 1, "Old session frame leaked into restarted output")
capture.tick()
requests.removeFirst()(sample(), nil)
drain()
precondition(frames == 2)
capture.tick()
capture.stop()
requests.removeFirst()(nil, NSError(domain: "Probe", code: 1))
drain()
precondition(failures.isEmpty, "Stale error stopped a new session")
start()
requests.removeFirst()(nil, nil)
drain()
precondition(failures.count == 1, "Invalid frame did not report failure")
capture.stop()
for _ in 0..<100 { capture.tick() }
precondition(requests.isEmpty, "Stopped source issued a new screenshot")
print("Screenshot lifecycle: bounded work, filter replacement, stop/restart, stale error and invalid-frame checks passed")

var cadence = ScreenshotCadence()
precondition(cadence.interval(changed: true, now: 0) == 1.0 / 30)
precondition(cadence.interval(changed: false, now: 0.3) == 1.0 / 15)
precondition(cadence.interval(changed: false, now: 1.1) == 1.0 / 5)
precondition(cadence.interval(changed: true, now: 1.2) == 1.0 / 30, "Changes must restore full rate immediately")
cadence.reset()
precondition(cadence.interval(changed: false, now: 100) == 1.0 / 30, "New filters/sessions must start at full rate")
let a = CMSampleBufferGetImageBuffer(sample(width: 129, height: 73))!
let b = CMSampleBufferGetImageBuffer(sample(width: 129, height: 73))!
let c = CMSampleBufferGetImageBuffer(sample(width: 129, height: 73, lastByte: 1))!
precondition(screenshotPixelsEqual(a, b), "Identical images should back off")
precondition(!screenshotPixelsEqual(a, c), "One-byte change at the final pixel must not be missed")
precondition(!screenshotPixelsEqual(a, CMSampleBufferGetImageBuffer(sample())!), "Dimension changes must be delivered")
print("Adaptive cadence: idle backoff, wake on changes, reset and exact edge-pixel detection passed")

// Real GPU results, odd dimensions/non-multiple-of-16 tails, every channel and
// first/middle/final pixels; one-byte differences must match exact CPU results.
if let gpu = ScreenshotMetalComparison() {
    for width in [1, 129, 1920, 3840] {
        let height = width == 1 ? 1 : width == 129 ? 73 : width * 9 / 16
        let left = CMSampleBufferGetImageBuffer(sample(width: width, height: height, metal: true))!
        let right = CMSampleBufferGetImageBuffer(sample(width: width, height: height, metal: true))!
        func check(_ expected: Bool) {
            let semaphore = DispatchSemaphore(value: 0)
            var answer: Bool?
            gpu.equal(left, right) { answer = $0; semaphore.signal() }
            precondition(semaphore.wait(timeout: .now() + 10) == .success)
            precondition(answer == expected, "GPU equality mismatch at width \(width)")
        }
        check(true)
        for pixel in [0, width * height / 2, width * height - 1] {
            for channel in 0..<4 {
                CVPixelBufferLockBaseAddress(right, [])
                let p = CVPixelBufferGetBaseAddress(right)!
                let offset = (pixel / width) * CVPixelBufferGetBytesPerRow(right) + (pixel % width) * 4 + channel
                p.storeBytes(of: UInt8(1), toByteOffset: offset, as: UInt8.self)
                CVPixelBufferUnlockBaseAddress(right, [])
                check(false)
                CVPixelBufferLockBaseAddress(right, [])
                p.storeBytes(of: UInt8(0), toByteOffset: offset, as: UInt8.self)
                CVPixelBufferUnlockBaseAddress(right, [])
            }
        }
        check(true)
    }
    gpu.disable()
    var fallback = false
    gpu.equal(a, b) { fallback = $0 == nil }
    precondition(fallback, "Disabled GPU must request CPU fallback")
    print("Metal exact comparison: all channels, edge/tail pixels, 1px/odd/1080p/4K and disabled fallback passed")
} else { print("Metal unavailable: CPU fallback retained") }

var comparisons: [(Bool) -> Void] = []
var queued: [ScreenshotCapture.Completion] = []
var delivered = 0
let asyncCapture = ScreenshotCapture(comparison: { _, _, done in
    DispatchQueue.main.async { comparisons.append(done) }
}, request: { _, _, done in queued.append(done) })
func startAsync() { asyncCapture.start(filter: filter, configuration: configuration, frame: { _ in delivered += 1 }, failure: { _ in preconditionFailure() }) }
func awaitCondition(_ predicate: () -> Bool) {
    let end = Date().addingTimeInterval(2)
    while !predicate() && Date() < end { drain() }
    precondition(predicate())
}
startAsync();queued.removeFirst()(sample(),nil);awaitCondition { delivered == 1 }
asyncCapture.tick();queued.removeFirst()(sample(),nil);awaitCondition { comparisons.count == 1 }
for _ in 0..<100 { asyncCapture.tick() }
precondition(queued.isEmpty, "GPU comparison must occupy the pending slot")
asyncCapture.update(filter: filter)
comparisons.removeFirst()(true);drain()
precondition(delivered == 1, "Stale GPU filter result leaked")
asyncCapture.tick();queued.removeFirst()(sample(),nil);awaitCondition { delivered == 2 }
asyncCapture.tick();queued.removeFirst()(sample(),nil);awaitCondition { comparisons.count == 1 }
asyncCapture.stop();startAsync()
precondition(queued.isEmpty, "Restart must wait for old GPU comparison")
comparisons.removeFirst()(false);drain()
precondition(delivered == 2, "Stale GPU restart result leaked")
asyncCapture.tick();queued.removeFirst()(sample(),nil);awaitCondition { delivered == 3 }
asyncCapture.stop()
print("Asynchronous GPU lifecycle: backpressure, filter change, stop/restart and stale completion passed")

// Localized change outside first/middle/final rows must also be found by GPU.
if let gpu = ScreenshotMetalComparison() {
    let left = CMSampleBufferGetImageBuffer(sample(width:129,height:73,metal:true))!
    let right = CMSampleBufferGetImageBuffer(sample(width:129,height:73,metal:true))!
    CVPixelBufferLockBaseAddress(right,[])
    CVPixelBufferGetBaseAddress(right)!.storeBytes(of:UInt8(1),toByteOffset:11*CVPixelBufferGetBytesPerRow(right)+17*4,as:UInt8.self)
    CVPixelBufferUnlockBaseAddress(right,[])
    let done = DispatchSemaphore(value:0);var answer:Bool?
    gpu.equal(left,right){answer=$0;done.signal()}
    precondition(done.wait(timeout:.now()+10) == .success && answer == false)
}
print("GPU localized edit outside edge/center rows passed")

// A delayed GPU completion must automatically resume capture, without overlapping
// work or relying on a leftover repeating timer/manual tick.
startAsync();queued.removeFirst()(sample(),nil);awaitCondition { delivered == 4 }
awaitCondition { !queued.isEmpty }
queued.removeFirst()(sample(),nil);awaitCondition { !comparisons.isEmpty }
RunLoop.main.run(until:Date().addingTimeInterval(0.06))
precondition(queued.isEmpty, "Delayed GPU work must remain bounded")
comparisons.removeFirst()(false)
awaitCondition { !queued.isEmpty }
asyncCapture.stop();queued.removeFirst()(sample(),nil);drain()
precondition(delivered == 5, "Late completion after stop must not be presented")
print("Frame deadline scheduler: delayed GPU work resumes automatically and stays bounded")
