import AppKit

@_silgen_name("sharecode_virtual_display_available") private func virtualDisplayAvailable() -> Int32
@_silgen_name("sharecode_virtual_display_is_output") private func isVirtualOutput(_ id: UInt32) -> Int32
@_silgen_name("sharecode_virtual_display_create") private func createVirtualDisplay(_ width: UInt32, _ height: UInt32, _ id: UnsafeMutablePointer<UInt32>) -> UnsafeMutableRawPointer?
@_silgen_name("sharecode_virtual_display_destroy") private func destroyVirtualDisplay(_ handle: UnsafeMutableRawPointer)

// Main-thread ownership. Releasing the CGVirtualDisplay removes the display; it
// also disappears when the process exits, without a persistent system setting.
final class SharedVirtualDisplay {
    static var available: Bool { virtualDisplayAvailable() != 0 }
    static func isOutput(_ id: CGDirectDisplayID) -> Bool { isVirtualOutput(id) != 0 }
    private let handle: UnsafeMutableRawPointer
    let id: CGDirectDisplayID
    let width: Int
    let height: Int
    private var placed = false

    init?(width: Int, height: Int) {
        var id: UInt32 = 0
        guard let handle = createVirtualDisplay(UInt32(width), UInt32(height), &id) else { return nil }
        self.handle = handle
        self.id = id
        self.width = width
        self.height = height
    }

    deinit { destroyVirtualDisplay(handle) }

    var screen: NSScreen? {
        NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }
    }

    var matchesRequestedMode: Bool {
        guard let mode = CGDisplayCopyDisplayMode(id) else { return false }
        return CGDisplayIsOnline(id) != 0 && mode.pixelWidth == width && mode.pixelHeight == height
    }

    // WindowServer can select a different scaled mode from the requested HiDPI
    // mode. Query the actual supported modes rather than assuming a 2x backing scale.
    func selectRequestedMode() -> Bool {
        if matchesRequestedMode { return true }
        guard let modes = CGDisplayCopyAllDisplayModes(id, nil) as? [CGDisplayMode],
              let mode = modes.first(where: { $0.pixelWidth == width && $0.pixelHeight == height }) else { return false }
        return CGDisplaySetDisplayMode(id, mode, nil) == .success && matchesRequestedMode
    }

    // Move only our output, to the right of the existing desktop. Never make it
    // primary, mirror a physical screen, or persist a display arrangement.
    func place() -> Bool {
        if placed { return true }
        guard screen != nil, CGDisplayIsOnline(id) != 0 else { return false }
        var ids = [CGDirectDisplayID](repeating: 0, count: 64)
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(UInt32(ids.count), &ids, &count) == .success else { return false }
        let right = ids.prefix(Int(count)).filter { $0 != id }.map { CGDisplayBounds($0).maxX }.max() ?? 0
        var configuration: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&configuration) == .success, let configuration = configuration else { return false }
        guard CGConfigureDisplayMirrorOfDisplay(configuration, id, kCGNullDirectDisplay) == .success,
              CGConfigureDisplayOrigin(configuration, id, Int32(right), 0) == .success else {
            CGCancelDisplayConfiguration(configuration)
            return false
        }
        placed = CGCompleteDisplayConfiguration(configuration, .forAppOnly) == .success
        return placed
    }
}

// The production controller and native integration test share this negotiation.
// A successful private-API return alone is not evidence of an online display.
final class VirtualOutputPreparation {
    enum State { case waiting, ready, failed }
    private let candidates: [(Int, Int)]
    private var next = 0
    private var createdAt = Date()
    private(set) var display: SharedVirtualDisplay?

    init(width: Int, height: Int) {
        candidates = CapturePolicy.outputCandidates(width: width, height: height)
    }

    func poll() -> State {
        if let display = display {
            if display.screen != nil && display.selectRequestedMode() && display.place() {
                return .ready
            }
            if Date().timeIntervalSince(createdAt) < 5 { return .waiting }
        }
        display = nil
        while next < candidates.count {
            let size = candidates[next]
            next += 1
            if let candidate = SharedVirtualDisplay(width: size.0, height: size.1) {
                display = candidate
                createdAt = Date()
                return .waiting
            }
        }
        return .failed
    }
}
