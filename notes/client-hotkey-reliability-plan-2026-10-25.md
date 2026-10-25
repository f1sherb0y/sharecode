# 客户端穿透快捷键可靠性方案

状态：Windows 第一阶段已实现，macOS 原生监听与权限引导仍待实现。本文继续作为实施清单，不升级版本、不创建发布标签或重新打包。

## 目标与已确认取舍

保证客户桌面端的 `Ctrl+Shift+F` 尽可能可靠地切换穿透，包括窗口在后台、无焦点、隐藏任务栏/Dock 或最小化时。

用户已明确：其他应用是否同时响应这个组合键不重要。我们的实现无需独占、吞掉或修改按键；其他程序占用标准全局快捷键时，也应尝试通过原生键盘监听触发自己的操作。冲突检测用于诊断，不作为主方案。

本轮范围是客户客户端 `frontend/src-tauri-client` 与 `frontend/src/client`。不顺带修改 staff 桌面端的其他快捷键。

## 当前实现与问题

- `src-tauri-client/src/lib.rs` 使用 `tauri-plugin-global-shortcut`，锁定的底层 `global-hotkey` 为 0.8.0。此组合键在 Windows 使用 `RegisterHotKey`（已有 `MOD_NOREPEAT`），在 macOS 使用 `RegisterEventHotKey`，已经不依赖 WebView 焦点。
- 注册冲突和切换失败仅写原生日志，界面无法区分未收到按键与窗口操作失败。
- macOS 在快捷键未注册时拒绝启用穿透；Windows 缺少同等保护，可能进入无法通过快捷键恢复的状态。
- 切换在主线程执行，但需要进一步统一快捷键、标题栏命令、启动恢复之间的状态协调，防止旧状态覆盖新状态。
- “偶尔没反应”尚未复现确认原因；不能直接认定全部由快捷键冲突造成。

## 实现方案

### 1. 原生监听作为主要路径

**Windows：`WH_KEYBOARD_LL`**

- 在专用原生线程安装低级键盘 hook，并持续运行消息循环。
- 只识别目标键与修饰键；识别成功后将动作投递给主线程。回调不进行窗口操作、网络访问或阻塞工作。
- 继续调用 `CallNextHookEx`，不吞键。无需成功独占注册这个组合键才能启用监听。
- 正确处理左右 Ctrl/Shift、按键按下与释放、自动重复、失去释放事件后的恢复及线程退出时清理。
- 检测线程退出、初始化失败及恢复事件。Windows 可能因回调超时静默移除 hook，不能把“线程还活着”当作“监听一定正常”；实现恢复策略并提供实际按键测试。

**macOS：session 级 `CGEventTap`，使用 `.listenOnly`**

- 使用 `.cgSessionEventTap`、`.headInsertEventTap` 和 `.listenOnly`，在专用线程的 RunLoop 中接收键盘事件。
- 监听所需的按下、释放和修饰键变化，识别组合键后投递主线程切换。不修改、丢弃或合成事件。
- 处理 tap 禁用通知、RunLoop 生命周期、休眠/唤醒和权限变化；可恢复时重新启用或创建监听。
- 主动监听不需要独占 `RegisterEventHotKey` 注册，因此不因其注册冲突而直接失效。

### 2. macOS 权限：仅为本功能请求输入监控

Apple 对两种 event tap 明确区分：

| 模式 | 能力 | 对应系统授权 |
| --- | --- | --- |
| `.listenOnly` | 观察键盘事件 | 输入监控（Input Monitoring） |
| `.defaultTap` | 修改或阻止事件传递 | 辅助功能（Accessibility） |

本需求只观察组合键并修改自己的窗口，采用 `.listenOnly`，不为此请求辅助功能权限，也不使用要求不同权限的 `NSEvent` 全局键盘 monitor 替代。

- `CGPreflightListenEventAccess()`：检查输入监控授权。
- `CGRequestListenEventAccess()`：由用户操作触发授权请求。
- 引导到「系统设置 → 隐私与安全性 → 输入监控」。授权不可由应用自动授予。
- 按实际创建 tap 的结果判断能否工作；处理拒绝、撤销、重新授权及可能需要退出重开的情况，避免反复弹窗。
- 未授权时仍尝试标准全局快捷键作为回退，并显示实际使用的路径和状态。

### 3. 回退、去重与真实状态

- 保留标准系统全局快捷键作为回退路径。优先让一个后端负责触发；如果恢复或切换期间两条路径同时存在，使用统一按键周期状态去重。
- 一次物理按下只切换一次，长按不反复切换；不能仅用固定时间防抖，否则快速的两次有效按键可能被丢弃。
- 所有切换进入同一个主线程处理入口，从原生实际状态计算下一状态，应用后读回确认，再通知前端。失败报告原因，不发送虚假的成功状态。
- 保留开启穿透时自动置顶、关闭穿透时恢复交互，以及快捷键找回最小化窗口的行为。
- 启动注册和前端恢复偏好有明确顺序。没有初始化成功的恢复路径时，不恢复或开启穿透；运行中确认所有路径失效时，尝试关闭穿透、显示可交互窗口并报告问题。
- 防止同一正式客户端的重复实例争抢注册或重复处理；测试包继续使用独立应用身份。

