# 前端加载时机与 Rolldown 构建分析 — 2026-09-17

当前使用 Vite 8.0.3 / Rolldown 1.0.0-rc.12。已运行现有 `vite-bundle-analyzer`，成功完成 TypeScript 检查和分析构建；业务代码、配置及线上部署未修改。

复现命令（从仓库根目录运行）：

```sh
cd frontend && ANALYZE=true bun run build --outDir /tmp/sharecode-bundle-analysis-20260917 --manifest
```

产物：

- [交互式体积图](/tmp/sharecode-bundle-analysis-20260917/bundle-report.html)：可查看模块树及大小。
- [分析器原始 stats](/tmp/sharecode-bundle-analysis-20260917/bundle-stats.json)。
- [Vite manifest](/tmp/sharecode-bundle-analysis-20260917/.vite/manifest.json)：`imports` 为静态依赖，`dynamicImports` 为动态入口。
- [按加载入口计算的增量清单](/tmp/sharecode-bundle-analysis-20260917/loading-stats.json)。

这是当前工作区的本地分析构建，环境参数不同会影响 hash 和少量字节；上一份全量体积基线取自线上部署产物。分析器借助 source map 归属模块，模块级 parsed/gzip 数值用于定位大依赖，不等同于最终文件网络传输量，模块压缩体积也不能当作实际合并 gzip 大小。

分析器汇总 567 个输出，未统计 public 直接复制的 9 个文件（JuliaMono、字体许可证、manifest 和图标）。因此全量大小应继续以逐文件统计为准。分析器显示的 map 大小是分析时使用的映射数据，本次输出没有把 source map 作为站点文件发布。

## 加载时机

| 资源 | 时机 | 当前懒加载情况 |
|---|---|---|
| 大多数页面代码及共用 UI、Yjs、pako | 首次访问，包括登录页 | 未按路由分割；App 从 pages/index 静态导入，仅 Audit 例外 |
| Milkdown / ProseMirror 核心 | 首次访问 | PlaybackPage 静态引入编辑器核心，而 PlaybackPage 又被 App 静态导入 |
| KaTeX JS / CSS | 首次访问 | mathPlugins 静态依赖；线上登录页网络记录确认加载了 katex JS |
| KaTeX 字体 | 公式真正渲染、浏览器使用相应字形时 | CSS 声明不等于下载所有格式/字体；少数小字体内嵌于 CSS，会随 CSS 下载 |
| Monaco 主体及查找功能 | 代码房间编辑器初始化、代码回放初始化时 | loadMonaco 动态导入，首次加载缓存 Promise |
| Monaco 语言支持 | 首次 loadMonaco 时一起注册 10 种语言 contribution；词法实现按 Monaco 激活语言继续加载 | 并非所有 contribution 都按当前语言单独加载 |
| Monaco CSS | 首次访问 | monaco-loader 顶层静态 import，进入入口 CSS |
| Monaco worker | Monaco 实际请求后台 worker 时 | worker 构造器被引用不等于浏览器立即下载 worker |
| Canvas / Excalidraw JS、CSS | 首次渲染 CanvasView（房间或回放切换到 Canvas） | React.lazy；Excalidraw 当前语言包也动态加载 |
| Canvas 绘图字体、Xiaolai | 场景文字、输入文字、字体预览等使用相应字符/字体时 | Excalidraw 按字符集合和 unicode range 加载；209 个 Xiaolai 分片并非一次全下载 |
| Excalidraw 字体子集 WASM | SVG 导出等流程需要内嵌字体时 | subset-shared / subset-worker 动态导入，并非打开白板即加载 |
| MarkdownEditor 包装组件/协作插件 | 渲染 Markdown 编辑器时 | React.lazy；但核心依赖已被回放页提前引入 |
| Mermaid / 图表解析和布局依赖 | Markdown 实际渲染 Mermaid 块；Canvas 的 Mermaid 功能调用时 | 动态导入；图表类型/布局模块还有内部动态入口 |
| 审计页 + 日期选择器 | 访问 /admin/audit | React.lazy |
| FingerprintJS | 首次调用需要指纹的请求：登录等显式非 GET 操作 | 动态 import，读取普通页面本身不触发 |
| Session 导出逻辑和 HTML 模板 | 点击 Export | 先动态导入 download，再 fetch 模板；下载 HTML 打开后的 CDN 依赖属于独立流程 |
| JuliaMono | 任意页面首次访问 | index.html 显式 preload，约 0.97 MiB，登录页也下载 |
| JetBrains Mono | 浏览器实际使用字体的字重/字符集时 | 字体 CSS 首屏加载，外部字体文件按需请求；本地已安装字体可能不请求 |

Canvas 模式的一个例外：editor.tsx 和 playback.tsx 用 CSS `hidden` 隐藏原编辑器，并没有卸载。因此直接进入 Canvas 仍可能初始化、加载代码或 Markdown 编辑器；这不影响 Canvas 自身是 lazy 的判断，但影响“只用 Canvas”的实际下载量。

## 静态依赖闭包的新增 JS/CSS

以下根据本次 manifest 计算：相对已经加载的站点入口，加载目标模块连同全部静态依赖，需要增加的 JS/CSS 文件。各行独立，不可直接相加。未包括运行期间进一步触发的字体、worker、语言实现、区域语言包、模板 fetch 等，所以不是完整场景网络实测。

| 入口 | 文件数 | 原始大小 | gzip level 6 |
|---|---:|---:|---:|
| Canvas | 7 | 1252.7 KiB | 374.9 KiB |
| Markdown 组件 | 1 | 34.7 KiB | 12.4 KiB |
| Audit | 2 | 213.3 KiB | 52.0 KiB |
| Monaco | 20 | 3749.8 KiB | 948.5 KiB |
| 导出 Session | 1 | 8.3 KiB | 3.6 KiB |

## 主要发现

- MarkdownEditor 动态部分只有约 35 KiB，主要因为许多编辑器核心早已进入首屏，不能据此判断 Markdown 编辑器本身很轻。
- 分析器归属显示主 index 中 React DOM 约 171 KiB、ProseMirror view 约 96 KiB、@milkdown 约 80 KiB，另有 ProseMirror model / tables / transform 等；KaTeX 虽是独立 chunk，却在入口静态 imports 中，仍然首屏加载。
- 线上登录页此前实测约 1.60 MiB 编码响应正文，其中 JuliaMono 约 0.97 MiB。该实测不包含登录后各功能。
- 优先改善实际访问量：页面级 lazy（尤其回放页），拆开回放 Markdown 核心加载边界，再移除 JuliaMono 全站预加载。单纯增加 chunk 数量不能保证按需加载；要确认它是否仍在入口静态依赖闭包中。
- 减少构建总量是另一个目标：字体覆盖范围、依赖功能裁剪、重复文件/字体格式处理。已有的 Xiaolai 分片懒加载已能避免单个用户总是下载全部 12.08 MiB。
