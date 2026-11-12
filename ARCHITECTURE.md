# ds-remotion-dashboard 技术架构方案

> Remotion 动画模版库收集工作台（DSH 插件）—— 技术架构设计
>
> 目标：在 DSH 内构建一条 5 步流水线（收集 → 解析 → AI 确认 → 人工确认 → 沉淀），
> 首个交付为端到端垂直切片：1 条视频 → 1 个可复用 Remotion 模版 + README + 预览 MP4。

---

## 1. 结论摘要（TL;DR）

- **形态**：一个 DSH 插件包（Cordis），`host 插件（服务端）+ client 插件（Web UI）` 两部分，源码放在独立目录
  `<./ds-remotion-dashboard/>`（与本仓库的 `remotion-demo`、`ai-remotion-template` 并列）。
- **集成方式**：完全复用 DSH 已装插件生态，不另配密钥、不另起服务。
  - Host：注入宿主服务 `llm` / `agents` / `attachments` / `webServer`，通过 `webServer.register` 暴露 HTTP API。
  - Client：通过 `slots` / `layout` 服务在左侧栏注册入口 + 主区域面板，纯 React hyperscript（复用 DSH 的 React，不二次打包）。
- **模型复用**：调用 `ctx.get('llm').stream(...)`；provider/model 从 `agents` 服务或磁盘会话缓存自动解析；视觉输入走 `attachments.saveImage` 得到 `ImageAttachmentRef` 后作为 `image` content block 传入。
- **持久化**：本地 JSON（`~/.dsh/ds-remotion-dashboard/`），垂直切片阶段够用；状态机驱动工作流进度。
- **沉淀产物**：写入已有 git 仓库 `<./ai-remotion-template/>`，渲染复用 `remotion-demo` 已装的 Remotion CLI（v4.0.541）。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        DSH Desktop (host)                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │   ds-remotion-dashboard  host 插件 (Cordis)            │  │
│  │                                                        │  │
│  │  inject: llm, agents, attachments, webServer           │  │
│  │                                                        │  │
│  │  store.js   ── JSON 持久化 + 状态机                    │  │
│  │  download.js ── yt-dlp 下载 + ffmpeg 抽帧              │  │
│  │  ai.js      ── 视觉/文本模型：解析 + AI 确认 (+规则兜底)│  │
│  │  settle.js  ── Remotion 模版生成 + 渲染 + git commit   │  │
│  │  api.js     ── webServer HTTP API + 静态媒体 (帧/MP4)  │  │
│  └───────────────────────┬───────────────────────────────┘  │
│                          │  webServer.register(prefix)       │
└──────────────────────────┼──────────────────────────────────┘
                           │ HTTP (同源，相对路径)
┌──────────────────────────┼──────────────────────────────────┐
│   DSH Web GUI (client)   │                                   │
│  ┌───────────────────────▼────────────────────────────────┐  │
│  │   ds-remotion-dashboard  client 插件 (slots/layout)     │  │
│  │   4 个看板：素材收集 / 工作流进度 / 人工确认 / 模版预览 │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
        下载/抽帧/渲染产物写入：
        ~/.dsh/ds-remotion-dashboard/   (data + frames + downloads)
        <workspace>/ai-remotion-template/  (git 仓库，沉淀模版)
```

---

## 3. 关键 SDK 事实（反向工程结论）

> 均以已安装的 `@deepseek-ai/dsh@0.1.0-rc.7`（全局）及其 `node_modules` 里的
> `@deepseek-ai/cordis@4.0.1`、`dsh-llm`、`dsh-attachment`、`dsh-adhd-workbench`
> / `dsh-ielts-dashboard`（用户已装的两份 link 插件，作为最佳参考实现）为准。

### 3.1 插件包结构（package.json）

```jsonc
{
  "name": "ds-remotion-dashboard",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./client/index.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // ← 关键：声明 bundle patch，安装时自动挂载
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime"]
    }
  }
}
```

### 3.2 cordis.patch.yml（声明式挂载）

```yaml
- insert:
    - id: ds-remotion-dashboard
      name: 'ds-remotion-dashboard'
