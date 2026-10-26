import AppKit
import Darwin
import AVFoundation
import ScreenCaptureKit

#if CAPTURE_PROBE
// Isolated native fixture only; numeric pixel checks, never stored screen images.
var captureProbeFrameStats: [String: Any] = [:]
private var captureProbeFrames = 0
#endif

// A display-sized, nonactivating surface on our virtual output only. No native
// full-screen Space transition, physical-screen overlay, title bar or Dock entry.
final class SharedOutputWindow: NSWindow {
    init(screen: NSScreen) {
        super.init(contentRect: screen.frame, styleMask: [.borderless],
                   backing: .buffered, defer: false)
        title = "secondary monitor"
        isReleasedWhenClosed = false
        isOpaque = true
        backgroundColor = .black
        sharingType = .readOnly
        level = .screenSaver // Cover the virtual display's menu bar and Dock too.
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        animationBehavior = .none
        isMovable = false
        fillScreen(screen)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    func fillScreen(_ screen: NSScreen) { setFrame(screen.frame, display: true) }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        if NSScreen.screens.contains(where: { $0.frame == frameRect }) { return frameRect }
        return super.constrainFrameRect(frameRect, to: screen)
    }
}

// Frames stay native in this process; only control/status JSON crosses the Tauri bridge.
// All controller state and sample delivery use the main queue.
@available(macOS 12.3, *)
private final class ShareSurface: NSView {
    let video = AVSampleBufferDisplayLayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        video.videoGravity = .resizeAspect
        layer?.addSublayer(video)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        video.frame = bounds
        CATransaction.commit()
    }

    func clear() { video.flushAndRemoveImage() }

    func display(_ buffer: CMSampleBuffer) {
        if video.status == .failed { video.flush() }
        guard video.isReadyForMoreMediaData else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: true) {
            let entry = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(entry, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        video.enqueue(buffer)
    }
}

@available(macOS 12.3, *)
private final class ScreenShare: NSObject, NSWindowDelegate, SCStreamOutput, SCStreamDelegate {
    static let shared = ScreenShare()
    private var chinese = false
    private var output: SharedOutputWindow?
    private var surface: ShareSurface?
    private var virtualDisplay: SharedVirtualDisplay?
    private var outputPreparation: VirtualOutputPreparation?
    private var sourceBounds: CGRect?
    private var sourcePixels: CGSize?
    private var stream: SCStream?
    private let screenshots = ScreenshotCapture()
    private var usingScreenshots = false
    private var generation: UInt64 = 0
    private var wanted = false
    private var refreshing = false
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []
    private var identities: [String] = []
    private var lastFrame = Date()
    private var selectedDisplay: CGDirectDisplayID?
    private var receiving = false
    private var phase = "idle"
    private var error: String?
    private var displays: [CaptureDisplay] = []

    private func tr(_ zh: String, _ en: String) -> String { chinese ? zh : en }

    func perform(_ action: Int32, display: UInt32, chinese: Bool) {
        self.chinese = chinese
        switch action {
        case 1: refreshDisplays()
        case 2:
            if !wanted {
                selectedDisplay = display == 0 ? nil : display
                start()
            }
        case 3: stop()
        case 4:
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
        default: break // State reads never request permission or start capture.
        }
    }

    func snapshot() -> CaptureState {
        let permission = CGPreflightScreenCaptureAccess()
        return CaptureState(supported: true, permission: permission,
            phase: !permission && phase == "idle" ? "permissionRequired" : phase,
            running: wanted, displays: displays, selectedDisplay: selectedDisplay, error: error,
            outputDisplay: output == nil ? nil : virtualDisplay?.id, outputWidth: output == nil ? nil : virtualDisplay?.width, outputHeight: output == nil ? nil : virtualDisplay?.height, virtualDisplaySupported: SharedVirtualDisplay.available)
    }

    private func permission() -> Bool {
        if CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() { return true }
        phase = "permissionRequired"
        return false
    }

