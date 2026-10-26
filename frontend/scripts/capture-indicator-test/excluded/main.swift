import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 360, y: 340, width: 400, height: 240), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
window.title = "Synthetic Excluded Meeting Helper"
window.isReleasedWhenClosed = false
window.backgroundColor = NSColor(calibratedRed: 0.984, green: 0.004, blue: 0.976, alpha: 1)
let label = NSTextField(labelWithString: "Synthetic excluded app\nNo capture or network")
label.frame = NSRect(x: 20, y: 100, width: 360, height: 80)
label.maximumNumberOfLines = 3
label.font = .systemFont(ofSize: 22)
window.contentView!.addSubview(label)
window.makeKeyAndOrderFront(nil)
app.run()
