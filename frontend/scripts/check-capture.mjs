// Verifies that the client's capture exclusion is in force, without injecting input and without
// changing the window: it reads the display affinity the compositor uses and, for the record, what
// an ordinary BitBlt screen capture contains at the client's centre. `SetWindowDisplayAffinity`
// may only be changed by the process that owns the window, so the value is read, never written.
//   node scripts/check-capture.mjs <pid>
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pid = process.argv[2]
if (!pid) {
  console.error('usage: node scripts/check-capture.mjs <pid>')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'capture-check-'))

const source = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CaptureCheck {
  const uint WDA_NONE = 0;
  const uint WDA_EXCLUDEFROMCAPTURE = 17;
  const uint SRCCOPY = 0x00CC0020;
  const uint CAPTUREBLT = 0x40000000;

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  delegate bool EnumProc(IntPtr h, IntPtr p);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint affinity);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);

  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h,
    IntPtr src, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);

  static string ClassOf(IntPtr h) { var sb = new StringBuilder(128); GetClassNameW(h, sb, 128); return sb.ToString(); }
  static string TitleOf(IntPtr h) { var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); return sb.ToString(); }

  static IntPtr FindClient(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      if (ClassOf(h) != "Tauri Window" || TitleOf(h).Length == 0) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  // One pixel of an ordinary screen capture (BitBlt from the screen DC, as a recorder or a
  // screenshot tool does it).
  static uint ScreenPixel(int x, int y) {
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr memory = CreateCompatibleDC(screen);
    IntPtr bitmap = CreateCompatibleBitmap(screen, 1, 1);
    IntPtr previous = SelectObject(memory, bitmap);
    try {
      if (!BitBlt(memory, 0, 0, 1, 1, screen, x, y, SRCCOPY | CAPTUREBLT))
        throw new InvalidOperationException("BitBlt failed: " + Marshal.GetLastWin32Error());
      return GetPixel(memory, 0, 0);
    } finally {
      SelectObject(memory, previous);
      DeleteObject(bitmap);
      DeleteDC(memory);
      ReleaseDC(IntPtr.Zero, screen);
    }
  }

  public static int Main(string[] args) {
    SetProcessDPIAware();
    IntPtr client = FindClient(uint.Parse(args[0]));
    if (client == IntPtr.Zero) { Console.WriteLine("no visible client window in that process"); return 2; }

    RECT rect; GetWindowRect(client, out rect);
    int x = (rect.Left + rect.Right) / 2, y = (rect.Top + rect.Bottom) / 2;

    uint affinity; bool ok = GetWindowDisplayAffinity(client, out affinity);
    Console.WriteLine("client 0x" + client.ToInt64().ToString("X") + " centre=" + x + "," + y);
    Console.WriteLine("affinity read=" + (ok ? affinity.ToString() : "error"));
    Console.WriteLine("capture pixel at the centre=0x" + ScreenPixel(x, y).ToString("X8"));

    if (!ok) { Console.WriteLine("RESULT: the display affinity could not be read"); return 2; }
    if (affinity != WDA_EXCLUDEFROMCAPTURE) {
      Console.WriteLine("RESULT: capture exclusion is off (affinity " + affinity + ", expected " + WDA_EXCLUDEFROMCAPTURE + ")");
      return 1;
    }
    Console.WriteLine("RESULT: capture exclusion is on (WDA_EXCLUDEFROMCAPTURE = 17)");
    return 0;
  }
}
`

const cs = join(dir, 'CaptureCheck.cs')
const exe = join(dir, 'CaptureCheck.exe')
writeFileSync(cs, source)
execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/out:' + exe, cs], { stdio: 'inherit' })
try {
  process.stdout.write(execFileSync(exe, [pid], { encoding: 'utf8' }))
} catch (error) {
  process.stdout.write(String(error.stdout ?? ''))
  console.log('exit=' + error.status + ' (1 means capture exclusion is off)')
}
