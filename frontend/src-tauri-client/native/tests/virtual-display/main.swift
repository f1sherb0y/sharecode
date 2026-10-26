import AppKit

// No input-monitoring permission, no capture, no production identity. Creates a
// real temporary display and the production output window, then removes both.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.finishLaunching()
func waitUntil(_ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(8)
    while !condition(), Date() < deadline {
        if let event = app.nextEvent(matching: .any, until: Date().addingTimeInterval(0.05), inMode: .default, dequeue: true) { app.sendEvent(event) }
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    return condition()
}
func online() -> [CGDirectDisplayID] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 64)
    var count: UInt32 = 0
    precondition(CGGetOnlineDisplayList(64, &ids, &count) == .success)
    return Array(ids.prefix(Int(count)))
}
let original = online()
let bounds = original.map { CGDisplayBounds($0) }
let main = CGMainDisplayID()
let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
precondition(SharedVirtualDisplay.available, "CGVirtualDisplay API is unavailable")
for (pass, size) in [(1, (3840, 2160)), (2, (3024, 1964)), (3, (2560, 1440))] {
    autoreleasepool {
        var preparation: VirtualOutputPreparation? = VirtualOutputPreparation(width: size.0, height: size.1)
        var state = preparation!.poll()
        let deadline = Date().addingTimeInterval(25)
        while state == .waiting && Date() < deadline {
            if let event = app.nextEvent(matching: .any, until: Date().addingTimeInterval(0.1), inMode: .default, dequeue: true) { app.sendEvent(event) }
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            state = preparation!.poll()
        }
        precondition(state == .ready, "No working display mode")
        var virtual = preparation!.display
        preparation = nil
        let id = virtual!.id
        let expected = (virtual!.width, virtual!.height)
        precondition(virtual!.place(), "Display arrangement failed")
        precondition(waitUntil { CGDisplayCopyDisplayMode(id)?.pixelWidth == expected.0 }, "Incorrect output mode")
        precondition(SharedVirtualDisplay.isOutput(id), "Output identity is not recognized")
        precondition(!original.contains(id), "Output reused a physical display")
        precondition(CGMainDisplayID() == main, "Primary screen changed")
        precondition(original.map { CGDisplayBounds($0) } == bounds, "Physical screen arrangement changed")
        precondition(CGDisplayMirrorsDisplay(id) == kCGNullDirectDisplay, "Output must be extended")
        let window = SharedOutputWindow(screen: virtual!.screen!)
        window.backgroundColor = .systemBlue
        window.orderFrontRegardless()
        precondition(waitUntil { window.isVisible && window.screen == virtual?.screen }, "Output is on the wrong screen")
        precondition(window.frame == virtual!.screen!.frame, "Output does not fill display")
        let backing = window.contentView!.convertToBacking(window.contentView!.bounds).size
        precondition(Int(backing.width) == expected.0 && Int(backing.height) == expected.1, "Output backing pixels do not match capture dimensions")
        precondition(!window.isKeyWindow && !window.isMainWindow, "Output stole focus")
        precondition(NSWorkspace.shared.frontmostApplication?.processIdentifier == foreground, "Foreground app changed")
        precondition(window.styleMask == .borderless && window.level == .screenSaver)
        window.orderOut(nil)
        window.close()
        virtual = nil
        precondition(waitUntil { !online().contains(id) }, "Virtual display leaked after release")
        precondition(Set(online()) == Set(original), "Display list not restored")
        print("Pass \(pass): created \(id), extended \(expected.0)x\(expected.1), full-screen output, no focus/layout change, removed")
    }
}

autoreleasepool {
    var preparation: VirtualOutputPreparation? = VirtualOutputPreparation(width: 1920, height: 1080)
    _ = preparation!.poll()
    let id = preparation!.display?.id
    preparation = nil // Equivalent to Stop while startup is still waiting for NSScreen.
    precondition(waitUntil { id == nil || !online().contains(id!) }, "Cancelled startup leaked a display")
    precondition(Set(online()) == Set(original))
    print("Cancelled startup: temporary display released")
}