### 4. 最小诊断界面

- 在现有窗影设置中显示快捷键和监听状态：原生监听可用、标准快捷键回退、缺少输入监控授权或初始化失败。
- 提供实际按键测试，区分“收到组合键”“窗口切换成功”“执行失败”。
- 原生日志记录后端启停、权限/注册错误及目标快捷键动作结果，不记录普通按键或用户输入内容。
- 可配置快捷键不是这次可靠性改造的前提；默认保持 `Ctrl+Shift+F`。

## 验证与验收

1. 为共享按键状态逻辑加入测试：重复按下、左右修饰键、释放顺序、快速连续操作、后端重复事件和恢复时重置。
2. Windows 与 macOS 原生实机测试：前台/后台、穿透开关、最小化、隐藏任务栏/Dock、中文输入法、长按及快速连按。
3. 使用可控的第二个程序占用标准快捷键，确认原生监听路径仍可切换；不要求第二个程序停止响应。
4. 测试休眠/唤醒、锁屏/解锁、重复启动以及原生窗口读回；Windows 另测前台为提升权限的应用时的行为。
5. macOS 测试输入监控首次授权、拒绝、撤销、重新授权/重启和安全输入启用时的表现；没有完整辅助功能授权时，只监听路径也应可用。
6. 读取真实 HWND/NSWindow 状态确认穿透和焦点行为；不能以图标变化、WebView 测试或编译成功代替原生验收。
7. 实现后运行相应原生/前端检查，并使用独立身份的测试客户端验证。正式版本号、发布标签、安装包构建和上线按后续用户授权执行。

## 已知边界

Hook/event tap 提高可达性，但不是无条件保证。Windows 的其他 hook、安全桌面及安全软件，macOS 的安全输入和被撤销权限，都可能限制事件投递。健康检测不能证明每次按键必然到达，因此需要诊断、恢复路径和实机验证，不能承诺绕过操作系统限制。

## 官方资料

- [Apple WWDC19 — Advances in macOS Security](https://developer.apple.com/videos/play/wwdc2019/701/)：明确说明 listen-only tap 需要输入监控授权，修改型 tap 需要辅助功能授权。
- [Apple DTS：Accessibility permission in sandboxed app](https://developer.apple.com/forums/thread/707680)：给出 `.cgSessionEventTap` / `.listenOnly` 示例及 `CGPreflightListenEventAccess`、`CGRequestListenEventAccess`。
- [Apple DTS：Accessibility Permission In Sandbox For Keyboard](https://developer.apple.com/forums/thread/789896)：确认后台监听键盘可使用输入监控权限，并区分 `ListenEvent`、`PostEvent` 与完整 Accessibility 权限。

以上资料于 2026-10-25 查阅。


## 2026-10-26 实施记录

- Windows 已增加 `src-tauri-client/src/hotkey_windows.rs`：专用 `WH_KEYBOARD_LL` 线程、左右 Ctrl/Shift 识别、F 键按下去重、丢失释放后的 1.5 秒状态恢复、继续调用 `CallNextHookEx`，并把动作投递回 Tauri 主线程。
- 标准 `tauri-plugin-global-shortcut` 保留为回退；原生监听可用时忽略同一标准回调，避免一次按键切换两次。
- 原生监听未启动且标准回退不可用时，后端拒绝开启穿透，避免进入无法恢复的状态。
- 窗口设置面板显示原生监听、标准回退或不可用状态；状态通过 `sharecode:hotkey-status` 和 `get_hotkey_status` 读取。
- Windows 单元测试覆盖左右修饰键的一次按下只触发一次，以及丢失释放后的恢复。未执行会移动鼠标或注入按键的实机测试。
- macOS `.listenOnly` `CGEventTap`、输入监控授权和睡眠/唤醒恢复仍是下一阶段。


### 后续用户修正与手动验证（2026-10-26）

- 用户要求只保留原生监听，不使用标准全局快捷键回退；此前的回退描述已不再是当前实现。
- 手动日志确认 Windows 实际发出左右独立修饰键 VK_LCONTROL/VK_RCONTROL/VK_LSHIFT/VK_RSHIFT，现已同时识别这些代码和通用代码。
- 钩子线程每 30ms 对 Ctrl/Shift/F 的系统状态作协调，恢复遗漏的释放，也识别漏送的按下；与 hook 共享 F 按下周期，未增加浏览器快捷键或按键注入。
- 用户要求切换不改变窗口焦点：Windows 移除 SetFocus/SetForegroundWindow 和自动恢复最小化窗口；置顶改为原生 SetWindowPos(SWP_NOACTIVATE)，避免 Tao 的通用 setter 调用 SW_SHOW 导致激活。
- 日志通过有界队列交给独立线程写入，仅记录相关修饰键/目标快捷键和窗口操作结果，不记录普通输入。仍需用户手动验证应用内外行为；构建通过不等于该验收完成。
