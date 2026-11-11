import AppKit
import ObjectiveC

// AppKit side of the MyGo host's main window: the three switches, the focus
// hand-off, its frame and the drag of the app bundle. Main thread only. No tray,
// alternate UI or extra shortcuts; nothing here activates the app unasked.
enum ClientWindow {
    struct State: Equatable {
        var clickThrough: Bool
        var screenCaptureProtection: Bool
        var hideFromTaskbar: Bool

        var json: [String: Any] {
            ["clickThrough": clickThrough, "screenCaptureProtection": screenCaptureProtection,
             "hideFromTaskbar": hideFromTaskbar]
        }
    }

    private static weak var prepared: NSWindow?
    // Read by the panel's canBecomeKeyWindow. Mouse pass-through alone would
    // leave keyboard focus in a window nothing can click.
    private static var focusable = true
    private static var previousApp: NSRunningApplication?
    private static var activationObserver: NSObjectProtocol?
    private static var lastFailure = ""

    private static func fail(_ reason: String) -> Bool {
        lastFailure = reason
        return false
    }

    static var failure: String { lastFailure }

    // MyGo creates the main window as its own nonactivating NSPanel
    // (WindowOptions.Panel), so no class is swapped and WebKit's observers are
    // untouched. Only that class's answer to canBecomeKeyWindow is replaced, and
    // only for this window. Refuse anything else rather than guess.
    static func prepare(_ window: NSWindow) -> Bool {
        precondition(Thread.isMainThread)
        lastFailure = ""
        if prepared === window { return true }
        guard prepared == nil else { return fail("another_window_is_prepared") }
        guard window is NSPanel, window.styleMask.contains(.nonactivatingPanel) else {
            return fail("window_is_not_a_nonactivating_panel")
        }
        guard !window.isVisible else { return fail("preparation_requires_hidden_window") }
        // The method is replaced on MyGo's class itself, never on the object's
        // runtime class, which may be the subclass an observer installed.
        guard let cls = NSClassFromString("MyGoPanel"), window.isKind(of: cls) else {
            return fail("unsupported_native_window_class_" + NSStringFromClass(type(of: window)))
        }
        let selector = NSSelectorFromString("canBecomeKeyWindow")
        guard let method = class_getInstanceMethod(cls, selector) else {
            return fail("panel_has_no_key_window_method")
        }
        let original = method_getImplementation(method)
        typealias Original = @convention(c) (AnyObject, Selector) -> Bool
        let block: @convention(block) (AnyObject) -> Bool = { object in
            if object === ClientWindow.prepared { return ClientWindow.focusable }
            return unsafeBitCast(original, to: Original.self)(object, selector)
        }
        class_replaceMethod(cls, selector, imp_implementationWithBlock(block), method_getTypeEncoding(method))
        prepared = window
        focusable = true

        let panel = Unmanaged<NSPanel>.fromOpaque(Unmanaged.passUnretained(window).toOpaque()).takeUnretainedValue()
        panel.isFloatingPanel = false // Explicit pin/unpin controls the level.
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        // Unpinned it is an ordinary window of one Space. WindowPinning saves this
        // state and restores it; MyGo's panels otherwise join every Space.
        window.level = .normal
        window.collectionBehavior = [.fullScreenNone]
        // Only the page's drag regions move the window: sliders, text selection
        // and drawing must not.
        window.isMovableByWindowBackground = false
        window.isMovable = true

        rememberFrontmost()
        if activationObserver == nil {
            activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
            ) { _ in ClientWindow.rememberFrontmost() }
        }
        return true
    }

    private static func rememberFrontmost() {
        if let app = NSWorkspace.shared.frontmostApplication,
           app != NSRunningApplication.current, !app.isTerminated {
            previousApp = app
        }
    }

    /// The OS properties, not a preference cache. sharingType is the requested
    /// protection flag only: ScreenCaptureKit on modern macOS can ignore it.
    static func actual(_ window: NSWindow) -> State {
        State(clickThrough: window.ignoresMouseEvents && !window.canBecomeKey,
              screenCaptureProtection: window.sharingType == .none,
              hideFromTaskbar: NSApp.activationPolicy() == .accessory)
    }

    private static func apply(_ window: NSWindow, _ next: State) -> String? {
        focusable = !next.clickThrough
        window.ignoresMouseEvents = next.clickThrough
        window.sharingType = next.screenCaptureProtection ? .none : .readOnly
        let policy: NSApplication.ActivationPolicy = next.hideFromTaskbar ? .accessory : .regular
        // setActivationPolicy also reports failure when the policy already
        // matches, so only call it on a real change; the readback verifies it.
        if NSApp.activationPolicy() != policy && !NSApp.setActivationPolicy(policy) {
            return "macOS did not change Dock visibility"
        }
        return nil
    }

    private static func handOffFocus(_ window: NSWindow) {
        window.resignKey()
        window.resignMain()
        // If the switch was used while another app already had input, leave it alone.
        guard NSApp.isActive, let previous = previousApp, !previous.isTerminated else { return }
        if #available(macOS 14.0, *) {
            NSApp.yieldActivation(to: previous)
            previous.activate()
        } else {
            previous.activate(options: [.activateIgnoringOtherApps])
        }
    }

    /// With preserveFocus (the native shortcut) the user's keyboard destination
    /// is left alone: no activate, resign, makeKey or orderFront. Changing
    /// focusability only prevents future activation.
    static func set(_ window: NSWindow, _ next: State, preserveFocus: Bool) -> (State, String?) {
        precondition(Thread.isMainThread)
        guard prepared === window else { return (actual(window), "The client window is not prepared") }
        let previous = actual(window)
        let focusBefore = (window.isKeyWindow, window.isMainWindow, NSApp.isActive)
        rememberFrontmost()
        var error = apply(window, next)
        if error == nil && actual(window) != next {
            error = "macOS did not apply the requested window settings"
        }
        if error == nil && preserveFocus && focusBefore != (window.isKeyWindow, window.isMainWindow, NSApp.isActive) {
            error = "macOS unexpectedly changed window focus while applying click-through"
        }
        if let error = error {
            _ = apply(window, previous)
            return (actual(window), error)
        }
        if !preserveFocus {
            if next.clickThrough {
                handOffFocus(window)
            } else if previous.clickThrough {
                window.makeKeyAndOrderFront(nil)
            }
        }
        return (actual(window), nil)
    }

    static func geometry(_ window: NSWindow) -> [String: Any] {
        let frame = window.frame
        var result: [String: Any] = [
            "visible": window.isVisible, "minimized": window.isMiniaturized,
            "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height,
        ]
        let areas = NSScreen.screens.map(\.visibleFrame)
        if let first = areas.first {
            let all = areas.dropFirst().reduce(first) { $0.union($1) }
            result["areaX"] = all.minX
            result["areaY"] = all.minY
            result["areaWidth"] = all.width
            result["areaHeight"] = all.height
        }
        return result
    }

    private final class DragSource: NSObject, NSDraggingSource {
        static let shared = DragSource()
        func draggingSession(_ session: NSDraggingSession,
                             sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    }

    /// A copy-only file drag of the running app bundle from the pointer, for the
    /// permission lists of System Settings. A drop is not a grant.
    static func dragApplication(_ window: NSWindow, path: String) -> String? {
        precondition(Thread.isMainThread)
        guard let content = window.contentView else { return "The setup window has no content" }
        let position = window.mouseLocationOutsideOfEventStream
        let image = NSWorkspace.shared.icon(forFile: path)
        image.size = NSSize(width: 64, height: 64)
        let item = NSDraggingItem(pasteboardWriter: NSURL(fileURLWithPath: path, isDirectory: true))
        item.setDraggingFrame(NSRect(x: position.x - 32, y: position.y - 32, width: 64, height: 64), contents: image)
        guard let event = NSEvent.mouseEvent(
            with: .leftMouseDragged, location: position, modifierFlags: [],
            timestamp: NSApp.currentEvent?.timestamp ?? ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1
        ) else { return "Could not start dragging the application" }
        content.beginDraggingSession(with: [item], event: event, source: DragSource.shared)
        return nil
    }
}

