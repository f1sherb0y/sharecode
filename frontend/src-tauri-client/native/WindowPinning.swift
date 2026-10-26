import AppKit
import ObjectiveC

// Only the customer's main window uses this controller. In particular the shared
// output and permission helper must not follow it into other applications' Spaces.
final class WindowPinning {
    private static var lastFailure = ""
    private static func fail(_ reason: String) -> Bool {
        lastFailure = reason
        return false
    }
    static func diagnostics(_ window: NSWindow) -> String {
        let cls: AnyClass = object_getClass(window)!
        var count: UInt32 = 0
        let list = class_copyIvarList(cls, &count)
        defer { free(list) }
        let ivars = (0..<Int(count)).map { index -> [String: Any] in
            let ivar = list![index]
            return ["name": String(cString: ivar_getName(ivar)!),
                    "type": String(cString: ivar_getTypeEncoding(ivar)!), "offset": ivar_getOffset(ivar)]
        }
        let state: [String: Any] = [
            "failure": lastFailure,
            "class": NSStringFromClass(cls),
            "superclass": class_getSuperclass(cls).map { NSStringFromClass($0) } ?? "",
            "instanceSize": class_getInstanceSize(cls), "ivars": ivars,
            "windowSize": class_getInstanceSize(NSWindow.self), "panelSize": class_getInstanceSize(NSPanel.self),
            "isPanel": window is NSPanel, "style": window.styleMask.rawValue,
            "behavior": window.collectionBehavior.rawValue, "level": window.level.rawValue,
            "key": window.isKeyWindow, "main": window.isMainWindow,
            "minimized": window.isMiniaturized, "appActive": NSApp.isActive,
            "visible": window.isVisible, "pinned": isPinned(window),
            "canBecomeKey": window.canBecomeKey, "canBecomeMain": window.canBecomeMain,
            "ignoresMouse": window.ignoresMouseEvents,
        ]
        let data = try! JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
        return String(data: data, encoding: .utf8)!
    }
    // Tauri owns the native window, its delegate and its WebView. Preserve that
    // object and Tao's focusable ivar / event overrides when making it a panel.
    // Refuse unknown layouts rather than casting arbitrary NSWindow subclasses.
    static func installPanel(_ window: NSWindow) -> Bool {
        precondition(Thread.isMainThread)
        lastFailure = ""
        if window is NSPanel {
            return window.styleMask.contains(.nonactivatingPanel) || fail("panel_missing_nonactivating_style")
        }
        guard !window.isVisible else { return fail("installation_requires_hidden_window") }
        guard let original = object_getClass(window),
              class_getSuperclass(original) == NSWindow.self,
              class_getInstanceSize(NSPanel.self) == class_getInstanceSize(NSWindow.self),
              let focusable = class_getInstanceVariable(original, "focusable"),
              let encoding = ivar_getTypeEncoding(focusable),
              ["c", "B"].contains(String(cString: encoding)) else { return fail("unsupported_native_layout_or_already_observed") }
        var ivarCount: UInt32 = 0
        let ivars = class_copyIvarList(original, &ivarCount)
        defer { free(ivars) }
        guard ivarCount == 1 else { return fail("unexpected_native_ivars") }
        let name = "ShareCodeFullscreenPanel_" + String(cString: class_getName(original))
        let panelClass: AnyClass
        if let existing = NSClassFromString(name) {
            panelClass = existing
        } else {
            guard let created = objc_allocateClassPair(NSPanel.self, name, 0) else { return fail("panel_class_allocation_failed") }
            guard class_addIvar(created, "focusable", 1, 0, encoding),
                  let copied = class_getInstanceVariable(created, "focusable"),
                  ivar_getOffset(copied) == ivar_getOffset(focusable),
                  class_getInstanceSize(created) == class_getInstanceSize(original) else {
                objc_disposeClassPair(created)
                return fail("panel_layout_mismatch")
            }
            var count: UInt32 = 0
            if let methods = class_copyMethodList(original, &count) {
                defer { free(methods) }
                for index in 0..<Int(count) {
                    let method = methods[index]
                    class_addMethod(created, method_getName(method), method_getImplementation(method), method_getTypeEncoding(method))
                }
            }
            objc_registerClassPair(created)
            panelClass = created
        }
        object_setClass(window, panelClass)
        // Swift's optimizer can reuse the failed `is NSPanel` check above across
        // object_setClass. Reborrow with the new, layout-verified runtime type.
        let panel = Unmanaged<NSPanel>.fromOpaque(Unmanaged.passUnretained(window).toOpaque()).takeUnretainedValue()
        panel.isFloatingPanel = false // Explicit pin/unpin controls the level.
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        // Install once before the hidden main window is first shown. Toggling
        // nonactivatingPanel on a live window has problematic AppKit focus semantics.
        panel.styleMask.insert(.nonactivatingPanel)
        return true
    }
    private final class Saved: NSObject {
        let behavior: NSWindow.CollectionBehavior
        let level: NSWindow.Level
        init(_ window: NSWindow) { behavior = window.collectionBehavior; level = window.level }
    }
    private static let saved = NSMapTable<NSWindow, Saved>(keyOptions: .weakMemory, valueOptions: .strongMemory)