    private func refreshDisplays() {
        guard !wanted, permission() else { return }
        generation &+= 1
        let ticket = generation
        error = nil
        phase = "loading"
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            DispatchQueue.main.async {
                guard ticket == self.generation else { return }
                guard let content = content, error == nil else {
                    self.fail(error?.localizedDescription ?? "No screen capture content")
                    return
                }
                self.displays = content.displays.filter { !SharedVirtualDisplay.isOutput($0.displayID) }.map { CaptureDisplay(id: $0.displayID, width: $0.width, height: $0.height) }
                self.phase = "idle"
            }
        }
    }

    private func start() {
        guard !wanted, permission() else { return }
        guard SharedVirtualDisplay.available else {
            fail(tr("此系统无法创建虚拟显示器。", "This system cannot create a virtual display."))
            return
        }
        generation &+= 1
        wanted = true
        receiving = false
        error = nil
        phase = "starting"
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification,
                     NSWorkspace.sessionDidResignActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.fail(self?.tr("共享已暂停，请解锁或唤醒后重新开始。", "Sharing stopped. Start again after unlocking or waking.") ?? "Stopped")
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main) { [weak self] _ in
                guard let self = self, self.wanted else { return }
                // Creation/removal generates screen notifications too. Once output is
                // visible, never let macOS migrate it onto a physical display.
                if self.output != nil { _ = self.validateOutput() }
            })
        lastFrame = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            guard CGPreflightScreenCaptureAccess() else {
                self.fail(self.tr("录屏权限已撤销。", "Screen recording permission was revoked."))
                return
            }
            // A static screen need not deliver new frames. Only time out startup, not idle capture.
            if (self.usingScreenshots || !self.receiving) && Date().timeIntervalSince(self.lastFrame) > (self.stream == nil && !self.usingScreenshots ? 30 : 10) {
                self.fail(self.tr("画面已中断，请重新开始共享。", "Capture interrupted. Start sharing again."))
                return
            }
            self.refreshCapture()
        }
        refreshCapture()
    }

    private func allowed(_ app: SCRunningApplication) -> Bool {
        let native = NSRunningApplication(processIdentifier: app.processID)
        if let path = native?.bundleURL?.standardizedFileURL.path,
           path == Bundle.main.bundleURL.standardizedFileURL.path ||
            path.hasPrefix(Bundle.main.bundleURL.standardizedFileURL.path + "/") { return false }
        return !CapturePolicy.excludes(bundleID: app.bundleIdentifier, name: app.applicationName,
            path: native?.bundleURL?.path ?? native?.executableURL?.path ?? "", pid: app.processID,
            ownBundleID: Bundle.main.bundleIdentifier ?? "", ownPID: ProcessInfo.processInfo.processIdentifier)
    }

    private func refreshCapture() {
        guard wanted, !refreshing else { return }
        refreshing = true
        let ticket = generation
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            DispatchQueue.main.async {
                guard ticket == self.generation, self.wanted else { return }
                guard let content = content, error == nil else {
                    self.fail(error?.localizedDescription ?? "No screen capture content")
                    return
                }
                guard let display = content.displays.first(where: { $0.displayID == (self.selectedDisplay ?? CGMainDisplayID()) })
                    ?? (self.selectedDisplay == nil ? content.displays.first(where: { !SharedVirtualDisplay.isOutput($0.displayID) }) : nil),
                    !SharedVirtualDisplay.isOutput(display.displayID) else {
                    self.fail(self.tr("所选屏幕已断开。", "The selected display disconnected."))
                    return
                }
                // Capture dimensions and source geometry are fixed for this session.
                let sourceMode = CGDisplayCopyDisplayMode(display.displayID)
                let pixels = CGSize(width: sourceMode?.pixelWidth ?? display.width, height: sourceMode?.pixelHeight ?? display.height)
                let bounds = CGDisplayBounds(display.displayID)
                if let old = self.sourcePixels, old != pixels || self.sourceBounds != bounds {
                    self.fail(self.tr("来源屏幕已变化，请重新开始共享。", "The source display changed. Start sharing again."))
                    return
                }
                self.sourcePixels = pixels
                self.sourceBounds = bounds
                self.selectedDisplay = display.displayID
                self.displays = content.displays.filter { !SharedVirtualDisplay.isOutput($0.displayID) }.map { CaptureDisplay(id: $0.displayID, width: $0.width, height: $0.height) }
                if self.virtualDisplay == nil {
                    if self.outputPreparation == nil {
                        self.outputPreparation = VirtualOutputPreparation(width: Int(pixels.width), height: Int(pixels.height))
                    }
                    switch self.outputPreparation!.poll() {
                    case .waiting:
                        self.refreshing = false
                        return
                    case .failed:
                        self.fail(self.tr("此系统没有可用的虚拟显示器模式。", "No working virtual display mode is available on this system."))
                        return
                    case .ready:
                        self.virtualDisplay = self.outputPreparation?.display
                        self.outputPreparation = nil
                    }
                }
                guard self.showOutput(), let virtual = self.virtualDisplay else { self.refreshing = false; return }
                let apps = content.applications.filter(self.allowed)
                let identities = apps.map { "\($0.processID):\($0.bundleIdentifier)" }.sorted()
                // Include the approved application set instead of excluding a snapshot of PIDs.
                // A newly launched meeting/helper process is therefore never admitted by default.
                // Empty exceptingWindows is essential: no excluded window is re-included.
                let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
                if self.usingScreenshots {
                    if identities != self.identities {
                        self.screenshots.update(filter: filter)
                        self.identities = identities
                        self.surface?.clear()
                    }
                    self.refreshing = false
                    return
                }
                if let stream = self.stream {
                    guard identities != self.identities else { self.refreshing = false; return }
                    stream.updateContentFilter(filter) { error in
                        DispatchQueue.main.async {
                            guard ticket == self.generation, self.wanted else { return }
                            if let error = error { self.fail(error.localizedDescription); return }
                            self.identities = identities
                            self.refreshing = false
                        }
                    }
                    return
                }
                let config = SCStreamConfiguration()
                config.width = virtual.width
                config.height = virtual.height
                config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
                config.queueDepth = 3
                config.pixelFormat = kCVPixelFormatType_32BGRA
                config.showsCursor = true
                // Keep the default background (the opaque output surface paints black).
                // backgroundColor is an
                // assign CGColorRef, not a retaining property: an ephemeral NSColor.cgColor
                // can be freed before startCapture serializes it (CGColorGetAlpha crash).
                // Audio defaults to off; add only a screen output (works on macOS 12.3).
                if #available(macOS 14.0, *) {
                    self.usingScreenshots = true
                    self.lastFrame = Date()
                    self.identities = identities
                    self.screenshots.start(filter: filter, configuration: config, frame: { [weak self] buffer in
                        guard let self, self.wanted, ticket == self.generation else { return }
                        self.present(buffer)
                    }, failure: { [weak self] message in
                        guard let self, self.wanted, ticket == self.generation else { return }
                        self.fail(message)
                    })
                    self.refreshing = false
                    return
                }
                let stream = SCStream(filter: filter, configuration: config, delegate: self)
                do {
                    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
                    self.stream = stream
                    self.lastFrame = Date()
                    self.identities = identities
                    stream.startCapture { error in
                        DispatchQueue.main.async {
                            guard ticket == self.generation, self.wanted else {
                                stream.stopCapture { _ in }
                                return
                            }
                            if let error = error { self.fail(error.localizedDescription); return }
                            self.refreshing = false
                        }
                    }
                } catch { self.fail(error.localizedDescription) }
            }
        }
    }

    private func validateOutput() -> Bool {
        guard let virtual = virtualDisplay, CGDisplayIsOnline(virtual.id) != 0,
              CGDisplayMirrorsDisplay(virtual.id) == kCGNullDirectDisplay,
              let screen = virtual.screen,
              let source = selectedDisplay, CGDisplayIsOnline(source) != 0,
              CGDisplayMirrorsDisplay(source) == kCGNullDirectDisplay,
              CGDisplayBounds(source) == sourceBounds else {
            output?.orderOut(nil)
            fail(tr("显示器配置已变化，共享已停止。", "Display configuration changed. Sharing stopped."))
            return false
        }
        let mode = CGDisplayCopyDisplayMode(virtual.id)
        guard mode?.pixelWidth == virtual.width, mode?.pixelHeight == virtual.height else {
            fail(tr("虚拟显示器分辨率已变化，请重新开始共享。", "Virtual display resolution changed. Start sharing again."))
            return false
        }
        output?.fillScreen(screen)
        return true
    }

    @discardableResult private func showOutput() -> Bool {
        guard let virtual = virtualDisplay else { return false }
        if output != nil { return validateOutput() }
        guard virtual.screen != nil, virtual.place(), let screen = virtual.screen else { return false }
        guard validateOutput() else { return false }
        let window = SharedOutputWindow(screen: screen)
        window.delegate = self
        let surface = ShareSurface(frame: NSRect(origin: .zero, size: screen.frame.size))
        surface.autoresizingMask = [.width, .height]
        window.contentView = surface
        self.surface = surface
        output = window
        window.orderFrontRegardless() // Do not activate or move focus from the user's app.
        return true
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard wanted, self.stream === stream, type == .screen, buffer.isValid else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int else { return }
        let frameStatus = SCFrameStatus(rawValue: raw)
        if frameStatus == .idle { return } // Static desktop retains the last valid frame.
        guard frameStatus == .complete else {
            surface?.clear()
            receiving = false
            phase = "starting"
            return
        }
        present(buffer)
    }

    private func present(_ buffer: CMSampleBuffer) {
        #if CAPTURE_PROBE
        captureProbeFrames += 1
        if captureProbeFrames % 30 == 1, let image = CMSampleBufferGetImageBuffer(buffer) {
            var green = 0; var magenta = 0
            CVPixelBufferLockBaseAddress(image, .readOnly)
            let bytes = CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to: UInt8.self)
            let row = CVPixelBufferGetBytesPerRow(image)
            for y in stride(from: 0, to: CVPixelBufferGetHeight(image), by: 12) {
                for x in stride(from: 0, to: CVPixelBufferGetWidth(image), by: 12) {
                    let p = y * row + x * 4
                    if bytes[p+1] > 150 && bytes[p] < 100 && bytes[p+2] < 100 { green += 1 }
                    if bytes[p+1] < 20 && bytes[p] > 230 && bytes[p+2] > 230 { magenta += 1 }
                }
            }
            CVPixelBufferUnlockBaseAddress(image, .readOnly)
            captureProbeFrameStats = ["frames": captureProbeFrames, "green": green, "magenta": magenta,
                "width": CVPixelBufferGetWidth(image), "height": CVPixelBufferGetHeight(image),
                "videoStatus": surface?.video.status.rawValue ?? -1,
                "ready": surface?.video.isReadyForMoreMediaData ?? false,
                "videoError": surface?.video.error?.localizedDescription ?? ""]
        }
        #endif
        lastFrame = Date()
        surface?.display(buffer)
        if !receiving {
            receiving = true
            phase = "sharing"
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async {
            guard self.stream === stream else { return }
            self.fail(error.localizedDescription)
        }
    }

    private func fail(_ message: String) {
        stop()
        error = message
        phase = "error"
    }

    func stop() {
        generation &+= 1 // Invalidate enumeration/start/filter callbacks still in flight.
        wanted = false
        refreshing = false
        receiving = false
        screenshots.stop()
        usingScreenshots = false
        timer?.invalidate()
        timer = nil
        for observer in observers {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
        surface?.clear()
        let window = output
        output = nil
        surface = nil
        window?.delegate = nil
        window?.orderOut(nil)
        window?.close()
        virtualDisplay = nil // Removes the display after its content has been cleared.
        outputPreparation = nil
        sourceBounds = nil
        sourcePixels = nil
        let previous = stream
        stream = nil // Queued samples and delegate callbacks can no longer reach the surface.
        previous?.stopCapture { _ in }
        phase = "stopped"
        error = nil
    }

    func windowWillClose(_ notification: Notification) {
        stop()
        if (notification.object as? NSWindow) === output {
            surface = nil
            output = nil
        }
    }
}

