import Foundation

// Pure policy, also compiled by the native regression test. Do not match window titles:
// a document mentioning a meeting is not a meeting application.
enum CapturePolicy {
    private static let meetingBundleRoots = [
        "com.tencent.meeting", "com.tencent.voov", "com.tencent.voovmeeting",
        "com.tencent.wemeet", "com.tencent.tencentmeeting"
    ]

    private static func isMeetingBundle(_ bundleID: String) -> Bool {
        let id = bundleID.lowercased()
        return meetingBundleRoots.contains { id == $0 || id.hasPrefix($0 + ".") }
    }

    static func excludes(bundleID: String, name: String, path: String, pid: Int32,
                         ownBundleID: String, ownPID: Int32,
                         bundleIDAtPath: (String) -> String? = { _ in nil }) -> Bool {
        let id = bundleID.lowercased()
        if pid == ownPID || (!ownBundleID.isEmpty &&
            (id == ownBundleID.lowercased() || id.hasPrefix(ownBundleID.lowercased() + "."))) {
            return true
        }
        if isMeetingBundle(id) || id == "dev.sharecode.client" ||
            id.hasPrefix("dev.sharecode.client.") { return true }
        let normalize: (String) -> String = {
            $0.lowercased().filter { !$0.isWhitespace && $0 != "-" && $0 != "_" }
        }
        let names = ["tencentmeeting", "voovmeeting", "wemeet", "腾讯会议"]
        if names.contains(normalize(name)) { return true }
        // Real packages contain helpers outside the meeting ID namespaces, e.g.
        // com.tencent.UpdateService and com.tencent.VooVUpdateService. Identify
        // their enclosing app too, including renamed copies. Never exclude all
        // Tencent helpers or generic names like UpdateService/Transcode globally.
        guard !path.isEmpty, path.hasPrefix("/") else { return false }
        var url = URL(fileURLWithPath: path).standardizedFileURL
        while url.path != "/" {
            if url.pathExtension.lowercased() == "app" {
                let part = normalize(url.lastPathComponent)
                if names.contains(where: { part == $0 + ".app" }) { return true }
                if let enclosingID = bundleIDAtPath(url.path), isMeetingBundle(enclosingID) {
                    return true
                }
            }
            url.deleteLastPathComponent()
        }
        return false
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
