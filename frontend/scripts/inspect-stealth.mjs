// Win32 inspection for the customer client's camouflage: reads the extended style bits and the
// display affinity straight from the window, so the switches are verified against the OS instead
// of against our own state. Run: node scripts/inspect-stealth.mjs [pid]
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pid = Number(process.argv[2] ?? 0)
const dir = mkdtempSync(join(tmpdir(), 'stealth-inspect-'))

const source = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Inspect {
  const int GWL_EXSTYLE = -20;
  const int GW_OWNER = 4;
  const uint GA_ROOT = 2;

  const uint WS_EX_TOPMOST = 0x00000008;
  const uint WS_EX_TRANSPARENT = 0x00000020;
  const uint WS_EX_TOOLWINDOW = 0x00000080;
  const uint WS_EX_LAYERED = 0x00080000;
  const uint WS_EX_NOACTIVATE = 0x08000000;
  const uint WS_EX_APPWINDOW = 0x00040000;

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  delegate bool EnumProc(IntPtr hWnd, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint affinity);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  public static void Main(string[] args) {
    uint target = uint.Parse(args[0]);
    var rows = new List<string>();
    var fg = GetForegroundWindow();

    EnumWindows((h, p) => {
      uint ownerPid; GetWindowThreadProcessId(h, out ownerPid);
      if (target != 0 && ownerPid != target) return true;

      var cls = new StringBuilder(256); GetClassNameW(h, cls, 256);
      var title = new StringBuilder(256); GetWindowTextW(h, title, 256);
      long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
      uint affinity; bool affinityOk = GetWindowDisplayAffinity(h, out affinity);
      IntPtr owner = GetWindow(h, GW_OWNER);

      var flags = new List<string>();
      if ((ex & WS_EX_TOPMOST) != 0) flags.Add("TOPMOST");
      if ((ex & WS_EX_TRANSPARENT) != 0) flags.Add("TRANSPARENT");
      if ((ex & WS_EX_TOOLWINDOW) != 0) flags.Add("TOOLWINDOW");
      if ((ex & WS_EX_LAYERED) != 0) flags.Add("LAYERED");
      if ((ex & WS_EX_NOACTIVATE) != 0) flags.Add("NOACTIVATE");
      if ((ex & WS_EX_APPWINDOW) != 0) flags.Add("APPWINDOW");

      rows.Add(string.Join("\t", new [] {
        "0x" + h.ToInt64().ToString("X"),
        ownerPid.ToString(),
        cls.ToString(),
        title.ToString().Replace("\t", " "),
        "ex=0x" + ((uint)ex).ToString("X8"),
        "[" + string.Join(",", flags) + "]",
        "owner=" + (owner == IntPtr.Zero ? "none" : "0x" + owner.ToInt64().ToString("X")),
        "visible=" + IsWindowVisible(h),
        "foreground=" + (h == fg),
        "affinity=" + (affinityOk ? affinity.ToString() : "err"),
      }));
      return true;
    }, IntPtr.Zero);

    foreach (var row in rows) Console.WriteLine(row);
  }
}
`;

const cs = join(dir, 'Inspect.cs')
const exe = join(dir, 'Inspect.exe')
writeFileSync(cs, source)

// csc ships with the .NET Framework in %WINDIR%\Microsoft.NET\Framework64; use it directly so the
// check has no dependency on the project's toolchain.
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
execFileSync(csc, ['/nologo', '/out:' + exe, cs], { stdio: 'inherit' })
const out = execFileSync(exe, [String(pid)], { encoding: 'utf8' })
console.log(out)
