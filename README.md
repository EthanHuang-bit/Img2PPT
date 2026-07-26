# Img2PPT

Convert PPT images into editable PowerPoint slides built from native objects while preserving the original layout.

将概念图、架构图和商业流程图转换为尽可能可编辑的 PowerPoint。每张图片对应一页，文字使用透明文本框，常规色块、边框、线条和基础几何图形优先生成 PowerPoint 原生对象，复杂小图标保留为独立 SVG。

## 本地运行

需要 Windows 10/11、Node.js 22+、Chrome/Edge 和 Microsoft PowerPoint。

```bash
npm install
npm start
```

浏览器打开 `http://127.0.0.1:4173`。

## v0.7.0 Recovery 的处理流程

- 每张图片仍单独发送给视觉模型，页面队列最多同时处理 20 页，不会把 20 张图片放进同一个模型请求。
- 页面结果完成后立即写入内存缓存并返回前端，进度按“已处理页数/总数”显示。
- 本地 OCR 由最多 4 个独占 Worker 执行，避免并发修改 Tesseract 参数。
- “生成 PPT”读取已经完成的页面缓存，不会重新调用 OCR、视觉模型或文本模型。
- 整页视觉分析失败时自动拆为四个带 8% 交叠的象限；每个象限请求同时包含低清整页上下文和高清局部图。
- 分块结果会恢复到整页 0–1000 坐标，按对象类型、语义和空间重叠去重拼接。
- 生成后使用 PowerPoint（Windows）或 LibreOffice（测试环境）渲染每页，再执行前景感知的像素/边缘/颜色比较。
- 启用视觉模型时，同一模型会对“原图 + PPT 渲染图”做结构化双图复核；模型结果不能覆盖内容和可编辑性硬门禁。
- 每页分别显示内容、版式、观感、可编辑性和综合分。综合 98%、版式 96%、观感 96%、内容 99.5%、可编辑性 100% 才通过。

本仓库的 v0.7.0 Recovery 是依据保留的功能规格重建的工程验证版本，不是已被临时工作区清理的旧 ZIP 的字节副本。

## 识别与重建原则

- 禁止把占页面 25% 以上的实心区域直接作为背景位图回退。
- 文字框始终无填充、无线条；OCR 重复结果按空间重叠和文本相似度合并。
- 字号同时按 OCR 单词字高和文本框可用宽度推算，避免文字换行、溢出或异常放大。
- 图像/SVG 对象中的 OCR 文字区域在矢量化前擦除，避免“原图文字 + 可编辑文字”叠加。
- 图标徽章拆为独立背景形状和纯色矢量前景；压缩噪点和 OCR 碎片会在描摹前过滤。
- 内置统一矢量图标库；大模型无法精确重建低清图标时可按语义推荐相似图标。
- 大面积规则区域优先识别为矩形、圆角矩形、椭圆、线条或边框。
- 复杂小对象才允许作为独立 SVG；默认不会生成整页背景图。
- 可选 OpenAI、Qwen 或自定义 OpenAI 兼容视觉模型返回文字、图标、内容图片、原生形状、边界框和层级。本地代码仍负责 PPT 生成。
- 可单独配置 DeepSeek、Qwen、OpenAI 或自定义兼容文本模型，仅用于 OCR 纠错；模型不允许改变对象坐标。
- 每次转换都会生成 JSON 质量报告，记录大面积回退、对象类型、OCR 字体统计和视觉增强状态。
- Qwen 正式视觉分析采用流式响应、6 分钟总等待和 3 分钟无数据等待；视觉模型不再重复输出本地 OCR 已处理的文字对象。

## 自动回归与质量闭环

将本地测试图片放入 `upload/` 目录。该目录默认被 Git 忽略，避免把客户或项目图片提交到公开仓库。

```bash
npm run regression -- upload
npm test
npm run smoke
```

脚本将逐张转换、用 LibreOffice 渲染 PPT、与原图比较，并输出 `output/regression/report.html`。
质量循环的单次“开发候选”可以包含多个测试用例，但开发—整体验证最多执行 10 次；全部门禁通过、连续两次没有有效提升或达到上限时停止，并保留最佳候选。

## 可选多模型增强

本地转换不需要 API Key。设置页可分别启用：

- 视觉模型：OpenAI Responses API、Qwen/OpenAI 兼容 Chat Completions，或自定义兼容服务。
- 文本模型：DeepSeek、Qwen、OpenAI 或自定义 Chat Completions 服务。

每组配置均包含服务商、Base URL、模型、API Key 和“测试连接”。测试视觉模型会实际发送一张程序生成的小型测试图，确认图片输入和 JSON 输出均可用；文本模型测试会验证 OCR 纠错 JSON。

连接测试只验证接口、图片输入与 JSON 输出。正式页面比测试图复杂得多，Qwen 分析通常需要 2–5 分钟。建议使用百炼控制台为北京或新加坡业务空间提供的 Workspace 专属 Base URL，以获得更稳定的推理连接。

Key 仅保存在当前浏览器页面内存中并随本次请求发送给本地服务，不写入源码、浏览器存储、日志或导出文件。关闭增强时所有处理均在本机完成。自定义 Base URL 必须使用 HTTPS；只有 `localhost`、`127.0.0.1` 和 `::1` 可使用 HTTP。

### 推荐配置

| 用途 | 服务商 | Base URL | 模型 |
| --- | --- | --- | --- |
| 视觉分层 | OpenAI | `https://api.openai.com/v1` | `gpt-5.6` |
| 视觉分层 | Qwen 国际站 | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-plus` |
| 文本纠错 | DeepSeek | `https://api.deepseek.com` | `deepseek-v4-flash` |

Qwen 如已获得 Workspace 专属域名，可在设置中替换默认 Base URL。DeepSeek 当前仅用于文本后处理，不作为视觉模型。
