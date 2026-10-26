import Foundation

// Pure policy, also compiled by the native regression test. Do not match window titles:
// a document mentioning a meeting is not a meeting application.
enum CapturePolicy {
    static func excludes(bundleID: String, name: String, path: String, pid: Int32,
                         ownBundleID: String, ownPID: Int32) -> Bool {
        let id = bundleID.lowercased()
        let roots = ["com.tencent.meeting", "com.tencent.voov", "com.tencent.voovmeeting",
                     "com.tencent.wemeet", "com.tencent.tencentmeeting", "dev.sharecode.client"]
        if pid == ownPID || (!ownBundleID.isEmpty &&
            (id == ownBundleID.lowercased() || id.hasPrefix(ownBundleID.lowercased() + "."))) {
            return true
        }
        if roots.contains(where: { id == $0 || id.hasPrefix($0 + ".") }) { return true }
        let normalize: (String) -> String = {
            $0.lowercased().filter { !$0.isWhitespace && $0 != "-" && $0 != "_" }
        }
        let names = ["tencentmeeting", "voovmeeting", "wemeet", "腾讯会议"]
        if names.contains(normalize(name)) { return true }
        // Helpers nested in a meeting's app bundle must be excluded as well.
        return URL(fileURLWithPath: path).pathComponents.contains { component in
            let part = normalize(component)
            return names.contains { part == $0 + ".app" }
        }
    }

    // Device-independent ladder: retain source aspect, never upscale, and avoid
    // retrying identical modes on small screens. No machine-model allow-list.
    static func outputCandidates(width: Int, height: Int) -> [(Int, Int)] {
        var result: [(Int, Int)] = []
        for (maxWidth, maxHeight) in [(3840, 2160), (2560, 1440), (1920, 1080), (1280, 720)] {
            let scale = min(1, min(Double(maxWidth) / Double(max(1, width)), Double(maxHeight) / Double(max(1, height))))
            let size = (max(2, Int(Double(width) * scale) / 2 * 2), max(2, Int(Double(height) * scale) / 2 * 2))
            if !result.contains(where: { $0 == size }) { result.append(size) }
        }
        return result
    }

    static func dimensions(width: Int, height: Int) -> (Int, Int) {
        let scale = min(1, min(3840.0 / Double(max(1, width)), 2160.0 / Double(max(1, height))))
        return (max(2, Int(Double(width) * scale) / 2 * 2),
                max(2, Int(Double(height) * scale) / 2 * 2))
    }
}