```

`dsh plugin --profile <name> add link:<path>` 会：① `pnpm add link:<path>`；② 检测到
`dsh.bundle.patch` 存在后自动把包名追加进 `package.json` 的 `dsh.profile.bundles`（见
`@deepseek-ai/dsh/lib/plugin-*.js` 的 `reconcilePlugins`）。**不要在 profile 的 cordis.patch.yml 里重复 insert。**

### 3.3 Host 插件（lib/index.js）

```js
export const name = 'ds-remotion-dashboard'
export const inject = ['llm', 'agents', 'attachments', 'webServer']
export function apply(ctx, config = {}) { /* ... */ }
```

- `ctx.get('llm')`：模型服务，`llm.stream({ provider, model, system, maxTokens, signal,
  messages:[{ role:'user', id, content:[...], source:{kind:'user'} }] })` 返回异步迭代器，
  块类型 `text-delta`（`chunk.text`）与 `error`。
- `ctx.get('agents')`：`agents.list()` 返回活动 Agent，每个带 `options.provider/model`（当前路由）。
- `ctx.get('attachments')`：`attachments.saveImage({ data: Uint8Array, mediaType:'image/jpeg', name })`
  → `ImageAttachmentRef`；视觉输入即 `content: [{ type:'image', attachment: ref }, { type:'text', text }]`。
- `ctx.inject(['webServer'], (web) => web.effect(() => web.webServer.register({ kind:'prefix',
  path:'/ds-remotion-dashboard', handler }), 'label'))`；`handler(req,res)` 是 Node http 风格。

### 3.4 Client 插件（client/index.js）

```js
window.__ModuleLoader__.load({
  id: 'ds-remotion-dashboard',
  factory(require) {
    const React = require('react')          // 复用 DSH 的 React，不打包
    // ...
    function apply(ctx) {
      ctx.inject(['layout'], (pageCtx) => pageCtx.slots.inject('main', () => {
        const offMain = pageCtx.slots.register({ name: 'main', key: PANEL_ID }, PanelPage)
        const offRow = pageCtx.slots.inject('sidebar.panellist', () =>
          pageCtx.slots.register({ name:'sidebar.panellist', id: PANEL_ID, order: 5, label: () => 'Remotion 模版库' }, SidebarIcon))
        return () => { offRow?.(); offMain?.() }
      }))
    }
    return { inject: ['slots'], apply }
  }
})
```

Client 通过相对路径 `fetch('/ds-remotion-dashboard/api/...')` 调 host API（DSH 自带代理去掉 Origin/Host 转发）。

---

## 4. 数据模型与状态机

### 4.1 实体（`store.js` 内 schema，全部 JSON 持久化）

| 实体 | 关键字段 |
|---|---|
| `CollectionRun` | id, keyword, source, topX, createdAt |
| `Material` | id, runId, platform, title, url, views, thumb, localPath, frames[], status, error, parse?, aiConfirm?, review?, template? |
| `ParseResult` | style(风格), animationForm(动画主体形式), tags[](内容标签), frameRefs[], summary |
| `AIConfirmation` | feasible, reason, selectedFrames[], composition{ durationInFrames, fps, width, height, keyAnimations[] } |
| `HumanReview` | decision(pass/reject/edit), tags[], notes |
| `Template` | name, dir, style, animationForm, tags, useCases[], previewMp4, commitHash |

### 4.2 状态机（每个 Material）

```
collected → downloading → parsing → ai_confirm → human_review → settling → settled
                 │           │           │              │
                 └───────────┴───────────┴──► failed ◄───┘
                                     human_review ──► rejected
```

迁移由各 step 方法驱动并落盘；`failed`/`rejected` 可从原位置重试（`retry`）或删除。

---

## 5. 子系统实现要点

### 5.1 步骤 1 — 收集（素材收集看板）
- 主路径：粘贴链接导入（YouTube/抖音/小红书），按 URL 去重。
- 可选：YouTube Data API v3 检索（key 与 topX 做成 config 可配，默认「vibe大赏」/10，切片阶段不强制）。

### 5.2 步骤 2 — 解析（yt-dlp + ffmpeg + 视觉模型）
- `yt-dlp` 下载到 `dataDir/downloads/`；`ffmpeg` 每 1~2s 抽一帧到 `dataDir/frames/<materialId>/`（上限 N 帧，默认 6）。
- 视觉模型（经 `attachments.saveImage` + `llm.stream`）对「标题 + 关键帧」输出结构化 ParseResult。
- **降级**：无视觉模型 / 调用失败 → 用文本模型仅凭标题生成粗略风格猜测，标记 `source:rule`，关键帧交人工看板判断，不阻塞。

### 5.3 步骤 3 — AI 确认
- 把关键帧 + ParseResult 交模型，输出 AIConfirmation（可/不可、可行性说明、合成结构：时长/fps/分辨率/关键动画）。

### 5.4 步骤 4 — 人工确认（确认工作台）
- 展示：关键帧缩略图、解析风格/动画形式/标签、AI 结论。
- 操作：通过（进入沉淀）/ 驳回（退回或丢弃）/ 编辑标签与说明。

### 5.5 步骤 5 — 沉淀（Remotion 生成 + 渲染 + git）
- 在 `<templateDir>/<template-name>/` 生成：`src/index.ts`（registerRoot）、`src/Root.tsx`、`src/Composition.tsx`
  （按解析出的风格/动画形式生成可复用组件）、`remotion.config.ts`、`tsconfig.json`、`package.json`、`README.md`。
- 渲染复用 `remotion-demo` 已装的 Remotion CLI（v4.0.541）：在模版目录内以 symlink 复用其 `node_modules`
  （`node_modules` 加入 `.gitignore`），执行 `npx remotion render src/index.ts <CompId> preview.mp4`
  （`registry=https://registry.npmjs.org/`、`npm_config_cache` 指向可写临时目录）。
