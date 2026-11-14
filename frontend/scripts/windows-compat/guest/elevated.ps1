# Runs on the test VM over SSH (session 0, administrator, elevated) and answers with one JSON line:
# what the desktop agent, which is not elevated, cannot see or do to a client that runs as
# administrator.
#   elevated.ps1 elevation <process>      whether the process is elevated, and its integrity level
#   elevated.ps1 webviews <match>         the client's WebView2 processes (by their command lines)
#   elevated.ps1 suspend <process> <ms>   freezes the process for a while
param([string]$Command, [string]$Target, [int]$Milliseconds = 0)
$ErrorActionPreference = 'Stop'

# Compiling takes a second; counting processes, which is polled, needs none of it.
if ($Command -ne 'webviews') {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Elevated {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr info, int size, out int needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr process);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr process);

  // { elevated (TokenElevation), integrity (the RID: 0x2000 medium, 0x3000 high, 0x4000 system) }
  public static int[] Token(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
    if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      IntPtr token;
      if (!OpenProcessToken(process, 0x8, out token)) throw new System.ComponentModel.Win32Exception();   // TOKEN_QUERY
      IntPtr buffer = Marshal.AllocHGlobal(256);
      try {
        int needed;
        if (!GetTokenInformation(token, 20, buffer, 4, out needed)) throw new System.ComponentModel.Win32Exception();   // TokenElevation, a DWORD
        int elevated = Marshal.ReadInt32(buffer);
        if (!GetTokenInformation(token, 25, buffer, 256, out needed)) throw new System.ComponentModel.Win32Exception();   // TokenIntegrityLevel
        IntPtr sid = Marshal.ReadIntPtr(buffer);
        int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
        int integrity = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        return new int[] { elevated, integrity };
      } finally { Marshal.FreeHGlobal(buffer); CloseHandle(token); }
    } finally { CloseHandle(process); }
  }
}
'@
}

$answer = switch ($Command) {
    'elevation' {
        $processes = @(Get-Process -Name $Target -ErrorAction SilentlyContinue)
        @{ processes = @($processes | ForEach-Object { $token = [Elevated]::Token($_.Id); @{ pid = $_.Id; elevated = [bool]$token[0]; integrity = $token[1] } }) }
    }
    'webviews' {
        $found = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Target) })
        @{ count = $found.Count }
    }
    'suspend' {
        $process = Get-Process -Name $Target | Select-Object -First 1
        [void][Elevated]::NtSuspendProcess($process.Handle)
        try { Start-Sleep -Milliseconds $Milliseconds } finally { [void][Elevated]::NtResumeProcess($process.Handle) }
        @{ suspended = $process.Id }
    }
    default { throw "unknown command '$Command'" }
}
$answer | ConvertTo-Json -Depth 5 -Compress
