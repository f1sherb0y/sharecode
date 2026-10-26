import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 180, y: 280, width: 520, height: 310), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = "ShareCode Filter Source"
window.isReleasedWhenClosed = false
window.level = .floating
window.backgroundColor = NSColor(calibratedRed: 0.05, green: 0.8, blue: 0.15, alpha: 1)
let label = NSTextField(labelWithString: "Synthetic source — no private data")
label.frame = NSRect(x: 20, y: 210, width: 480, height: 70)
label.font = .systemFont(ofSize: 20)
label.maximumNumberOfLines = 3
window.contentView!.addSubview(label)
window.orderFrontRegardless()
var frame = 0
let timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
    frame += 1
    label.stringValue = "Synthetic source — no private data\nFrame \(frame)"
}
RunLoop.main.add(timer, forMode: .common)
app.run()