    static func behavior(_ original: NSWindow.CollectionBehavior) -> NSWindow.CollectionBehavior {
        var result = original
        result.subtract([.moveToActiveSpace, .fullScreenPrimary, .fullScreenNone, .fullScreenAllowsTiling])
        result.formUnion([.canJoinAllSpaces, .fullScreenAuxiliary, .fullScreenDisallowsTiling])
        if #available(macOS 13.0, *) {
            result.subtract([.primary, .auxiliary])
            result.insert(.canJoinAllApplications)
        }
        return result
    }

    static func isPinned(_ window: NSWindow) -> Bool {
        let required = behavior([])
        return window is NSPanel && window.styleMask.contains(.nonactivatingPanel)
            && window.level == .floating && window.collectionBehavior.isSuperset(of: required)
    }

    @discardableResult
    static func set(_ window: NSWindow, pinned: Bool) -> Bool {
        precondition(Thread.isMainThread)
        lastFailure = ""
        guard !pinned || (window is NSPanel && window.styleMask.contains(.nonactivatingPanel)) else {
            return fail("window_not_prepared_as_nonactivating_panel")
        }
        let previousBehavior = window.collectionBehavior
        let previousLevel = window.level
        let focus = (window.isKeyWindow, window.isMainWindow, window.isMiniaturized, NSApp.isActive)
        let hadSavedState = saved.object(forKey: window) != nil
        if pinned {
            if saved.object(forKey: window) == nil { saved.setObject(Saved(window), forKey: window) }
            window.collectionBehavior = behavior(previousBehavior)
            window.level = .floating
        } else if let prior = saved.object(forKey: window) {
            window.level = prior.level
            window.collectionBehavior = prior.behavior
        } else {
            // An unpinned window has no controller-owned state to restore.
            return !isPinned(window)
        }
        let unchanged = focus == (window.isKeyWindow, window.isMainWindow, window.isMiniaturized, NSApp.isActive)
        let applied = pinned ? isPinned(window) : !isPinned(window)
        guard unchanged && applied else {
            let failure = "pin_readback_failed unchanged=\(unchanged) applied=\(applied) beforeFocus=\(focus) observed=\(diagnostics(window))"
            window.level = previousLevel
            window.collectionBehavior = previousBehavior
            if !hadSavedState { saved.removeObject(forKey: window) }
            return fail(failure)
        }
        if !pinned { saved.removeObject(forKey: window) }
        return true
    }
}

@_cdecl("sharecode_window_diagnostics")
func sharecodeWindowDiagnostics(_ pointer: UnsafeMutableRawPointer, _ buffer: UnsafeMutablePointer<CChar>, _ capacity: Int) {
    guard Thread.isMainThread, capacity > 0 else { return }
    let value = WindowPinning.diagnostics(Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue())
    value.withCString { source in
        strncpy(buffer, source, capacity - 1)
        buffer[capacity - 1] = 0
    }
}

@_cdecl("sharecode_window_install_panel")
func sharecodeWindowInstallPanel(_ pointer: UnsafeMutableRawPointer) -> Bool {
    guard Thread.isMainThread else { return false }
    return WindowPinning.installPanel(Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue())
}

@_cdecl("sharecode_window_set_pinned")
func sharecodeWindowSetPinned(_ pointer: UnsafeMutableRawPointer, _ pinned: Bool) -> Bool {
    guard Thread.isMainThread else { return false }
    return WindowPinning.set(Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue(), pinned: pinned)
}

@_cdecl("sharecode_window_is_pinned")
func sharecodeWindowIsPinned(_ pointer: UnsafeMutableRawPointer) -> Bool {
    guard Thread.isMainThread else { return false }
    return WindowPinning.isPinned(Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue())
}
