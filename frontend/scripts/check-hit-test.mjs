// Checks click-through without injecting any input. Windows' own hit test (WindowFromPoint) skips
// WS_EX_TRANSPARENT windows, so every point inside the client's rectangle must resolve either to a
// window that sits *below* the client in the Z order, or to nothing at all. Anything else means the
// client still takes input. The check reads window styles, rectangles and Z order only: it never
// touches the cursor or the keyboard.
//   node scripts/check-hit-test.mjs <pid>
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pid = process.argv[2]
if (!pid) {
  console.error('usage: node scripts/check-hit-test.mjs <pid>')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'hit-test-'))

const source = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class HitTest {
  const int GWL_EXSTYLE = -20;
  const uint WS_EX_TRANSPARENT = 0x00000020;
  const uint WS_EX_NOACTIVATE = 0x08000000;
  const uint GA_ROOT = 2;

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  delegate bool EnumProc(IntPtr h, IntPtr p);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  static readonly List<IntPtr> topToBottom = new List<IntPtr>();

  static string ClassOf(IntPtr h) { var sb = new StringBuilder(128); GetClassNameW(h, sb, 128); return sb.ToString(); }
  static string TitleOf(IntPtr h) { var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); return sb.ToString(); }
  static string Hex(IntPtr h) { return "0x" + h.ToInt64().ToString("X"); }
  static uint PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }

  // Position in the shell's Z order: 0 is the front-most window.
  static int ZIndex(IntPtr h) {
    int index = topToBottom.IndexOf(h);
    return index < 0 ? int.MaxValue : index;
  }

  static IntPtr FindClient(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (PidOf(h) != pid || !IsWindowVisible(h)) return true;
      if (ClassOf(h) != "Tauri Window" || TitleOf(h).Length == 0) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static int Main(string[] args) {
    SetProcessDPIAware();
    uint pid = uint.Parse(args[0]);
    IntPtr client = FindClient(pid);
    if (client == IntPtr.Zero) { Console.WriteLine("no visible client window in that process"); return 2; }

    EnumWindows((h, p) => { topToBottom.Add(h); return true; }, IntPtr.Zero);

    RECT rect; GetWindowRect(client, out rect);
    long style = GetWindowLongPtr(client, GWL_EXSTYLE).ToInt64();
    bool transparent = ((uint)style & WS_EX_TRANSPARENT) != 0;
    bool noActivate = ((uint)style & WS_EX_NOACTIVATE) != 0;
    int clientZ = ZIndex(client);

    Console.WriteLine("client " + Hex(client) + " ex=0x" + ((uint)style).ToString("X8") +
      " transparent=" + transparent + " noactivate=" + noActivate + " z=" + clientZ);
    Console.WriteLine("rect " + rect.Left + "," + rect.Top + " " +
      (rect.Right - rect.Left) + "x" + (rect.Bottom - rect.Top));

    int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
    int self = 0, above = 0, hits = 0;
    for (int row = 1; row <= 3; row++) {
      for (int column = 1; column <= 3; column++) {
        var point = new POINT { X = rect.Left + width * column / 4, Y = rect.Top + height * row / 4 };
        IntPtr under = WindowFromPoint(point);
        bool isSelf = under != IntPtr.Zero && GetAncestor(under, GA_ROOT) == GetAncestor(client, GA_ROOT);
        int underZ = under == IntPtr.Zero ? int.MaxValue : ZIndex(under);
        bool isAbove = !isSelf && underZ < clientZ;
        hits++;
        if (isSelf) self++;
        if (isAbove) above++;
        Console.WriteLine("point " + point.X + "," + point.Y + " -> " +
          (under == IntPtr.Zero ? "desktop" : Hex(under) + " pid=" + PidOf(under) + " " + ClassOf(under) +
            " z=" + (underZ == int.MaxValue ? "below-visible-range" : underZ.ToString())) +
          " self=" + isSelf + (isAbove ? " ABOVE-CLIENT" : ""));
      }
    }

    Console.WriteLine("points at the client: " + self + "/" + hits +
      ", points covered by another window that is above the client: " + above + "/" + hits);
    if (!transparent) {
      Console.WriteLine("click-through is off: the grid only records where the client sits");
      return 0;
    }
    if (self > 0) {
      Console.WriteLine("RESULT: the client still takes hits at " + self + " of " + hits + " points");
      return 1;
    }
    // A window above the client is simply another app on top; it does not weaken the result.
    Console.WriteLine("RESULT: no point reaches the client, its input falls through" +
      (above > 0 ? " (some points are covered by a window above it)" : ""));
    return 0;
  }
}
`

const cs = join(dir, 'HitTest.cs')
const exe = join(dir, 'HitTest.exe')
writeFileSync(cs, source)
execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/out:' + exe, cs], { stdio: 'inherit' })
try {
  process.stdout.write(execFileSync(exe, [pid], { encoding: 'utf8' }))
} catch (error) {
  process.stdout.write(String(error.stdout ?? ''))
  console.log('exit=' + error.status + ' (1 means input can still reach the client)')
}
