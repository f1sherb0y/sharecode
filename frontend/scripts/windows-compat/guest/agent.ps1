# Runs on the test VM's desktop (a scheduled task with /it, not elevated) and answers the host's
# questions about what Windows itself reports: window styles, Z order, hit tests, the foreground
# window, the taskbar, screen captures. It owns one test window, the backdrop: black and white
# stripes behind the client, which records the mouse and key events it receives. It never
# generates input; the host does that through Hyper-V's keyboard and mouse.
#
# The client runs as administrator. What that hides from this process (command lines, its token,
# suspending it) is in elevated.ps1, which the host runs over SSH.
#
# Protocol: one JSON line per connection on 127.0.0.1:$Port, answered with one JSON line.
param([int]$Port = 39100, [string]$Out = 'C:\test\out')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$logFile = Join-Path $Out 'agent.log'
function Write-Log([string]$text) { Add-Content -LiteralPath $logFile -Value ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $text) }

try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
    Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SC {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  public delegate bool EnumProc(IntPtr h, IntPtr p);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr h, int id, uint modifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);
  [DllImport("user32.dll", EntryPoint = "EnumDisplaySettingsA")] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", EntryPoint = "ChangeDisplaySettingsA")] static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHELLEXECUTEINFO {
    public int cbSize; public uint fMask; public IntPtr hwnd; public string lpVerb, lpFile, lpParameters, lpDirectory;
    public int nShow; public IntPtr hInstApp, lpIDList; public string lpClass; public IntPtr hkeyClass; public uint dwHotKey; public IntPtr hIcon, hProcess;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern bool ShellExecuteExW(ref SHELLEXECUTEINFO info);

  // Opens a file through the shell with a window of this process as the owner, the way Explorer
  // does on a double click. For a program that needs administrator rights the call lasts until
  // the consent prompt (UAC) is answered, so it runs on a thread of its own.
  public static void ShellOpen(long owner, string file) {
    var thread = new System.Threading.Thread(() => {
      var info = new SHELLEXECUTEINFO();
      info.cbSize = Marshal.SizeOf(typeof(SHELLEXECUTEINFO)); info.hwnd = new IntPtr(owner); info.lpFile = file; info.nShow = 1;
      ShellExecuteExW(ref info);
    });
    thread.SetApartmentState(System.Threading.ApartmentState.STA);
    thread.IsBackground = true;
    thread.Start();
  }

  static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }

  // Top-level windows, front-most first.
  public static List<long> TopLevel() {
    var list = new List<long>();
    EnumWindows((h, p) => { list.Add(h.ToInt64()); return true; }, IntPtr.Zero);
    return list;
  }

  public static Dictionary<string, object> Describe(long handle) {
    var h = new IntPtr(handle);
    var d = new Dictionary<string, object>();
    uint pid; uint thread = GetWindowThreadProcessId(h, out pid);
    RECT r; GetWindowRect(h, out r);
    RECT frame; bool hasFrame = DwmGetWindowAttribute(h, 9, out frame, 16) == 0;
    int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) != 0) cloaked = -1;
    uint affinity; bool affinityOk = GetWindowDisplayAffinity(h, out affinity);
    uint key; byte alpha; uint flags; bool layered = GetLayeredWindowAttributes(h, out key, out alpha, out flags);
    d["hwnd"] = handle; d["pid"] = (long)pid; d["thread"] = (long)thread;
    d["class"] = ClassOf(h); d["title"] = TitleOf(h);
    d["exStyle"] = (long)(uint)GetWindowLongPtr(h, -20).ToInt64();
    d["style"] = (long)(uint)GetWindowLongPtr(h, -16).ToInt64();
    d["visible"] = IsWindowVisible(h); d["iconic"] = IsIconic(h);
    d["rect"] = new int[] { r.Left, r.Top, r.Right, r.Bottom };
    d["frame"] = hasFrame ? new int[] { frame.Left, frame.Top, frame.Right, frame.Bottom } : null;
    d["cloaked"] = cloaked;
    d["affinity"] = affinityOk ? (long)affinity : -1L;
    d["owner"] = GetWindow(h, 4).ToInt64();
    d["layeredAlpha"] = layered ? (int)alpha : -1;
    d["layeredFlags"] = layered ? (long)flags : -1L;
    return d;
  }

  // The top-level window Windows' own hit test resolves a screen point to (0 = nothing).
  public static long RootAt(int x, int y) {
    var h = WindowFromPoint(new POINT { X = x, Y = y });
    return h == IntPtr.Zero ? 0 : GetAncestor(h, 2).ToInt64();
  }

  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static long LayoutOf(long thread) { return GetKeyboardLayout((uint)thread).ToInt64() & 0xFFFFFFFFL; }

  // Counts WM_HOTKEY messages of this thread: a system hotkey of the agent's own, to compare
  // what RegisterHotKey delivers with what the client's keyboard hook sees.
  public class HotkeyCounter : System.Windows.Forms.IMessageFilter {
    public int Count;
    public bool PreFilterMessage(ref System.Windows.Forms.Message m) { if (m.Msg == 0x0312) Count++; return false; }
  }

  public static string SetDisplay(int width, int height) {
    var best = new DEVMODE(); bool found = false;
    for (int i = 0; ; i++) {
      var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
      if (!EnumDisplaySettings(null, i, ref dm)) break;
      if (dm.dmPelsWidth == width && dm.dmPelsHeight == height && dm.dmBitsPerPel == 32) { best = dm; found = true; }
    }
    if (!found) return "no such mode";
    int code = ChangeDisplaySettings(ref best, 0);
    return code == 0 ? "ok" : "ChangeDisplaySettings returned " + code;
  }
}
'@
    [void][SC]::SetProcessDPIAware()
    [Windows.Forms.Application]::EnableVisualStyles()

    $script:events = New-Object System.Collections.ArrayList
    $script:clientHwnd = 0L
    $script:stripe = 32
    $script:hotkeys = New-Object SC+HotkeyCounter
    [Windows.Forms.Application]::AddMessageFilter($script:hotkeys)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    function Add-Event([hashtable]$event) { $event.t = $clock.ElapsedMilliseconds; [void]$script:events.Add($event) }

    # --- the backdrop ---------------------------------------------------------------------------
    $form = New-Object Windows.Forms.Form
    $form.Text = 'SCCompat Backdrop'
    $form.FormBorderStyle = 'None'
    $form.StartPosition = 'Manual'
    $form.ShowInTaskbar = $true
    $form.KeyPreview = $true
    function Set-BackdropBounds {
        $area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $form.Bounds = $area
        $bitmap = New-Object Drawing.Bitmap $area.Width, $area.Height
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([Drawing.Color]::Black)
        for ($x = $script:stripe; $x -lt $area.Width; $x += 2 * $script:stripe) {
            $graphics.FillRectangle([Drawing.Brushes]::White, $x, 0, $script:stripe, $area.Height)
        }
        $graphics.Dispose()
        $old = $form.BackgroundImage
        $form.BackgroundImageLayout = 'None'
        $form.BackgroundImage = $bitmap
        if ($old) { $old.Dispose() }
    }
    $form.Add_MouseDown({ param($s, $e)
            $p = $form.PointToScreen($e.Location)
            Add-Event @{ type = 'mousedown'; x = $p.X; y = $p.Y; button = "$($e.Button)" } })
    $form.Add_KeyDown({ param($s, $e) Add-Event @{ type = 'keydown'; key = "$($e.KeyCode)"; alt = $e.Alt; shift = $e.Shift; control = $e.Control } })
    $form.Add_KeyUp({ param($s, $e) Add-Event @{ type = 'keyup'; key = "$($e.KeyCode)" } })
    $form.Add_KeyPress({ param($s, $e) Add-Event @{ type = 'char'; char = "$($e.KeyChar)" } })
    $form.Add_Activated({ Add-Event @{ type = 'activated' } })
    $form.Add_Deactivate({ Add-Event @{ type = 'deactivated' } })
    $form.Add_InputLanguageChanged({ param($s, $e) Add-Event @{ type = 'inputlanguage'; culture = "$($e.Culture.Name)" } })

    # --- helpers --------------------------------------------------------------------------------
    $flagNames = [ordered]@{ TOPMOST = 0x8; TRANSPARENT = 0x20; TOOLWINDOW = 0x80; APPWINDOW = 0x40000; LAYERED = 0x80000; NOACTIVATE = 0x8000000; NOREDIRECTIONBITMAP = 0x200000 }
    function Get-Window([long]$hwnd, $order) {
        $d = [SC]::Describe($hwnd)
        $d.flags = @($flagNames.Keys | Where-Object { $d.exStyle -band $flagNames[$_] })
        $d.z = if ($order) { $order.IndexOf($hwnd) } else { -1 }
        # The shell's rule for a taskbar button and an Alt+Tab entry.
        $d.taskbarEligible = $d.visible -and $d.owner -eq 0 -and -not (($d.exStyle -band 0x80) -and -not ($d.exStyle -band 0x40000))
        $d
    }
    function Find-Client([string]$process, $order) {
        $pids = @(Get-Process -Name $process -ErrorAction SilentlyContinue | ForEach-Object { [long]$_.Id })
        if (-not $pids) { return $null }
        if ($script:clientHwnd -and [SC]::IsWindow([IntPtr]$script:clientHwnd)) {
            $known = Get-Window $script:clientHwnd $order
            if ($pids -contains $known.pid) { return $known }
        }
        $best = $null
        foreach ($hwnd in $order) {
            $d = [SC]::Describe($hwnd)
            if ($pids -notcontains $d.pid -or $d.title -notmatch 'ShareCode') { continue }
            $area = ($d.rect[2] - $d.rect[0]) * ($d.rect[3] - $d.rect[1])
            if (-not $best -or $area -gt $best.area) { $best = @{ hwnd = $hwnd; area = $area } }
        }
        if (-not $best) { return $null }
        $script:clientHwnd = $best.hwnd
        Get-Window $best.hwnd $order
    }
    function Get-WebView2 {
        $found = @{}
        foreach ($scope in @{ machine = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'; user = 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' }.GetEnumerator()) {
            $version = (Get-ItemProperty $scope.Value -ErrorAction SilentlyContinue).pv
            if ($version -and $version -ne '0.0.0.0') { $found[$scope.Key] = $version }
        }
        $found
    }
    function Get-Who([long]$root, $client) {
        if ($root -eq 0) { 'none' }
        elseif ($client -and $root -eq $client.hwnd) { 'client' }
        elseif ($root -eq $form.Handle.ToInt64()) { 'backdrop' }
        else { 'other:' + ([SC]::Describe($root).class) }
    }

    function Invoke-Request($request) {
        switch ($request.cmd) {
            'ping' {
                $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
                @{ ok = $true; pid = $PID; computer = $env:COMPUTERNAME; session = [Diagnostics.Process]::GetCurrentProcess().SessionId
                    elevated = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
                    ps = "$($PSVersionTable.PSVersion)" }
            }
            'display' {
                $result = if ($request.width) { [SC]::SetDisplay([int]$request.width, [int]$request.height) } else { 'unchanged' }
                Start-Sleep -Milliseconds 800
                [Windows.Forms.Application]::DoEvents()
                $screen = [Windows.Forms.Screen]::PrimaryScreen
                $graphics = $form.CreateGraphics(); $dpi = $graphics.DpiX; $graphics.Dispose()
                @{ result = $result; bounds = @($screen.Bounds.X, $screen.Bounds.Y, $screen.Bounds.Width, $screen.Bounds.Height)
                    work = @($screen.WorkingArea.X, $screen.WorkingArea.Y, $screen.WorkingArea.Width, $screen.WorkingArea.Height)
                    screens = [Windows.Forms.Screen]::AllScreens.Count; dpi = $dpi }
            }
            'backdrop' {
                # Shown without activation, directly below the given window (or at the bottom).
                if ($request.show) {
                    Set-BackdropBounds
                    $after = if ($request.below) { [IntPtr][long]$request.below } else { [IntPtr]1 }
                    # A window placed right behind a topmost one becomes topmost itself; the backdrop must
                    # stay an ordinary window, so below a pinned client it goes to the top of the others.
                    if ($request.below -and ([SC]::Describe([long]$request.below).exStyle -band 0x8)) { $after = [IntPtr](-2) }
                    [void][SC]::SetWindowPos($form.Handle, [IntPtr](-2), 0, 0, 0, 0, 0x0013)   # HWND_NOTOPMOST; NOSIZE|NOMOVE|NOACTIVATE
                    [void][SC]::SetWindowPos($form.Handle, $after, 0, 0, 0, 0, 0x0053)   # NOSIZE|NOMOVE|NOACTIVATE|SHOWWINDOW
                    $form.Refresh()
                } else { $form.Hide() }
                $bounds = $form.Bounds
                @{ hwnd = $form.Handle.ToInt64(); visible = $form.Visible; bounds = @($bounds.X, $bounds.Y, $bounds.Width, $bounds.Height); stripe = $script:stripe }
            }
            'install' {
                # The installer as a customer runs it: on the desktop, as the signed-in user, not
                # elevated; it asks for administrator rights itself (UAC). It is not waited for
                # here; 'installStatus' reports how it ended.
                $before = Get-WebView2
                $path = [Environment]::ExpandEnvironmentVariables($request.path).Replace('/', [IO.Path]::DirectorySeparatorChar)
                $script:installer = Start-Process -FilePath $path -ArgumentList @($request.arguments) -PassThru
                $script:installStarted = Get-Date
                @{ pid = $script:installer.Id; webview2 = $before }
            }
            'installStatus' {
                $done = $script:installer.HasExited
                @{ done = $done; exitCode = if ($done) { $script:installer.ExitCode } else { $null }
                    seconds = [math]::Round(((Get-Date) - $script:installStarted).TotalSeconds, 1)
                    installed = (Test-Path -LiteralPath ([Environment]::ExpandEnvironmentVariables($request.exe)))
                    webview2 = (Get-WebView2)
                    # The consent prompt (UAC) waits for an answer; the host gives it.
                    consent = [bool](Get-Process -Name consent -ErrorAction SilentlyContinue) }
            }
            'launch' {
                $script:clientHwnd = 0L
                $path = [Environment]::ExpandEnvironmentVariables($request.path).Replace('/', '\')
                if ($request.shell) {
                    # As the app in front starts a program (Explorer on a double click): through the
                    # shell, which asks for consent (UAC) when the program needs administrator
                    # rights. The host clicks the backdrop first, so this process is the one in
                    # front: asked for from the background, Windows leaves the prompt minimized
                    # on the taskbar.
                    [SC]::ShellOpen($form.Handle.ToInt64(), $path)
                    @{ pid = 0 }
                } else {
                    $process = Start-Process -FilePath $path -PassThru
                    @{ pid = $process.Id }
                }
            }
            'consent' {
                # Whether a consent prompt (UAC) is up, on the secure desktop.
                @{ consent = [bool](Get-Process -Name consent -ErrorAction SilentlyContinue) }
            }
            'state' {
                $order = [SC]::TopLevel()
                $client = Find-Client $request.process $order
                $foregroundHwnd = [SC]::GetForegroundWindow().ToInt64()
                $foreground = if ($foregroundHwnd) { Get-Window $foregroundHwnd $order } else { $null }
                $hits = @()
                if ($client) {
                    $r = $client.rect
                    foreach ($row in 1..3) {
                        foreach ($column in 1..3) {
                            $x = $r[0] + [int](($r[2] - $r[0]) * $column / 4); $y = $r[1] + [int](($r[3] - $r[1]) * $row / 4)
                            $hits += @{ x = $x; y = $y; who = (Get-Who ([SC]::RootAt($x, $y)) $client) }
                        }
                    }
                }
                $events = @($script:events.ToArray())
                if ($request.drain) { $script:events.Clear() }
                $processes = @(Get-Process -Name $request.process -ErrorAction SilentlyContinue)
                @{
                    client          = $client
                    foreground      = $foreground
                    foregroundWho   = (Get-Who $foregroundHwnd $client)
                    backdrop        = (Get-Window $form.Handle.ToInt64() $order)
                    hits            = $hits
                    cursor          = [SC]::Cursor()
                    layout          = if ($foreground) { '{0:X8}' -f [SC]::LayoutOf($foreground.thread) } else { $null }
                    inputLanguage   = [Windows.Forms.InputLanguage]::CurrentInputLanguage.Culture.Name
                    events          = $events
                    processCount    = $processes.Count
                    processIds      = @($processes | ForEach-Object { $_.Id })
                    hotkeys         = $script:hotkeys.Count
                }
            }
            'point' { @{ who = (Get-Who ([SC]::RootAt([int]$request.x, [int]$request.y)) (Find-Client $request.process ([SC]::TopLevel()))) } }
            'capture' {
                # What a screen-capture API sees (BitBlt from the screen), as a PNG.
                $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
                $bitmap = New-Object Drawing.Bitmap $bounds.Width, $bounds.Height
                $graphics = [Drawing.Graphics]::FromImage($bitmap)
                $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
                $graphics.Dispose()
                $stream = New-Object IO.MemoryStream
                $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose()
                @{ png = [Convert]::ToBase64String($stream.ToArray()) }
            }
            'taskbar' {
                # The names of everything the taskbar exposes to assistive technology.
                $names = New-Object System.Collections.ArrayList
                $tray = [SC]::FindWindowW('Shell_TrayWnd', $null)
                if ($tray -ne [IntPtr]::Zero) {
                    $element = [Windows.Automation.AutomationElement]::FromHandle($tray)
                    foreach ($item in $element.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
                        try {
                            $name = $item.Current.Name
                            if ($name) { [void]$names.Add(@{ name = $name; class = $item.Current.ClassName; type = $item.Current.ControlType.ProgrammaticName }) }
                        } catch {}
                    }
                }
                @{ found = ($tray -ne [IntPtr]::Zero); items = @($names.ToArray()) }
            }
            'processes' {
                $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
                $roots = @($all | Where-Object { $_.Name -eq "$($request.process).exe" })
                $ids = @($roots | ForEach-Object { $_.ProcessId })
                $children = @($all | Where-Object { $ids -contains $_.ParentProcessId })
                @{ roots = @($roots | ForEach-Object { $_.ProcessId }); children = @($children | ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name } }) }
            }
            'file' {
                $path = [Environment]::ExpandEnvironmentVariables($request.path)
                if (-not (Test-Path -LiteralPath $path)) { return @{ exists = $false; text = '' } }
                # The client keeps its log open for appending; Get-Content's strings also carry
                # properties that ConvertTo-Json would serialize.
                $stream = New-Object IO.FileStream $path, 'Open', 'Read', 'ReadWrite,Delete'
                try { $text = (New-Object IO.StreamReader $stream, ([Text.Encoding]::UTF8)).ReadToEnd() } finally { $stream.Dispose() }
                @{ exists = $true; text = $text }
            }
            'languages' {
                # Two input languages, so that Alt+Shift pressed alone visibly switches between them.
                Set-WinUserLanguageList -LanguageList @($request.list) -Force -WarningAction SilentlyContinue
                @{ list = @(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag }) }
            }
            'hotkey' {
                # A system hotkey of the agent's own (modifiers: 1 Alt, 4 Shift, 0x4000 no repeat).
                $ok = [SC]::RegisterHotKey($form.Handle, [int]$request.id, [uint32]$request.modifiers, [uint32]$request.vk)
                @{ registered = $ok; error = if ($ok) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() } }
            }
            'show' {
                # ShowWindow on the client's window from outside, to tell what a show command does
                # from what the client's own code around it does (0 hide, 4 show without activating, 6 minimize, 9 restore).
                @{ result = [SC]::ShowWindowAsync([IntPtr][long]$request.hwnd, [int]$request.command) }
            }
            'find' {
                $found = $null
                foreach ($hwnd in [SC]::TopLevel()) { $d = [SC]::Describe($hwnd); if ($d.class -eq $request.class -and $d.visible) { $found = $d; break } }
                @{ window = $found }
            }
            'exit' { $script:quit = $true; @{ ok = $true } }
            default { throw "unknown command '$($request.cmd)'" }
        }
    }

    # --- the request loop, on the window thread so the backdrop keeps its message pump -------------
    $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), $Port
    $listener.Start()
    Write-Log "listening on 127.0.0.1:$Port, pid $PID"
    $timer = New-Object Windows.Forms.Timer
    $timer.Interval = 40
    $timer.Add_Tick({
            try {
                while ($listener.Pending()) {
                    $connection = $listener.AcceptTcpClient()
                    try {
                        $connection.ReceiveTimeout = 5000
                        $stream = $connection.GetStream()
                        $reader = New-Object IO.StreamReader $stream, ([Text.Encoding]::UTF8)
                        $writer = New-Object IO.StreamWriter $stream, (New-Object Text.UTF8Encoding $false)
                        $line = $reader.ReadLine()
                        if (-not $line) { continue }
                        $answer = try { Invoke-Request ($line | ConvertFrom-Json) } catch {
                            Write-Log "request failed: $line`n$($_ | Out-String)`n$($_.ScriptStackTrace)"
                            @{ error = "$_" }
                        }
                        $writer.WriteLine((ConvertTo-Json $answer -Depth 8 -Compress)); $writer.Flush()
                    } finally { $connection.Close() }
                }
                if ($script:quit) { $timer.Stop(); [Windows.Forms.Application]::Exit() }
            } catch { Write-Log "loop: $($_ | Out-String)" }
        })
    $timer.Start()
    # The form's handle exists without showing it; the message loop runs until 'exit'.
    [void]$form.Handle
    [Windows.Forms.Application]::Run()
    $listener.Stop()
    Write-Log 'stopped'
} catch {
    Write-Log "fatal: $($_ | Out-String)`n$($_.ScriptStackTrace)"
    exit 1
}
