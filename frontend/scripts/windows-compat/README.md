# Window features across Windows builds

Runs the MyGo customer client on the Hyper-V test VMs (`D:\VirtualMachines\tools\README.md`:
Windows 10 22H2 and Windows 11 21H2 to 26H2) and checks it on each build: the installer (UAC,
WebView2), the start as administrator, and the window features: the Alt+Shift shortcuts,
click-through, pinning, transparency, capture exclusion, the title bar.

```powershell
# Once per session: the VM tooling's elevated runner (one UAC prompt)
Start-Process pwsh -Verb RunAs -ArgumentList '-NoProfile','-File','D:\VirtualMachines\tools\scripts\Elevated-Runner.ps1'

# The development client: own name, install directory and WebView2 profile
..\..\src-mygo-client\build-windows.ps1

node run.mjs                                          # every VM, checkpoint clean
node run.mjs --vms Win10-22H2 --checkpoint patched    # one VM, another checkpoint
node run.mjs --vms Win10-22H2 --soak 50               # also repeat the held arrow keys 100 times
node run.mjs --vms Win10-22H2 --release               # the released identity (build-windows.ps1 -Release)
node run.mjs --vms Win11-25H2 --keep                  # leave the VM running; then probe.mjs or --attach
```

Each VM is restored to its checkpoint, booted, tested and restored again; one at a time, about
five minutes each. Results go to `D:\VirtualMachines\tools\results\<time>\`: `summary.md` (the
table), `summary.json`, and per VM `report.json`, the screenshots each measurement used (every
UAC prompt among them), the installer's log and `agent.log`. The exit code is 1 when any check
failed.

## How it tests

Nothing is asked of the client through its own API, and nothing is believed from its own state.

- **Input is hardware input.** Keys and mouse go through Hyper-V's synthetic keyboard and mouse
  (`tools\scripts\Hv-Input.ps1`), so the guest receives them from its keyboard and mouse drivers,
  as from a physical device. No `SendInput` runs inside the guest. A held key is sent as a
  keyboard sends it: repeated key-downs without a key-up.
- **Results are what Windows reports.** `guest/agent.ps1` runs on the VM's desktop (signed-in
  user, not elevated) and answers with the window's styles, display affinity, Z order,
  `WindowFromPoint` at a grid of points, the foreground window and the keyboard layout.
- **A test window records what gets through.** The agent owns a full-screen window of black and
  white stripes behind the client (the backdrop). It logs every mouse and key event it receives:
  a click that passes through the client lands there with its coordinates, and a chord that is
  not absorbed shows up as a key-down.
- **Pixels come from the hypervisor.** Screenshots are the VM's video output
  (`GetVirtualSystemThumbnailImage`), not a capture API in the guest, so the capture-excluded
  client is in them. The contrast of the stripes seen through the client measures its real
  opacity: `255 × (1 − background opacity)`; 255 means the window is not there, 0 that it is
  opaque. The same strip in a `BitBlt` capture taken inside the guest must show the bare stripes.
- **The client is installed and started as a customer does it**: the installer runs on the
  desktop, not elevated, with the one-line install command's `/SILENT /NORESTART`, and asks for
  administrator rights itself; the client is opened through the shell by the app in front, as
  Explorer opens it on a double click. The app in front is the backdrop, after a real click on
  it: asked for by a process in the background, Windows leaves the UAC prompt minimized on the
  taskbar instead of showing it. Each prompt appears on the secure desktop and is answered there
  with Alt+Y on the keyboard. The images differ in what the installer finds: no WebView2 runtime on Windows 10,
  version 90 and 100 (too old for the page) on Windows 11 21H2 and 23H2, a current one elsewhere.
- **The client runs as administrator, the agent does not.** Styles, Z order and hit tests of an
  elevated window can be read by any process. What cannot (its token, the command lines of its
  WebView2 processes, suspending it) is asked over SSH, whose session is elevated
  (`guest/elevated.ps1`).

Click-through, for example: Alt+Shift+F is pressed while the backdrop has the focus; the styles
must read `TRANSPARENT|LAYERED|NOACTIVATE|TOPMOST`; the screenshot must still show the client on
top; `WindowFromPoint` must resolve all nine points inside it to the backdrop; a real click inside
it must arrive in the backdrop at the same coordinates without changing the foreground window; a
real F8 must arrive there too. After Right Alt+Right Shift+F the same click must reach the client
and the backdrop must receive nothing.

## Files

| File | Part |
|---|---|
| `run.mjs` | One VM after another: restore, install, checks, summary |
| `checks.mjs` | The checks, in groups: I install, A small screen, L launch, T transparency, P pinning, C click-through, H hide, E elevated app in front, S frozen client, M move, U title bar, K input language, X close, R installer over a running client and uninstaller, Z what no reading of the window may ever show (a system menu, open to capture while on screen) |
| `lib.mjs` | The VM (elevated runner, SSH, agent, input, screenshots), PNG decoding, stripe contrast |
| `guest/setup.ps1` | In the guest over SSH: system report, starts the agent on the desktop |
| `guest/agent.ps1` | In the guest on the desktop: what Windows reports, the backdrop, the install |
| `guest/elevated.ps1` | In the guest over SSH, elevated: the client's token, its WebView2 processes, freezing it |
| `probe.mjs` | One agent request, input sequence or screenshot by hand, for a VM kept running |

## Limits

- The VMs run at 100 % scaling on one screen (1366×768 for group A, 1920×1080 otherwise), on
  Hyper-V's video adapter: no physical GPU, no second monitor, no 125–200 % scaling.
- Capture exclusion is checked against `BitBlt` only, not against a meeting program's sharing.
- The start screen is tested, not a room: no server is involved, so Monaco and Canvas with
  transparency are not covered.
- The title bar's buttons are clicked at fixed offsets from the window's corner (100 % scaling).
- One VM at a time for results that count. Runs side by side do not reach each other (each has
  its own tunnel port and input folder), but with two or three VMs the host is slow enough to
  show in the guests: a title bar drag that began after the mouse had moved on, a page not yet
  resized a second after maximizing.
- The elevated app is Task Manager, the input method Microsoft Pinyin; no third-party input
  method, security software or meeting program is installed on the VMs.
- The signed-in user is an administrator, so UAC asks for consent only. A standard user is asked
  for an administrator's password and the client then runs as that other account; not tested.
- The installer downloads WebView2 from Microsoft: the VMs need the internet for it.
- The development client reads the production update feed like an installed client; when a
  version newer than its own is published it shows the update screen instead of the start screen.
- A VM on a laptop host sees the host's battery. The agent's task is registered to start on
  battery too; anything else scheduled in a guest needs the same.
