import AppKit
import CoreGraphics

enum PermissionPlacement {
    static let gap: CGFloat = 12

    /// AppKit coordinates throughout, including displays to the left/below the primary one.
    /// Prefer either side of Settings, then above/below, then a free secondary display.
    static func frame(size: CGSize, settings: CGRect, screens: [CGRect]) -> CGRect? {
        let ordered = screens.sorted { overlap($0, settings) > overlap($1, settings) }
        var candidates: [CGRect] = []
        for visible in ordered {
            let area = visible.insetBy(dx: gap, dy: gap)
            guard area.width >= size.width, area.height >= size.height else { continue }
            let x = min(max(settings.minX, area.minX), area.maxX - size.width)
            let y = min(max(settings.maxY - size.height, area.minY), area.maxY - size.height)
            let origins = [
                CGPoint(x: settings.maxX + gap, y: y),
                CGPoint(x: settings.minX - gap - size.width, y: y),
                CGPoint(x: x, y: settings.maxY + gap),
                CGPoint(x: x, y: settings.minY - gap - size.height),
                CGPoint(x: area.maxX - size.width, y: area.maxY - size.height),
                CGPoint(x: area.minX, y: area.maxY - size.height),
                CGPoint(x: area.maxX - size.width, y: area.minY),
                CGPoint(x: area.minX, y: area.minY),
            ]
            for origin in origins {
                let rect = CGRect(origin: origin, size: size)
                guard area.contains(rect) else { continue }
                if !rect.intersects(settings.insetBy(dx: -gap + 1, dy: -gap + 1)) { return rect }
                candidates.append(rect)
            }
        }
        // Full-screen Settings can leave no geometrically disjoint area. Stay on screen
        // with the smallest overlap; never move/resize Settings or request Accessibility.
        return candidates.min { overlap($0, settings) < overlap($1, settings) }
    }

    static func overlap(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let intersection = a.intersection(b)
        return intersection.isNull ? 0 : intersection.width * intersection.height
    }
}

private final class PermissionGuidePositioner {
    static let shared = PermissionGuidePositioner()
    private weak var window: NSWindow?
    private var placementTask: DispatchWorkItem?

    func track(_ window: NSWindow) {
        self.window = window
        placementTask?.cancel()
        // Settings is opened immediately before this call. Give it one chance to finish
        // creating its window, then place the guide exactly once. Do not keep polling or move
        // a guide the user has repositioned manually.
        let task = DispatchWorkItem { [weak self, weak window] in
            guard let self, self.window === window else { return }
            self.placeOnce()
        }
        placementTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: task)
    }

    private func settingsFrame() -> CGRect? {
        let pids = Set(NSWorkspace.shared.runningApplications
            .filter { $0.bundleIdentifier == "com.apple.systempreferences" }
            .map { $0.processIdentifier })
        guard !pids.isEmpty,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let primary = NSScreen.screens.first else { return nil }
        // Bounds/owner PID are enough; no window titles, pixels, or Accessibility permission.
        return windows.compactMap { info -> CGRect? in
            guard let pid = info[kCGWindowOwnerPID as String] as? Int32, pids.contains(pid),
                  (info[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds),
                  frame.width > 200, frame.height > 200 else { return nil }
            return CGRect(x: frame.minX, y: primary.frame.maxY - frame.maxY,
                          width: frame.width, height: frame.height)
        }.max { $0.width * $0.height < $1.width * $1.height }
    }

    private func placeOnce() {
        guard let window = window, window.isVisible else { return }
        guard let settings = settingsFrame() else { return }
        let screens = NSScreen.screens.map(\.visibleFrame)
        let current = window.frame
        guard let next = PermissionPlacement.frame(size: current.size, settings: settings, screens: screens) else { return }
        if abs(next.minX - current.minX) > 1 || abs(next.minY - current.minY) > 1 {
            window.setFrameOrigin(next.origin)
        }
        #if DEBUG
        NSLog("ShareCode permission placement guide=%@ settings=%@ overlap=%.0f",
              NSStringFromRect(window.frame), NSStringFromRect(settings),
              PermissionPlacement.overlap(window.frame, settings))
        #endif
    }
}

@_cdecl("sharecode_permission_guide_track")
public func permissionGuideTrack(_ pointer: UnsafeMutableRawPointer) {
    guard Thread.isMainThread else { return }
    PermissionGuidePositioner.shared.track(Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue())
}
