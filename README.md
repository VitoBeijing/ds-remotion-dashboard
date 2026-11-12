# ds-remotion-dashboard

DSH 插件：**Remotion 动画模版库收集工作台**。在 DSH 内跑通一条 5 步流水线，把一条视频沉淀为可复用的 Remotion 模版。

```
素材收集 → AI 解析 → AI 确认 → 人工确认 → 沉淀（源码 + README + 预览 MP4）
```

## 功能

- **素材收集看板**：粘贴 YouTube / 抖音 / 小红书链接导入素材（按 URL 去重）。
- **工作流进度**：每条素材在 5 步流水线中的状态与失败原因，可一键解析+确认、重试、删除。
- **人工确认工作台**：展示关键帧 + AI 解析（风格/动画形式/内容标签）+ AI 可行性结论，支持通过 / 驳回 / 编辑标签与说明。
- **模版预览**：内嵌播放 `preview.mp4`，展示模版元数据与 README。

## 依赖

- 外部工具：`yt-dlp`、`ffmpeg`（`brew install yt-dlp ffmpeg`）。
- 渲染复用同工作区 `remotion-demo` 已安装的 Remotion CLI（v4.0.541），不重复安装。
- AI 解析/确认复用 DSH 宿主已配置的模型（视觉模型不可用时自动降级为文本 + 规则兜底）。

## 安装（开发态 link 安装）

```bash
dsh plugin --profile desktop add link:/Users/temptrip/learn/video/ds-remotion-dashboard
```

安装后重启 DSH Desktop，左侧栏出现「Remotion 模版库」入口。

## 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里可覆盖默认配置：

```yaml
- id: ds-remotion-dashboard
  name: 'ds-remotion-dashboard'
  config:
    dataDir: '/Users/temptrip/.dsh/ds-remotion-dashboard'
    templateDir: '/Users/temptrip/learn/video/ai-remotion-template'
    remotionDir: '/Users/temptrip/learn/video/remotion-demo'
    frameIntervalSec: 1.5
    maxFrames: 6
    cookiesFromBrowser: 'chrome'   # 下载视频时从哪个浏览器读 cookies（chrome/safari/edge/none）
    youtubeApiKey: ''      # 可选：YouTube Data API v3
    # —— DirectLlm（直连模型 API，用于兜底解析/AI 代码生成/校准）——
    llmModel: 'kimi-k3'            # 兜底模型（默认 kimi-k3）
    llmBaseURL: 'http://ada-cli-golang.ctripcorp.com'  # 模型 API baseURL（默认公司代理）
    llmApiKey: ''                  # 留空则从 ~/.dsh/.credentials.yaml 读 KIRO_CLAUDE_API_KEY
    # —— 强制 DSH 标准调用的模型（可选，默认跟随 DSH 模型选择器）——
    # provider: 'kiro-claude'
    # model: 'kimi-k3'
```

## 模型怎么换

插件的模型分两层：

**1. 解析/确认的首选通道** → 跟随 **DSH 模型选择器**（聊天输入框旁或设置里切换）。
选了哪个就用哪个；选视觉模型（如 kimi-k3）解析效果最好。若所选模型不可用（如余额不足），会自动切到 DirectLlm 兜底。

**2. DirectLlm（兜底解析 + AI 代码生成 + 校准）** → 上面的 `llmModel/llmBaseURL/llmApiKey` 配置。
默认固定走 kimi-k3 + 公司代理（稳定、支持视觉）。要换就改这三个配置项，比如换 deepseek 视觉模型：

```yaml
    llmModel: 'deepseek-vl2'
    llmBaseURL: 'https://api.deepseek.com'
    llmApiKey: 'sk-...'
```

改完配置后**重启 DSH Desktop** 生效。

## 沉淀产物

通过人工确认后，在 `templateDir/<template-name>/` 生成：

```
<template-name>/
├── src/index.ts          # registerRoot
├── src/Root.tsx
├── src/Composition.tsx   # 可复用动画组件（defaultProps 可换标题/配色）
├── remotion.config.ts
├── tsconfig.json
├── package.json
├── preview.mp4           # 渲染产物
└── README.md
```

并 `git commit --no-verify` 到 `templateDir` 仓库（本地邮箱 `hanxiao_do@126.com`）。

## 架构

详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 测试

```bash
node --test test/*.test.js
```
