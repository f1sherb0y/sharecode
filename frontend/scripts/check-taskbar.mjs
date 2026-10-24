// Verifies the client is not a taskbar / Alt+Tab window by applying the shell's own rule:
// a window gets a taskbar button and an Alt+Tab entry when it is visible, top-level, unowned and
// does not carry WS_EX_TOOLWINDOW. Counts toolbar buttons too (TB_BUTTONCOUNT), which is what the
// taskbar actually shows. Run: node scripts/check-taskbar.mjs ShareCode
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const needle = process.argv[2] ?? 'ShareCode'
const dir = mkdtempSync(join(tmpdir(), 'taskbar-check-'))

const source = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class TaskbarCheck {
  const int GWL_EXSTYLE = -20;
  const uint GW_OWNER = 4;
  const uint WS_EX_TOOLWINDOW = 0x00000080;
  const uint WS_EX_APPWINDOW = 0x00040000;
  const uint WS_EX_NOACTIVATE = 0x08000000;
  const uint TB_BUTTONCOUNT = 0x0418;

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr FindWindowW(string cls, string win);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string win);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumProc cb, IntPtr p);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
  static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")]
  static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")]
  static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);

  static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  static string TextOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }

  // The shell's rule for a taskbar button / Alt+Tab entry.
  static bool IsTaskbarEligible(IntPtr h) {
    if (!IsWindowVisible(h)) return false;
    if (GetWindow(h, GW_OWNER) != IntPtr.Zero) return false;
    long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
    if ((ex & WS_EX_TOOLWINDOW) != 0 && (ex & WS_EX_APPWINDOW) == 0) return false;
    return true;
  }

  public static int Main(string[] args) {
    string needle = args.Length > 0 ? args[0] : "ShareCode";
    int eligibleHits = 0, matches = 0;

    EnumWindows((h, p) => {
      var title = TextOf(h);
      var cls = ClassOf(h);
      // Only the client's own window: other windows can mention the product name in their title
      // (an editor showing the repository, a terminal in the build directory).
      if (cls == "Tauri Window") {
        matches++;
        long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
        bool eligible = IsTaskbarEligible(h);
        if (eligible) eligibleHits++;
        Console.WriteLine(string.Format(
          "window 0x{0} cls={1} title=\"{2}\" visible={3} owner={4} toolwindow={5} appwindow={6} noactivate={7} -> taskbar/AltTab eligible={8}",
          h.ToInt64().ToString("X"), cls, title, IsWindowVisible(h),
          GetWindow(h, GW_OWNER) == IntPtr.Zero ? "none" : "yes",
          (ex & WS_EX_TOOLWINDOW) != 0, (ex & WS_EX_APPWINDOW) != 0, (ex & WS_EX_NOACTIVATE) != 0,
          eligible));
      }
      return true;
    }, IntPtr.Zero);

    // What the primary taskbar actually shows.
    var bar = FindWindowW("Shell_TrayWnd", null);
    var rebar = FindWindowExW(bar, IntPtr.Zero, "ReBarWindow32", null);
    var tasks = FindWindowExW(rebar, IntPtr.Zero, "MSTaskSwWClass", null);
    var list = FindWindowExW(tasks, IntPtr.Zero, "MSTaskListWClass", null);
    long buttons = list == IntPtr.Zero ? -1 : SendMessageW(list, TB_BUTTONCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt64();
    Console.WriteLine("primary taskbar toolbar buttons=" + buttons);

    if (matches == 0) { Console.WriteLine("no matching window found"); return 2; }
    Console.WriteLine(eligibleHits == 0
      ? "RESULT: hidden from the taskbar and from Alt+Tab"
      : "RESULT: still taskbar-eligible");
    return eligibleHits == 0 ? 0 : 1;
  }
}
`

const cs = join(dir, 'TaskbarCheck.cs')
const exe = join(dir, 'TaskbarCheck.exe')
writeFileSync(cs, source)
execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/out:' + exe, cs], { stdio: 'inherit' })
try {
  process.stdout.write(execFileSync(exe, [needle], { encoding: 'utf8' }))
} catch (error) {
  process.stdout.write(String(error.stdout ?? ''))
  console.log('exit=' + error.status + ' (1 means the window is still taskbar-eligible)')
}