- 成功后 `git add` + `git commit --no-verify`（本地邮箱 `hanxiao_do@126.com`）。

### 5.6 预览能力
- 预览页：`<video>` 播放 `preview.mp4`（host 通过 HTTP 流式返回）+ 元数据（标签/场景/示例）+ 打开源码/README 入口。

---

## 6. 端到端数据流（垂直切片）

```
粘贴链接 → POST /collect → CollectionRun + Material(collected)
  → POST /parse   → yt-dlp 下载 → ffmpeg 抽帧 → 视觉模型 ParseResult
  → POST /confirm → 模型 AIConfirmation
  → POST /review  → HumanReview(decision=pass)
  → POST /settle  → 生成 Remotion 源码 + README → 渲染 preview.mp4 → git commit → Template(settled)
  → 预览页播放
```

长耗时步骤（下载/抽帧/渲染）走**后台执行 + 客户端轮询**：step 接口立即返回并把任务丢后台，
状态写回 store，客户端每 2s 拉取 `GET /runs` 刷新进度。

---

## 7. 边界与失败处理

| 场景 | 处理 |
|---|---|
| 下载失败/私密/地域受限 | Material 标 `failed` + 原因，看板可重试/删除 |
| 宿主无视觉模型 | 降级为「抽帧缩略图 + 文本模型」，交人工判断，不阻塞 |
| yt-dlp/ffmpeg 缺失 | `GET /status` 报告 `tools` 缺失项，README 写明 `brew install` |
| Remotion 渲染失败 | 保留源码，Template 标 `render_failed` 可重试 |
| 人工驳回 | 回退「编辑解析」或「丢弃」，不进入沉淀 |
| 重复素材 | 按 URL 去重（`POST /collect` 返回已有 Material） |

---

## 8. 配置项（cordis.patch.yml config，全部可覆盖）

```yaml
- id: ds-remotion-dashboard
  name: 'ds-remotion-dashboard'
  config:
    dataDir: '/Users/temptrip/.dsh/ds-remotion-dashboard'
    templateDir: '/Users/temptrip/learn/video/ai-remotion-template'
    remotionDir: '/Users/temptrip/learn/video/remotion-demo'
    frameIntervalSec: 1.5
    maxFrames: 6
    defaultKeyword: 'vibe大赏'
    defaultTopX: 10
    youtubeApiKey: ''
```

---

## 9. 目录布局

```
ds-remotion-dashboard/
├── package.json           # dsh.bundle + dsh.client 声明
├── cordis.patch.yml       # insert 本插件
├── icon.svg               # 侧栏图标
├── README.md
├── ARCHITECTURE.md        # 本文档
├── lib/
│   ├── index.js           # host 入口（Cordis apply）
│   ├── store.js           # JSON 持久化 + 状态机
│   ├── ai.js              # llm/视觉模型调用 + 规则兜底
│   ├── download.js        # yt-dlp + ffmpeg
│   ├── settle.js          # Remotion 生成/渲染/git
│   └── api.js             # HTTP API + 媒体服务
└── client/
    └── index.js           # 4 看板 Web UI
```

---

## 10. 里程碑与验收

1. 插件骨架 + SDK 打通 + 最小可运行页 + 宿主模型调用（风险最高，先做）。
2. 数据模型 + 持久化 + 状态机。
3. 收集看板 → 解析 → AI 确认 → 人工确认 → 沉淀 → 预览。
4. 端到端联调：1 条视频跑通，`ai-remotion-template` 出现模版目录 + `preview.mp4`（ffprobe 校验 h264/分辨率/时长）。

**验收标准**：插件在 DSH Web GUI 出现入口页；4 个 UI 能力齐备；整条链路跑通一次；
AI 解析/确认复用宿主模型（不另配密钥）。