private struct CaptureDisplay: Codable {
    let id: UInt32
    let width: Int
    let height: Int
}

private struct CaptureState: Codable {
    let supported: Bool
    let permission: Bool
    let phase: String
    let running: Bool
    let displays: [CaptureDisplay]
    let selectedDisplay: UInt32?
    let error: String?
    var outputDisplay: UInt32? = nil
    var outputWidth: Int? = nil
    var outputHeight: Int? = nil
    var virtualDisplaySupported: Bool = false
}

// Called only on the AppKit main thread. The JSON contains status and display geometry,
// never pixels or window titles. Its strdup allocation is freed by the matching C entry.
@_cdecl("sharecode_screen_share_command")
public func screenShareCommand(_ action: Int32, _ display: UInt32, _ chinese: Int32) -> UnsafeMutablePointer<CChar>? {
    let state: CaptureState
    if #available(macOS 12.3, *) {
        let controller = ScreenShare.shared
        controller.perform(action, display: display, chinese: chinese != 0)
        state = controller.snapshot()
    } else {
        state = CaptureState(supported: false, permission: false, phase: "unsupported",
            running: false, displays: [], selectedDisplay: nil, error: nil)
    }
    guard let data = try? JSONEncoder().encode(state), let json = String(data: data, encoding: .utf8) else { return nil }
    return strdup(json)
}

@_cdecl("sharecode_screen_share_free")
public func screenShareFree(_ pointer: UnsafeMutablePointer<CChar>?) { free(pointer) }

@_cdecl("sharecode_screen_share_stop")
public func screenShareStop() {
    if #available(macOS 12.3, *) { ScreenShare.shared.stop() }
}
