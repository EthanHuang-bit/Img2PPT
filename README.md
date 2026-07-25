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

## v0.2 的识别原则

- 禁止把占页面 25% 以上的实心区域直接作为背景位图回退。
- 文字框始终无填充、无线条；文字背景由独立原生形状承载。
- 字号按 OCR 字形高度和版面比例推算，并使用 PowerPoint 自动收缩作为安全边界。
- 大面积规则区域优先识别为矩形、圆角矩形、椭圆、线条或边框。
- 复杂小对象才允许作为独立 SVG；默认不会生成整页背景图。
- 每次转换都会生成 JSON 质量报告，记录大面积回退、对象类型与 OCR 字体统计。

## 自动回归

将本地测试图片放入 `upload/` 目录。该目录默认被 Git 忽略，避免把客户或项目图片提交到公开仓库。

```bash
npm run regression -- upload
```

脚本将逐张转换、用 LibreOffice 渲染 PPT、与原图比较，并输出 `output/regression/report.html`。

## API Key

当前本地转换不需要 API Key。设置页只预留可选云端增强字段，Key 仅保存在当前浏览器页面内存中，不写入源码、本地存储或导出文件。
