# 前端构建体积基线 — 2026-09-17

版本：`20260917-privacy-audit-093447`。统计线上已部署的全部前端构建产物，排除 Nginx 自带的 `50x.html`（497 bytes）。

总计 **576 个文件，29,917,319 bytes（28.53 MiB）**。

统计包含所有懒加载 chunk、编辑器 worker、字体分片、图标、manifest、许可证、JS 内嵌 WASM 和导出回放播放器 HTML。无 source map。单独统计每个文件，不采用磁盘块占用或 tar 大小。

gzip 列是逐文件 gzip level 6 压缩 JS/CSS/HTML 后的估算，字体及其他资源保留原大小；不是服务器实测网络流量，也不含 HTTP/TLS 开销。MiB = 1,048,576 bytes。懒加载文件和字体分片并不会在每次访问时全部下载。导出播放器通过 CDN 引用的外部依赖不属于本次构建产物，其文件正文不计入；产物内的引用代码已计入。

| 类型 | 文件数 | 原始 MiB | gzip 估算 MiB | 原始占比 |
|---|---:|---:|---:|---:|
| JavaScript | 232 | 12.79 | 3.91 | 44.8% |
| CSS | 7 | 0.71 | 0.18 | 2.5% |
| Fonts | 327 | 14.97 | 14.97 | 52.5% |
| HTML | 2 | 0.04 | 0.02 | 0.1% |
| Other | 8 | 0.02 | 0.02 | 0.1% |
| **总计** | **576** | **28.53** | **19.10** | **100%** |

## 字体分布

| 字体 | 文件数 | MiB |
|---|---:|---:|
| excalidraw/fonts/Xiaolai | 209 | 12.08 |
| KaTeX | 59 | 1.02 |
| JuliaMono | 1 | 0.97 |
| JetBrains Mono | 28 | 0.28 |
| Monaco codicon | 1 | 0.12 |
| Assistant (assets) | 4 | 0.08 |
| excalidraw/fonts/Assistant | 4 | 0.08 |
| excalidraw/fonts/Liberation | 1 | 0.07 |
| excalidraw/fonts/Cascadia | 1 | 0.06 |
| excalidraw/fonts/Excalifont | 7 | 0.06 |
| excalidraw/fonts/Nunito | 5 | 0.05 |
| excalidraw/fonts/Virgil | 1 | 0.05 |
| excalidraw/fonts/ComicShanns | 4 | 0.03 |
| excalidraw/fonts/Lilita | 2 | 0.01 |

## 最大的 20 个文件

| 文件 | 原始 KiB | gzip 估算 KiB |
|---|---:|---:|
| `assets/chunk-EIO257PC-BxqQVOD3.js` | 1778.4 | 723.9 |
| `assets/editor.api2-qJQVc7G7.js` | 1587.6 | 395.0 |
| `fonts/JuliaMono-Regular.woff2` | 996.4 | 996.4 |
| `assets/toggleHighContrast-CNzEY8_j.js` | 993.3 | 250.8 |
| `assets/index-BNObmYMU.js` | 975.0 | 287.5 |
| `assets/findInput-IsjZj0XK.js` | 942.6 | 256.8 |
| `assets/chunk-KEIR6QF5-S0SqKre0.js` | 651.9 | 141.6 |
| `assets/canvas-view-CeZ3Ru4P.js` | 555.7 | 166.5 |
| `assets/chunk-K2UTITRG-DElUtueT.js` | 527.1 | 175.4 |
| `assets/cytoscape.esm-BI4d58Z-.js` | 426.0 | 133.4 |
| `assets/index-DIJatAsY.css` | 414.2 | 135.0 |
| `assets/editor.worker-DWlYVeeX.js` | 273.4 | 83.6 |
| `assets/katex-Bo4Y4D-o.js` | 253.5 | 74.7 |
| `assets/chunk-I66GZJ75-Dv2lRLwV.js` | 237.8 | 36.7 |
| `assets/ui-DJRS3TJu.js` | 213.1 | 64.4 |
| `assets/audit-C_l8aZmc.js` | 188.4 | 48.4 |
| `assets/architectureDiagram-T3A2C74G-BPOpn7nS.js` | 146.2 | 40.0 |
| `assets/canvas-view-Du1CtotG.css` | 144.9 | 22.7 |
| `assets/codicon-ngg6Pgfi.ttf` | 119.1 | 119.1 |
| `assets/swimlanes-SLNWSIFB-CO2_-WNZ.js` | 118.4 | 40.1 |

已核对主要大块的来源：`chunk-EIO257PC` 为 Excalidraw 字体子集处理代码（含 base64 WASM，代码调用 HarfBuzz）；`editor.api2`、`findInput`、`toggleHighContrast` 属于 Monaco；`chunk-KEIR6QF5` 包含 Mermaid 的 Langium 解析代码；`canvas-view` 和 `chunk-K2UTITRG` 包含 Excalidraw。chunk 名称不代表单一功能，例如 `toggleHighContrast` 不能理解为只有主题切换代码。主 `index` 包含站点代码及共享依赖，不能全部归入业务代码。未使用 source map 做精确依赖级归属，不对共享 chunk 重复计数。

## 完全重复的文件

- `assets/Assistant-Bold-gm-uSS1B.woff2`, `excalidraw/fonts/Assistant/Assistant-Bold.woff2`；冗余 20,380 bytes。
- `assets/Assistant-Medium-DrcxCXg3.woff2`, `excalidraw/fonts/Assistant/Assistant-Medium.woff2`；冗余 20,320 bytes。
- `assets/Assistant-Regular-DVxZuzxb.woff2`, `excalidraw/fonts/Assistant/Assistant-Regular.woff2`；冗余 20,232 bytes。
- `assets/Assistant-SemiBold-SCI4bEL9.woff2`, `excalidraw/fonts/Assistant/Assistant-SemiBold.woff2`；冗余 20,212 bytes。
- `assets/classDiagram-JCYQIIEL-Bm3mPoz7.js`, `assets/classDiagram-v2-OCEON4UE-Be5Daah2.js`；冗余 789 bytes。

按 SHA-256 判定的完全重复冗余共 **81,933 bytes**。不同字体格式及不同字符分片不算完全重复。

## 后续优化优先级

1. **Canvas 字体**：`vite.config.ts` 将 Excalidraw 所有字体复制到产物中。Xiaolai 209 个分片共 12.08 MiB，约占总产物 42.3%。先确认需要保留的字符集和字体选择，再考虑裁剪或替换；不能仅因分片多而删除，否则可能丢失中文/日文字符。按需加载只能减少单次访问下载量，不能减少构建总量。
2. **Monaco / Canvas / Mermaid**：JS 共 12.79 MiB。审计实际使用的编辑器功能、图表类型和字体子集处理路径后，再考虑精简导入。1.74 MiB 的 Excalidraw 字体处理 chunk 值得单独调查，不意味着可以直接安全删除。
3. **字体格式和重复资源**：KaTeX 与 JetBrains Mono 有多格式资源；在确认最低浏览器版本后可评估只保留 WOFF2。Assistant 四份字体存在双路径相同内容，共冗余 81,144 bytes；需同时修正引用才能去重。
4. **首屏专项**：JuliaMono 0.97 MiB 被首页预加载，延后加载能降低首屏下载量，但不改变构建总大小。gzip/Brotli 优化同样主要影响传输大小。

本轮仅统计，未修改业务代码或部署。完整逐文件 bytes、gzip 估算和 SHA-256 见同目录 JSON。