private func window(_ pointer: UnsafeMutableRawPointer) -> NSWindow {
    Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue()
}

// Every string returned to Go is a strdup allocation freed by sharecode_client_free.
private func json(_ value: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { return nil }
    return strdup(text)
}

@_cdecl("sharecode_client_free")
public func clientFree(_ pointer: UnsafeMutablePointer<CChar>?) { free(pointer) }

@_cdecl("sharecode_client_prepare")
public func clientPrepare(_ pointer: UnsafeMutableRawPointer) -> UnsafeMutablePointer<CChar>? {
    guard Thread.isMainThread else { return strdup("not_on_the_main_thread") }
    return ClientWindow.prepare(window(pointer)) ? nil : strdup(ClientWindow.failure)
}

@_cdecl("sharecode_client_stealth_actual")
public func clientStealthActual(_ pointer: UnsafeMutableRawPointer) -> UnsafeMutablePointer<CChar>? {
    guard Thread.isMainThread else { return nil }
    return json(["state": ClientWindow.actual(window(pointer)).json])
}

@_cdecl("sharecode_client_stealth_set")
public func clientStealthSet(_ pointer: UnsafeMutableRawPointer, _ clickThrough: Bool, _ protection: Bool,
                             _ hideFromTaskbar: Bool, _ preserveFocus: Bool) -> UnsafeMutablePointer<CChar>? {
    guard Thread.isMainThread else { return nil }
    let (state, error) = ClientWindow.set(
        window(pointer),
        ClientWindow.State(clickThrough: clickThrough, screenCaptureProtection: protection,
                           hideFromTaskbar: hideFromTaskbar),
        preserveFocus: preserveFocus)
    var result: [String: Any] = ["state": state.json]
    if let error = error { result["error"] = error }
    return json(result)
}

