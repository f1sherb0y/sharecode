import Foundation

func excluded(_ id: String = "", _ name: String = "", _ path: String = "", _ pid: Int32 = 42) -> Bool {
    CapturePolicy.excludes(bundleID: id, name: name, path: path, pid: pid,
        ownBundleID: "dev.sharecode.capture-test", ownPID: 99)
}

for id in ["com.tencent.meeting", "com.tencent.meeting.helper", "com.tencent.voov",
           "com.tencent.VooVMeeting", "com.tencent.wemeet", "dev.sharecode.client",
           "dev.sharecode.client.setup-test", "dev.sharecode.capture-test"] {
    precondition(excluded(id), "Expected exclusion: \(id)")
}
precondition(excluded("", "", "", 99), "An unbundled build must exclude its own PID")
for name in ["腾讯会议", "TencentMeeting", "VooV Meeting", "WeMeet"] {
    precondition(excluded("", name), "Expected name exclusion: \(name)")
}
precondition(excluded("other.helper", "Helper", "/Applications/TencentMeeting.app/Contents/Frameworks/Helper.app"))
precondition(excluded("other.helper", "Helper", "/Applications/VooV Meeting.app/Contents/MacOS/Helper"))
for id in ["com.apple.Safari", "com.tencent.qq", "us.zoom.xos", "com.tencent.meeting-notes"] {
    precondition(!excluded(id), "Unrelated app excluded: \(id)")
}
precondition(!excluded("notes.app", "Tencent Meeting Notes"), "Do not match partial names or document titles")
let landscape = CapturePolicy.dimensions(width: 5120, height: 2880)
precondition(landscape.0 == 3840 && landscape.1 == 2160)
let portrait = CapturePolicy.dimensions(width: 2160, height: 3840)
precondition(portrait.0 == 1214 && portrait.1 == 2160)
let small = CapturePolicy.dimensions(width: 1280, height: 720)
precondition(small.0 == 1280 && small.1 == 720, "Never upscale")
let invalid = CapturePolicy.dimensions(width: 0, height: 0)
precondition(invalid.0 == 2 && invalid.1 == 2)
print("Capture policy passed: identities, own PID, nested helpers, unrelated apps and display sizing")

let guideSize = CGSize(width: 360, height: 382) // content + title bar
let desktop = CGRect(x: 0, y: 0, width: 1440, height: 900)
func placement(_ settings: CGRect, _ screens: [CGRect] = [desktop]) -> CGRect {
    guard let result = PermissionPlacement.frame(size: guideSize, settings: settings, screens: screens) else {
        preconditionFailure("Missing placement")
    }
    precondition(screens.contains { $0.contains(result) }, "Guide must stay inside a visible display")
    return result
}
let centered = CGRect(x: 350, y: 150, width: 700, height: 600)
precondition(placement(centered).minX > centered.maxX, "Prefer free space on the right")
let right = CGRect(x: 800, y: 150, width: 600, height: 600)
precondition(placement(right).maxX < right.minX, "Use the left when Settings is near the right edge")
let low = CGRect(x: 100, y: 50, width: 1240, height: 300)
precondition(placement(low).minY > low.maxY, "Use space above a wide Settings window")
let high = CGRect(x: 100, y: 550, width: 1240, height: 300)
precondition(placement(high).maxY < high.minY, "Use space below")
let secondary = CGRect(x: -1280, y: -200, width: 1280, height: 900)
let onSecondary = CGRect(x: -1000, y: -100, width: 600, height: 600)
precondition(!placement(onSecondary, [desktop, secondary]).intersects(onSecondary), "Handle negative monitor coordinates")
let full = CGRect(x: 0, y: 0, width: 1440, height: 900)
precondition(secondary.contains(placement(full, [desktop, secondary])), "Use a second display when the first has no space")
_ = placement(full) // Impossible disjoint layout still stays on-screen.
print("Permission placement passed: right, left, above, below, multiple displays and constrained fallback")

// Representative built-in M1+ panels, external 4K/5K/6K, ultrawide, portrait and
// small/scaled inputs. Check invariants, not a lookup table for the developer Mac.
for (width, height) in [(2560,1600), (2560,1664), (2880,1864), (3024,1964),
                        (3456,2234), (3840,2160), (5120,2880), (6016,3384),
                        (5120,1440), (2160,3840), (1280,720), (800,600)] {
    let candidates = CapturePolicy.outputCandidates(width: width, height: height)
    precondition(!candidates.isEmpty && candidates.count <= 4)
    var last = (Int.max, Int.max)
    for size in candidates {
        precondition(size.0 > 0 && size.1 > 0 && size.0 % 2 == 0 && size.1 % 2 == 0)
        precondition(size.0 <= min(width, 3840) && size.1 <= min(height, 2160))
        precondition(size != last && size.0 <= last.0 && size.1 <= last.1)
        precondition(abs(Double(size.0) / Double(size.1) - Double(width) / Double(height)) < 0.02)
        last = size
    }
}
print("Adaptive output sizing passed: M1+ panel sizes, external monitors, portrait, ultrawide, no upscaling")
