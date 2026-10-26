import AppKit
import AVFoundation

// Isolated synthetic source: never captures the user's desktop.
let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHARE_VISIBILITY_DIR"] ?? "/tmp/sharecode-visibility-test")
try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "Share window visibility experiment")
final class TestWindow: NSWindow {
    var unconstrained = false
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        unconstrained ? frameRect : super.constrainFrameRect(frameRect, to: screen)
    }
}
let window = TestWindow(contentRect: NSRect(x: 60, y: 120, width: 640, height: 360), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = "ShareCode Visibility Test"
window.isReleasedWhenClosed = false
window.isOpaque = true
window.backgroundColor = .black
window.sharingType = .readOnly
let view = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 360))
view.wantsLayer = true
view.layer?.backgroundColor = NSColor.black.cgColor
let video = AVSampleBufferDisplayLayer()
video.frame = view.bounds
video.videoGravity = .resizeAspect
view.layer!.addSublayer(video)
window.contentView = view
window.orderFrontRegardless()
let originalFrame = window.frame
let cover = NSWindow(contentRect: originalFrame, styleMask: [.borderless], backing: .buffered, defer: false)
cover.isReleasedWhenClosed = false
cover.title = "Test occluder"
cover.backgroundColor = .black
cover.level = .floating
var phase = "visible"
var command = ""
var generated = 0
var enqueued = 0
var requestedX: Double? = nil
var serverBounds: [String: Any] = [:]

func restore() {
    app.unhideWithoutActivation()
    if window.isMiniaturized { window.deminiaturize(nil) }
    cover.orderOut(nil)
    window.setFrame(originalFrame, display: true)
    window.orderFrontRegardless()
}

func render() {
    generated += 1
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(nil, 640, 360, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer)
    guard let buffer = buffer else { return }
    CVPixelBufferLockBaseAddress(buffer, [])
    let bytes = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    // A 12-bit counter encoded as broad vertical bars, plus changing background.
    for y in 0..<360 {
        for x in 0..<640 {
            let p = y * stride + x * 4
            let bit = (generated >> min(11, x / 53)) & 1
            bytes[p] = y < 180 ? UInt8(bit * 255) : UInt8((generated * 17) % 220 + 20)
            bytes[p + 1] = y < 180 ? UInt8(bit * 255) : UInt8((generated * 31) % 220 + 20)
            bytes[p + 2] = y < 180 ? UInt8(bit * 255) : UInt8((generated * 47) % 220 + 20)
            bytes[p + 3] = 255
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    var format: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer, formatDescriptionOut: &format)
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 10), presentationTimeStamp: CMTime(value: Int64(generated), timescale: 10), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buffer, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample)
    if video.status == .failed { video.flush() }
    if video.isReadyForMoreMediaData, let sample = sample {
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true)!
        let entry = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
        CFDictionarySetValue(entry, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        video.enqueue(sample)
        enqueued += 1
    }
}

let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    if let next = try? String(contentsOf: root.appendingPathComponent("command"), encoding: .utf8), next != command {
        command = next
        phase = next.trimmingCharacters(in: .whitespacesAndNewlines)
        let coordinates = phase.split(separator: ":")
        if coordinates.count == 2, ["x", "rawx"].contains(String(coordinates[0])), let x = Double(coordinates[1]), x.isFinite {
            window.unconstrained = coordinates[0] == "rawx"
            requestedX = x
            window.setFrameOrigin(NSPoint(x: x, y: originalFrame.minY))
        } else {
            requestedX = nil
            window.unconstrained = false
            restore()
            switch phase {
            case "covered": cover.setFrame(window.frame, display: true); cover.orderFrontRegardless()
            case "offscreen":
                let right = NSScreen.screens.map { $0.frame.maxX }.max() ?? 2000
                window.setFrameOrigin(NSPoint(x: right + 200, y: originalFrame.minY))
            case "orderOut": window.orderOut(nil)
            case "appHide": app.hide(nil)
            case "minimized": window.miniaturize(nil)
            case "quit": app.terminate(nil)
            default: break
            }
        }
    }
    if let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]],
       let own = windows.first(where: { ($0[kCGWindowNumber as String] as? Int) == window.windowNumber }) {
        serverBounds = own[kCGWindowBounds as String] as? [String: Any] ?? [:]
    }
    render()
    let info: [String: Any] = ["phase": phase, "generated": generated, "enqueued": enqueued,
        "windowID": window.windowNumber, "visible": window.isVisible, "miniaturized": window.isMiniaturized,
        "appHidden": app.isHidden, "frame": NSStringFromRect(window.frame), "layerStatus": video.status.rawValue,
        "requestedX": requestedX as Any? ?? NSNull(), "actualX": window.frame.minX, "serverBounds": serverBounds,
        "unconstrained": window.unconstrained,
        "timestamp": Date().timeIntervalSince1970]
    if let data = try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys]) {
        try? data.write(to: root.appendingPathComponent("source.json"), options: .atomic)
    }
}
RunLoop.main.add(timer, forMode: .common)
app.run()
