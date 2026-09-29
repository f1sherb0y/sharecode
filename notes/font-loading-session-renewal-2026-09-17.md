# 字体、加载与会话续期 — 2026-09-17

本轮已实现并在本地验证，未部署、未提交。主站 JavaScript 继续同源提供；字体走固定版本 jsDelivr URL。

## 字体和加载

- 代码、Markdown 正文和白板文字统一 Cascadia + `monospace`。保留字号偏好，迁移旧字体偏好，移除字体选择菜单。
- 删除 JuliaMono 公共文件与全站 preload、JetBrains Mono 引入、Excalidraw 全量字体复制。所有字体文件移出 dist；Cascadia 是唯一内容字体，Monaco 的 codicon 是功能图标字体，同样由 CDN 提供。
- Excalidraw 0.18.1 无公开的字体注册配置：使用 `tooling/canvas-font.ts` 小范围适配，开发/生产一致，仅注册 Cascadia，真实 Canvas font 字符串包含 monospace。依赖固定 0.18.1，升级必须重新审计适配器。旧场景读取时统一字体，原始历史不进行数据库迁移。
- 公式保留 LaTeX 数据与协作，KaTeX 只生成 MathML，由浏览器原生排版，不再下载 KaTeX 专用字体。数学符号的系统字体回退由浏览器处理。
- 所有路由按需加载，回放页的 Markdown 核心进一步隔离；Monaco CSS 随编辑器加载。直接访问 Canvas 时不初始化隐藏编辑器；首次打开后保留编辑器实例，避免反复切换丢失光标/状态。
- 切换按钮的悬停/键盘聚焦可提前加载目标组件；省流量和 2G 模式跳过。复用同一个模块加载 Promise，失败的 speculative request 不影响当前视图。
- 哈希资源（含回放 HTML 模板）`Cache-Control: public, immutable` + 1 年浏览器缓存；缺失资源返回真实 404。HTML 不缓存。gzip level 6，发送 Vary: Accept-Encoding。
- 字体加载失败可回退；Monaco 不会为字体卡住数秒，字体到达后重新测量字宽。

## 体积

口径：完整本地生产构建，gzip level 6 分文件估算文本资源，其余保持原大小；CDN 文件不属于 dist。基线来自前一份线上产物报告，因此环境参数可能影响少量字节。

| 指标 | 修改前 | 修改后 |
|---|---:|---:|
| 全部构建文件 | 576 | 282 |
| 原始总大小 | 29,917,319 bytes / 28.53 MiB | 14,087,284 bytes / 13.43 MiB |
| gzip 估算总大小 | 19.10 MiB | 4.10 MiB |
| 本地字体文件 | 327 | 0 |

完整新清单：`frontend-bundle-optimized-2026-09-17.json`。注意：移到 CDN 降低本地产物大小，按需加载/删除不再使用的字体才降低用户实际下载量。

真实 Nginx + 浏览器测试：登录页 JS/CSS 冷加载约 196 KiB 编码响应正文；同一浏览器上下文再次访问时 JS/CSS `transferSize = 0`，证实使用浏览器本地缓存。登录页无字体请求，无 Monaco / Canvas / Markdown 核心预加载。结果及截图：`/tmp/sharecode-loading-wRaRKL/`。

## 会话与断连

- 同一账号允许多设备同时登录。登录和续期不递增 tokenVersion，不会互踢。
- 已确认原实现没有用户 JWT 自动续期，且数据库认证故障也会发送永久 auth-denied，让前端停止重连。本轮修复这些缺口；没有将每次线上断连都归因于 token 到期。
- 新增 `POST /api/auth/refresh`：仅经过现有用户鉴权的 token 可续期，重新读取账户状态/权限，续为 7 天。无效、撤销、过期（按现有 JWT 校验规则）和访客凭证不能换成用户凭证。响应 no-store。
- 活跃用户在剩余 24 小时内续期；每分钟、恢复可见、网络恢复、API 请求及 WebSocket 认证都会检查。相同 credential 的并发请求合并，网络错误保留现有会话；延迟响应不能覆盖退出登录/切换账号后的凭证。
- 原服务拒绝同一连接上的再次认证；现在同一用户的 WebSocket 可原位重新认证，不 detach 文档，不清空 awareness，不重建编辑器。不同 actor 不能在旧 socket 上替换身份。
- 用稳定的每次登录 sessionId 作为恢复日志 scope；JWT 更新不改变 scope。旧客户端的恢复日志仍兼容，刷新网页后仍能找到该 session 的待保存记录。
- 临时数据库认证故障正常断开并自动重连，不伪装成永久拒绝。真正的房间权限撤销、改密码和停用账号仍保留撤销语义。
- 登录状态仍按标签页保存。没有把用户 token 移到全局 localStorage，也没有添加持久明文密码或离线授权缓存。

## 验证

已通过：

- TypeScript + Vite 生产构建。
- Rust 17 个单元测试。
- `tests/session-renewal.mjs` + 隔离 PostgreSQL：两设备同时登录；短 token 到期后持续编辑；原 socket 续期；临时 User 查询故障自动恢复；一次 503 后重试；并发续期合并；编辑器/模型实例不变；刷新；字体 CDN 不可用；不同 actor 重认证拒绝；无效/过期/访客凭证拒绝；改密码撤销旧凭证。
- `tests/bundle-loading.mjs`：Chromium / Firefox / WebKit 实际生产构建 + Nginx；真实浏览器缓存；Canvas-only 不加载编辑器；旧字体场景；仅 Cascadia 注册；脚本同源；代码/Markdown/MathML 回放。没有模拟自由绘图操作。
- 三浏览器的 Markdown 字号、内容/选区保留、移动端状态条和字体控件检查。
- Markdown 公式 8 项、协作编辑 3 项、Canvas 同步/采样/回放/Follow 7 项。
- Chromium 导出 HTML 回归：file:// 打开、代码/Markdown/MathML/Mermaid/图片/Canvas、拖动进度、主题、移动布局、隐私/CSP。
- `git diff --check`。

已有检查限制：仓库没有 ESLint 10 所需的 eslint.config 文件，因此 eslint 命令无法启动；i18n 的键覆盖和插值检查通过，硬编码 UI 文本检查仍报告导出播放器既有的 `Language / 语言` 和匿名 `user` 标签（HEAD 中也存在，本轮没有引入）。

复现：

```sh
(cd frontend && bun run build && node tests/bundle-loading.mjs)
# 仓库根目录，需要 Docker；仅使用临时数据库
bash scripts/test-runner-local.sh tests/session-renewal.mjs
```

白板实际绘图、文字编辑手感仍交给用户手测。部署需要用户另行许可。
