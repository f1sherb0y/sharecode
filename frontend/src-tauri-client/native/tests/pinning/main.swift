import AppKit
import ObjectiveC
let root = URL(fileURLWithPath: "/tmp/sharecode-fullscreen-pin-test")
try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let host = Bundle.main.bundleIdentifier!.hasSuffix(".host")
// Reproduce Tao 0.34's extra Boolean and focus overrides so the real conversion
// must preserve their storage and behavior, not just work on a plain NSPanel.
func probeClass() -> NSWindow.Type {
    let cls: AnyClass = objc_allocateClassPair(NSWindow.self, "ShareCodePinProbeWindow", 0)!
    precondition(class_addIvar(cls, "focusable", 1, 0, "c"))
    let focusable: @convention(block) (NSWindow) -> Bool = { window in
        window.value(forKey: "focusable") as? Bool ?? false
    }
    let method = imp_implementationWithBlock(focusable)
    class_addMethod(cls, #selector(getter: NSWindow.canBecomeKey), method, "c@:")
    class_addMethod(cls, #selector(getter: NSWindow.canBecomeMain), method, "c@:")
    objc_registerClassPair(cls)
    return cls as! NSWindow.Type
}
let window = (host ? NSWindow.self : probeClass()).init(
    contentRect: NSRect(x: host ? 100 : 350, y: 240, width: host ? 900 : 440, height: host ? 600 : 230),
    styleMask: host ? [.titled, .closable, .miniaturizable, .resizable] : [.borderless, .resizable],
    backing: .buffered, defer: false)
if !host {
    window.setValue(true, forKey: "focusable")
    precondition(WindowPinning.installPanel(window), "Tao-compatible panel conversion failed")
    precondition(window.canBecomeKey && window.canBecomeMain)
    window.setValue(false, forKey: "focusable")
    precondition(!window.canBecomeKey && !window.canBecomeMain, "Lost Tao focusable behavior")
    window.setValue(true, forKey: "focusable")
}
window.title = host ? "Full-screen Test Host" : "ShareCode Pinned Overlay Test"
window.isReleasedWhenClosed = false
window.backgroundColor = host ? NSColor(calibratedRed: 0.06, green: 0.12, blue: 0.25, alpha: 1) : .systemOrange
window.collectionBehavior = host ? [.fullScreenPrimary] : [.fullScreenNone]
let label = NSTextField(labelWithString: host ? "Native macOS full-screen host" : "Pinned overlay — above full-screen host")
label.frame = NSRect(x: 20, y: 100, width: host ? 850 : 400, height: 60)
label.textColor = host ? .white : .black
label.font = .systemFont(ofSize: 22)
label.maximumNumberOfLines = 2
window.contentView!.addSubview(label)
let input = NSTextField(frame: NSRect(x: 20, y: 30, width: 350, height: 32))
input.placeholderString = "Keyboard focus test"
window.contentView!.addSubview(input)
let original = window.collectionBehavior
let originalLevel = window.level
var command = ""
var result = true
if !host { result = WindowPinning.set(window, pinned: true) }
window.orderFrontRegardless()
if host && CommandLine.arguments.contains("--auto-fullscreen") {
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { window.toggleFullScreen(nil) }
}
let timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
    if !host, let next = try? String(contentsOf: root.appendingPathComponent("command"), encoding: .utf8), next != command {
        command = next
        switch next {
        case "pin": result = WindowPinning.set(window, pinned: true)
        case "unpin": result = WindowPinning.set(window, pinned: false)
        case "accessory": app.setActivationPolicy(.accessory)
        case "regular": app.setActivationPolicy(.regular)
        case "through": window.setValue(false, forKey: "focusable"); window.ignoresMouseEvents = true
        case "interactive": window.setValue(true, forKey: "focusable"); window.ignoresMouseEvents = false
        case "minimize": window.miniaturize(nil)
        case "restore": window.deminiaturize(nil)
        case "quit": app.terminate(nil)
        default: break
        }
    }
    let state: [String: Any] = ["title": window.title, "windowID": window.windowNumber,
        "activeSpace": window.isOnActiveSpace, "visible": window.isVisible,
        "occluded": !window.occlusionState.contains(.visible), "key": window.isKeyWindow,
        "main": window.isMainWindow, "appActive": app.isActive, "miniaturized": window.isMiniaturized,
        "nativeFullScreen": window.styleMask.contains(.fullScreen), "level": window.level.rawValue,
        "style": window.styleMask.rawValue, "canBecomeKey": window.canBecomeKey,
        "canBecomeMain": window.canBecomeMain, "ignoresMouse": window.ignoresMouseEvents,
        "behavior": window.collectionBehavior.rawValue, "pinned": !host && WindowPinning.isPinned(window),
        "setSucceeded": result, "restored": window.collectionBehavior == original && window.level == originalLevel,
        "policy": app.activationPolicy().rawValue, "frontmost": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "",
        "input": input.stringValue, "timestamp": Date().timeIntervalSince1970]
    let data = try! JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
    try! data.write(to: root.appendingPathComponent(host ? "host.json" : "overlay.json"), options: .atomic)
}
RunLoop.main.add(timer, forMode: .common)
app.run()