@_cdecl("sharecode_client_geometry")
public func clientGeometry(_ pointer: UnsafeMutableRawPointer) -> UnsafeMutablePointer<CChar>? {
    guard Thread.isMainThread else { return nil }
    return json(ClientWindow.geometry(window(pointer)))
}

// Moving a window neither activates its app nor makes it key.
@_cdecl("sharecode_client_set_origin")
public func clientSetOrigin(_ pointer: UnsafeMutableRawPointer, _ x: Double, _ y: Double) {
    guard Thread.isMainThread else { return }
    window(pointer).setFrameOrigin(NSPoint(x: x, y: y))
}

@_cdecl("sharecode_client_drag_application")
public func clientDragApplication(_ pointer: UnsafeMutableRawPointer,
                                  _ path: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    guard Thread.isMainThread else { return strdup("not_on_the_main_thread") }
    return ClientWindow.dragApplication(window(pointer), path: String(cString: path)).map { strdup($0) }
}

// A heap copy of WindowPinning's diagnostics, so the caller needs no buffer size.
@_cdecl("sharecode_client_diagnostics")
public func clientDiagnostics(_ pointer: UnsafeMutableRawPointer) -> UnsafeMutablePointer<CChar>? {
    guard Thread.isMainThread else { return nil }
    return strdup(WindowPinning.diagnostics(window(pointer)))
}

// WindowPinning's own C entries are internal to the module, which a static
// library exposes and a dynamic one does not.
@_cdecl("sharecode_client_set_pinned")
public func clientSetPinned(_ pointer: UnsafeMutableRawPointer, _ pinned: Bool) -> Bool {
    guard Thread.isMainThread else { return false }
    return WindowPinning.set(window(pointer), pinned: pinned)
}

@_cdecl("sharecode_client_is_pinned")
public func clientIsPinned(_ pointer: UnsafeMutableRawPointer) -> Bool {
    guard Thread.isMainThread else { return false }
    return WindowPinning.isPinned(window(pointer))
}

// orderFrontRegardless neither activates the app nor takes keyboard focus.
@_cdecl("sharecode_client_toggle_visibility")
public func clientToggleVisibility(_ pointer: UnsafeMutableRawPointer) -> Bool {
    guard Thread.isMainThread else { return false }
    let target = window(pointer)
    if target.isVisible { target.orderOut(nil) } else { target.orderFrontRegardless() }
    return target.isVisible
}
