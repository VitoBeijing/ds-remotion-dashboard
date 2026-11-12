// AI 能力：复用 DSH 宿主 llm 服务（含视觉模型）。模型不可用时全部有规则兜底，不阻塞链路。
// 视觉输入走宿主 attachments 服务：saveImage → ImageAttachmentRef → content block { type:'image', attachment }。
import { readFile, appendFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { validateParseResult, validateAIConfirmation } from './store.js'

const DEFAULT_GEN_LOG = join(homedir(), '.dsh', 'ds-remotion-dashboard', 'ai-generate.log')
const DEFAULT_LLM_BASE_URL = 'http://ada-cli-golang.ctripcorp.com'

/** 从 ~/.dsh/.credentials.yaml 读 KIRO_CLAUDE_API_KEY（简单 regex，不引 yaml 库）。 */
function readApiKey() {
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    return text.match(/KIRO_CLAUDE_API_KEY:\s*(\S+)/)?.[1] || null
  } catch { return null }
}

/** 直接 HTTP 调用模型 API（anthropic-messages，thinking disabled）。绕过 DSH stream 的推理模型 thinking 问题。 */
async function directLlmComplete({ baseURL, apiKey, model, system, content, maxTokens, timeoutMs, logger }) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort('timeout'), timeoutMs)
  try {
    const res = await fetch(`${baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, thinking: { type: 'disabled' }, messages: [{ role: 'user', content }] }),
      signal: ac.signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`模型 API ${res.status}：${JSON.stringify(data?.error || data).slice(0, 200)}`)
    return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
  } finally { clearTimeout(timer) }
}

export const PARSE_SYSTEM = `你是一位 Remotion 动画模版分析专家。给你的是这段视频的「带时间戳采样拼图」——每张拼图由多格画面组成，每格左下角标注了它在视频中的时间（秒），所有格子合起来覆盖整段视频的时间轴。请你基于这些画面，分析视频里的所有动画。

任务：
1. 通览所有画面，识别视频里出现的**所有不同动画片段**（如片头标题入场、数据可视化、图标动效、转场、循环背景、结尾金句等）。
2. **去重**：同一套动画（循环重复出现的、或不同时间但视觉/结构相同的片段）只保留一个 segment，在它的 start/end 里写它**首次出现的**时间区间。
3. 每个 segment 给出精确到 0.5 秒的时间区间（start/end，单位秒，可用小数），要与拼图里的时间戳对应。

只输出 JSON，不要其他文字：
{
  "style": "整体风格：扁平插画 / 3D 渲染 / 粒子特效 / 复古胶片 / 科技感 HUD / 极简排版 / 手绘涂鸦 / 其他",
  "animationForm": "覆盖全片最主要的动画形式",
  "tags": ["内容标签，3~6 个中文词"],
  "summary": "一句话概括视频视觉语言与节奏（≤80 字）",
  "segments": [
    {
      "start": "首次出现时间，秒（如 0 或 2.5）",
      "end": "结束时间，秒（如 3.5）",
      "style": "该片段风格",
      "animationForm": "标题入场 / 转场动画 / 循环元素 / 数据可视化 / 图标动效 / 文字排版动画 / 其他",
      "description": "该片段动画的具体描述：视觉元素、运动方式、配色（≤120 字，作为生成 Remotion 代码的直接依据）",
      "tags": ["该片段内容标签，2~4 个"]
    }
  ]
}
segments 要求：1~6 个，按时间排序；同一片段若在全片重复出现（循环动画）只列一次并标注首次区间；description 务必具体（元素/运动/颜色），不要空泛。`

const CONFIRM_SYSTEM = `你是一位 Remotion 可行性评审。给定解析结果与关键帧，判断能否用 Remotion（React + 帧驱动动画）复现成可复用模版，并给出合成结构。
只输出 JSON：
{
  "feasible": true 或 false,
  "reason": "可行性说明（≤150 字），feasible=false 时说明主要障碍",
  "selectedFrames": ["最能代表动画主体的帧文件名，1~4 个"],
  "composition": {
    "durationInFrames": 180,
    "fps": 30,
    "width": 1920,
    "height": 1080,
    "keyAnimations": ["建议的关键动画，2~5 条，如 标题淡入上滑 / 渐变强调条展开 / 循环脉冲点"]
  }
}`

const NAME_SYSTEM = `你是命名助手。根据解析结果给一个 Remotion 模版起一个 kebab-case 英文短名（小写字母、数字、连字符，≤40 字符），只输出名字本身，不要其他文字。`

export const GENERATE_CODE_SYSTEM = `你是一位资深 Remotion 动画工程师。给你一段视频的关键帧、风格解析和动画时间轴描述，请你直接写出可复现该动画主体形式的 Remotion **动画组件**源码（单个 .tsx 文件，只含组件，不含 Composition 包装——工程外层会统一注册）。

严格契约（违反任何一条都会导致代码被丢弃）：
1. 文件结构：
   - 顶部 import：只允许 \`from "remotion"\`、\`from "react"\`、\`from "../../lib/props"\`（TemplateProps 类型）、\`from "../../lib/anim"\`（FONT_STACK/seeded/accentText 工具，可选）。禁止 import 任何第三方包或其他路径。
   - 可以自定义子组件（波形/粒子/图形等）。
   - 最后必须导出：\`export const TemplateComponent: React.FC<TemplateProps> = (props) => { ... }\`（也可写 \`export function TemplateComponent\`）。
2. 禁止出现 <Composition、TemplateComposition、defaultProps、durationInFrames=、width=、height=、id="MainTemplate" 等包装/配置代码——这些由外层工程统一注入。
3. TemplateComponent 接收 TemplateProps：{ title?: string; subtitle?: string; bgFrom?: string; bgTo?: string; accentFrom?: string; accentTo?: string }，用这些 props 渲染标题文字与配色（标题用 {title}，配色用 accentFrom/accentTo/bgFrom/bgTo，不要硬编码别的文案）。
4. 动画必须是帧驱动的确定性动画：使用 useCurrentFrame() + interpolate()/spring()，绝对禁止 Math.random()、Date.now()、setTimeout、setInterval、requestAnimationFrame。需要伪随机时用 \`seeded(i)\`（from "../../lib/anim"）或自写同形式的确定性函数。
5. 视觉元素尽量用 SVG（波形/图表/路径）或 CSS（transform/渐变/阴影）实现，贴合关键帧里的视觉风格与配色。
6. 代码必须能通过 TypeScript 编译和 Remotion 渲染，语法完整、标签闭合、无未定义变量。根元素用 <AbsoluteFill>，背景用 bgFrom/bgTo 渐变。
7. 文案/字符串里如果含双引号（如「问就是"没什么"」），**必须转义或用 JSX 表达式**：写成 {\"问就是\\\"没什么\\\"\"} 或 \"问就是\\\"没什么\\\"\"，禁止在 JSX 属性双引号里直接再嵌双引号。
8. 只输出 tsx 代码本身（可用 \`\`\`tsx 围栏），不要解释文字。

动画描述（你必须严格按此实现动画主体，不要替换成通用文字动画）：`

/** 从模型输出里取第一个 JSON 对象。 */
export function extractJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const src = fenced ? fenced[1] : text
  const start = src.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) { try { return JSON.parse(src.slice(start, i + 1)) } catch { return null } }
  }
  return null
}

const NO_MODEL = (msg) => Object.assign(new Error(msg || 'DSH 模型不可用'), { code: 'NO_MODEL' })

export class Ai {
  /**
   * @param {object} deps
   * @param {() => any} deps.getLlm  返回带 .stream 的 llm 适配器（可空）
   * @param {() => ({provider:string, model:string}|null)} deps.resolveRoute
   * @param {{ saveImage: (data:Uint8Array, mediaType:string, name?:string) => Promise<any> } | null} deps.attachments
   * @param {any} deps.logger
   */
  constructor(deps) {
    this.deps = deps
    // DirectLlm 固定走 kiro-claude 通道的可靠视觉模型（不受用户当前选择的模型影响，避免余额不足/不支持视觉的模型导致失败）
    this.directModel = deps.llmModel || 'kimi-k3'
  }

  route() { try { return this.deps.resolveRoute() } catch { return null } }

  status() {
    const r = this.route()
    const attachments = this.deps.attachments
    return r ? { available: true, vision: !!attachments, ...r } : { available: false, vision: !!attachments }
  }

  /** 把本地图片注册为宿主附件，得到 ImageAttachmentRef。失败返回 null（走文本/规则降级）。 */
  async registerImages(paths) {
    const att = this.deps.attachments
    if (!att?.saveImage) return []
    const refs = []
    for (const p of paths ?? []) {
      try {
        const data = new Uint8Array(await readFile(p))
        const mediaType = /\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : /\.gif$/i.test(p) ? 'image/gif' : 'image/jpeg'
        const ref = await att.saveImage({ data, mediaType, name: basename(p) })
        refs.push(ref)
      } catch (e) {
        this.deps.logger?.warn?.(`[remotion-dashboard] 注册图片失败 ${p}: ${e?.message ?? e}`)
      }
    }
    return refs
  }

  async complete(system, userText, imageRefs, { timeoutMs = 90000, maxTokens = 2000, reasoningEffort } = {}) {
    const llm = this.deps.getLlm()
    const route = this.route()
    if (!llm?.stream || !route) throw NO_MODEL()
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort('timeout'), timeoutMs)
    const content = []
    for (const ref of imageRefs ?? []) content.push({ type: 'image', attachment: ref })
    if (userText) content.push({ type: 'text', text: userText })
    let text = ''
    const run = (async () => {
      const stream = llm.stream({
        provider: route.provider, model: route.model, system, maxTokens, signal: ac.signal,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        messages: [{ role: 'user', id: crypto.randomUUID(), content, source: { kind: 'user' } }],
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') text += chunk.text
        else if (chunk?.type === 'error') throw chunk.error ?? new Error('模型返回错误')
      }
      return text
    })()
    let hard
    const deadline = new Promise((_r, reject) => { hard = setTimeout(() => reject(Object.assign(new Error(`模型超过 ${Math.round(timeoutMs / 1000)} 秒未返回`), { code: 'TIMEOUT' })), timeoutMs + 500) })
    run.catch(() => {})
    try { return await Promise.race([run, deadline]) } finally { clearTimeout(timer); clearTimeout(hard) }
  }

  async json(system, userText, imageRefs, fallback, opts) {
    try {
      const out = extractJson(await this.complete(system, userText, imageRefs, opts))
      if (out) return { ...out, source: 'ai' }
      this.deps.logger?.warn?.('[remotion-dashboard] 模型输出无法解析为 JSON，使用规则兜底')
    } catch (e) {
      this.deps.logger?.warn?.(`[remotion-dashboard] 模型调用失败：${e?.message ?? e}`)
    }
    return { ...fallback(), source: 'rule' }
  }

  /** 解析视频：DSH（用户选的模型）优先；失败/规则兜底时用 DirectLlm（kimi-k3）重试，保证多动画 segments 能识别。
   * sheets: contact sheet 路径数组；gridTimes: 每张拼图里各格的时间戳（秒）。 */
  async parseMaterial({ title, framePaths, sheets = [], gridTimes = [], logFile }) {
    const rule = () => ruleParse(title)
    const user = `【视频标题】${title || '(无标题)'}\n请分析风格与动画形式，识别多个动画片段。`
    let imageRefs = []
    if (framePaths?.length) imageRefs = await this.registerImages(framePaths)
    let out = await this.json(PARSE_SYSTEM, user, imageRefs, rule, { maxTokens: 800 })
    if (out.source === 'rule' && imageRefs.length) {
      out = await this.json(PARSE_SYSTEM, user, [], rule, { maxTokens: 800 })
    }
    if (out.source === 'rule') {
      const direct = await this.directParse(title, framePaths, logFile, sheets, gridTimes)
      if (direct) out = { ...direct, source: 'ai' }
    }
    const parsed = validateParseResult(out)
    return parsed ? { ...parsed, source: out.source } : { ...rule(), source: 'rule' }
  }

  /** DirectLlm 解析（kimi-k3，thinking disabled）：DSH 失败时的兜底，保证多动画 segments 识别。
   * 优先用 contact sheets（全片采样拼图）；没有 sheets 时退回单帧。 */
  async directParse(title, framePaths, logFile, sheets = [], gridTimes = []) {
    const route = this.route()
    const apiKey = this.deps.llmApiKey || readApiKey()
    const baseURL = this.deps.llmBaseURL || DEFAULT_LLM_BASE_URL
    if (!route || !apiKey) return null
    try {
      const content = []
      const imageList = sheets.length ? sheets : (framePaths ?? []).slice(0, 4)
      for (const p of imageList) {
        try {
          const mediaType = /\.png$/i.test(p) ? 'image/png' : 'image/jpeg'
          content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: readFileSync(p).toString('base64') } })
        } catch { /* 跳过坏图 */ }
      }
      let hint
      if (sheets.length) {
        // 列出每张拼图里各格的真实时间戳（从左到右、从上到下），模型据此给出秒级区间
        const lines = gridTimes.map((ts, i) => `第 ${i + 1} 张拼图（${ts.length} 格，从左到右、从上到下）对应的时间点（秒）：${ts.join(', ')}`).join('\n')
        hint = `上面是这段视频的采样拼图，共 ${sheets.length} 张。每张拼图由多格画面组成，每格对应视频中的一个采样时间点。\n${lines}\n请通览所有格子，识别视频里所有不同的动画片段；重复/循环出现的动画只保留一个 segment。每个 segment 的 start/end 必须引用上面列出的真实时间点（秒，可用小数），不要自己编序号或猜时间。`
      } else {
        hint = `关键帧时间戳：${(framePaths ?? []).map((_, i) => `frame_${String(i + 1).padStart(3, '0')}.jpg=${(i * 1.5).toFixed(1)}s`).join(', ')}（每张图对应标注的秒数）`
      }
      content.push({ type: 'text', text: `【视频标题】${title || '(无标题)'}\n${hint}` })
      this._genLog(logFile, `directParse: ${content.length - 1} images${sheets.length ? ' (sheets)' : ''}`)
      const raw = await directLlmComplete({ baseURL, apiKey, model: this.directModel, system: PARSE_SYSTEM, content, maxTokens: 4000, timeoutMs: 180000, logger: this.deps.logger })
      this._genLog(logFile, `directParse returned ${raw.length} chars`)
      return extractJson(raw)
    } catch (e) {
      this._genLog(logFile, `directParse FAIL: ${e?.message ?? e}`)
      return null
    }
  }

  async confirm({ title, parse, framePaths, logFile }) {
    const rule = () => ruleConfirm(parse)
    const user = `【视频标题】${title || '(无标题)'}\n【解析结果】${JSON.stringify(parse, null, 1)}\n请评估 Remotion 可行性。`
    let imageRefs = []
    if (framePaths?.length) imageRefs = await this.registerImages(framePaths)
    let out = await this.json(CONFIRM_SYSTEM, user, imageRefs, rule, { maxTokens: 1000 })
    if (out.source === 'rule' && imageRefs.length) out = await this.json(CONFIRM_SYSTEM, user, [], rule, { maxTokens: 1000 })
    // DSH 失败 → DirectLlm 兜底（复用 directParse 的视觉通道，但用 CONFIRM_SYSTEM）
    if (out.source === 'rule') {
      const direct = await this.directConfirm(title, parse, framePaths, logFile)
      if (direct) out = { ...direct, source: 'ai' }
    }
    const c = validateAIConfirmation(out)
    return c ? { ...c, source: out.source } : { ...rule(), source: 'rule' }
  }

  /** DirectLlm 确认兜底（CONFIRM_SYSTEM）。 */
  async directConfirm(title, parse, framePaths, logFile) {
    const route = this.route()
    const apiKey = this.deps.llmApiKey || readApiKey()
    const baseURL = this.deps.llmBaseURL || DEFAULT_LLM_BASE_URL
    if (!route || !apiKey) return null
    try {
      const content = []
      for (const p of (framePaths ?? []).slice(0, 4)) {
        try { content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(p).toString('base64') } }) } catch { /* 跳过坏帧 */ }
      }
      content.push({ type: 'text', text: `【视频标题】${title || '(无标题)'}\n【解析结果】${JSON.stringify(parse, null, 1)}\n请评估 Remotion 可行性。` })
      const raw = await directLlmComplete({ baseURL, apiKey, model: this.directModel, system: CONFIRM_SYSTEM, content, maxTokens: 2000, timeoutMs: 120000, logger: this.deps.logger })
      this._genLog(logFile, `directConfirm returned ${raw.length} chars`)
      return extractJson(raw)
    } catch (e) {
      this._genLog(logFile, `directConfirm FAIL: ${e?.message ?? e}`)
      return null
    }
  }

  /** 生成 kebab-case 模版名；失败时用风格/动画形式转写。 */
  async suggestName(parse) {
    try {
      const name = (await this.complete(NAME_SYSTEM, JSON.stringify(parse), [], { maxTokens: 40, timeoutMs: 20000 })).trim()
      if (/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) return name
    } catch { /* fallthrough */ }
    return slugify(`${parse.style || 'template'}-${parse.animationForm || 'animation'}`)
  }

  /** 用视觉模型 + 关键帧 + 详细描述，直接生成 Composition.tsx 完整代码。失败返回 null（走回退）。 */
  async generateCompositionCode({ title, parse, confirm, framePaths, logFile }) {
    const route = this.route()
    if (!route) { this._genLog(logFile, 'NO_ROUTE'); return null }
    const desc = [
      `【视频标题】${title || '(无标题)'}`,
      `【风格】${parse?.style || ''} · 【动画形式】${parse?.animationForm || ''}`,
      `【摘要】${parse?.summary || ''}`,
      parse?.animationTimeline?.length ? `【动画时间轴】\n${parse.animationTimeline.map((s) => `- ${s.range}: ${s.elements}｜${s.motion}｜${s.purpose}`).join('\n')}` : '',
      confirm?.composition?.keyAnimations?.length ? `【关键动画】${confirm.composition.keyAnimations.join('、')}` : '',
      `【合成参数】${confirm?.composition?.width || 1920}×${confirm?.composition?.height || 1080} · ${confirm?.composition?.fps || 30}fps · ${confirm?.composition?.durationInFrames || 180}帧`,
    ].filter(Boolean).join('\n')
    try {
      // kimi-k3 是推理模型：thinking 会耗尽 max_tokens 导致输出为空；DSH stream 的 reasoningEffort 映射有兼容问题。
      // 直接 HTTP 调用模型 API（thinking disabled），已被 curl 验证可靠。
      const apiKey = this.deps.llmApiKey || readApiKey()
      const baseURL = this.deps.llmBaseURL || DEFAULT_LLM_BASE_URL
      if (!apiKey) { this._genLog(logFile, 'FAIL: 无 API key（credentials.yaml 缺 KIRO_CLAUDE_API_KEY）'); return null }
      // 帧转 base64（不走 attachments，直接嵌入 anthropic image block）
      const content = []
      for (const p of (framePaths ?? []).slice(0, 4)) {
        try {
          const data = readFileSync(p).toString('base64')
          const mediaType = /\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : /\.gif$/i.test(p) ? 'image/gif' : 'image/jpeg'
          content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })
        } catch (e) { this._genLog(logFile, `帧读取失败 ${p}: ${e?.message}`) }
      }
      this._genLog(logFile, `direct llm: ${content.length} images, model ${this.directModel}`)
      content.push({ type: 'text', text: desc })
      const raw = await directLlmComplete({ baseURL, apiKey, model: this.directModel, system: GENERATE_CODE_SYSTEM, content, maxTokens: 10000, timeoutMs: 300000, logger: this.deps.logger })
      this._genLog(logFile, `model returned ${raw.length} chars`)
      const code = extractTsxCode(raw)
      if (!code) {
        this._genLog(logFile, 'FAIL: 无法提取 TSX（模型输出无代码围栏/无 import）')
        this._genLog(logFile, '--- raw head ---\n' + raw.slice(0, 500))
        return null
      }
      const err = validateCompositionTsx(code)
      if (err) {
        this._genLog(logFile, `FAIL: 校验失败：${err}`)
        this._genLog(logFile, '--- code head ---\n' + code.slice(0, 500))
        return null
      }
      this._genLog(logFile, `OK: ${code.length} chars`)
      return code
    } catch (e) {
      this._genLog(logFile, `FAIL: ${e?.message ?? e}`)
      return null
    }
  }

  /** AI 视觉验证 + 校准：对比原视频帧和渲染帧，输出修改后的代码；无需修改/失败返回 null。 */
  async verifyAndCalibrate({ originalFramePaths, renderedFramePaths, currentCode, parse, logFile }) {
    const route = this.route()
    if (!route) return null
    const apiKey = this.deps.llmApiKey || readApiKey()
    const baseURL = this.deps.llmBaseURL || DEFAULT_LLM_BASE_URL
    if (!apiKey) return null
    try {
      const content = []
      for (const p of (originalFramePaths ?? []).slice(0, 3)) {
        try { content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(p).toString('base64') } }) } catch { /* 跳过坏帧 */ }
      }
      for (const p of (renderedFramePaths ?? []).slice(0, 3)) {
        try { content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(p).toString('base64') } }) } catch { /* 跳过坏帧 */ }
      }
      const desc = [
        `【原始动画描述】${parse?.summary || ''}｜${parse?.style || ''} · ${parse?.animationForm || ''}`,
        `【当前代码】\n\`\`\`tsx\n${currentCode}\n\`\`\``,
        '',
        '上面图片中：前几张是「原视频」关键帧（参考目标），后几张是「当前渲染」画面。请对比找出差异并校准代码；若已足够贴近则输出 {"unchanged": true}。',
      ].join('\n')
      content.push({ type: 'text', text: desc })
      this._genLog(logFile, `calibrate: ${originalFramePaths?.length || 0} original + ${renderedFramePaths?.length || 0} rendered frames`)
      const raw = await directLlmComplete({ baseURL, apiKey, model: this.directModel, system: CALIBRATE_SYSTEM, content, maxTokens: 10000, timeoutMs: 300000, logger: this.deps.logger })
      this._genLog(logFile, `calibrate returned ${raw.length} chars`)
      if (/"\s*unchanged"\s*:\s*true/.test(raw)) { this._genLog(logFile, 'calibrate: unchanged'); return null }
      const code = extractTsxCode(raw)
      if (!code) { this._genLog(logFile, 'calibrate: 无法提取代码'); return null }
      const err = validateCompositionTsx(code)
      if (err) { this._genLog(logFile, `calibrate: 校验失败 ${err}`); return null }
      this._genLog(logFile, `calibrate: OK ${code.length} chars`)
      return code
    } catch (e) {
      this._genLog(logFile, `calibrate FAIL: ${e?.message ?? e}`)
      return null
    }
  }

  _genLog(logFile, msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    this.deps.logger?.warn?.(`[remotion-dashboard][gen] ${msg}`)
    appendFile(logFile || DEFAULT_GEN_LOG, line).catch(() => { /* 日志失败不影响主流程 */ })
  }
}

const CALIBRATE_SYSTEM = `你是一位资深 Remotion 动画质量校准工程师。给你：
1. 原视频的关键帧（参考目标，标「原视频」）
2. 当前模版渲染出来的画面帧（标「当前渲染」）
3. 当前模版的组件代码

你的任务：对比「原视频」和「当前渲染」的主体内容，找出差异，然后修改代码让渲染更贴近原视频。

对比维度（按重要性）：
- 主体视觉元素：原视频里有什么核心元素（波形/粒子/图形/文字/图表），渲染里是否缺失或形态不对
- 布局与构图：元素的位置、大小、层次关系是否一致
- 配色：主色/背景色是否贴近原视频
- 整体风格氛围：科技感/扁平/粒子等是否匹配

修改要求（严格遵守，违反则代码被丢弃）：
1. 只修改需要改的地方，保留当前代码里已经正确的部分和整体结构。
2. 输出修改后的**完整** TemplateComponent 组件代码（单个 .tsx，纯组件，无 Composition 包装）。
3. 遵守与生成时相同的契约：只 import remotion/react/../../lib/*；export const/function TemplateComponent；接收 TemplateProps（title/subtitle/bgFrom/bgTo/accentFrom/accentTo）；帧驱动动画（useCurrentFrame + interpolate/spring）；禁 Math.random/Date.now/setTimeout/setInterval/rAF；根元素 <AbsoluteFill>。
4. 如果对比后认为当前渲染已经够好、无需修改，只输出 JSON：{"unchanged": true}，不要输出代码。
5. 只输出 tsx 代码（可用 \`\`\`tsx 围栏）或上述 JSON，不要解释。

原始动画描述（校准目标）：`

/** 从模型输出提取 TSX 代码：优先 ```tsx/```jsx/```ts/``` 围栏，否则从第一个 import 开始截取。 */
export function extractTsxCode(text) {
  if (!text) return null
  const fenced = text.match(/```(?:tsx|jsx|ts|typescript)?\s*\n([\s\S]*?)```/)
  let code = fenced ? fenced[1] : null
  if (!code) {
    const start = text.search(/^import /m)
    if (start >= 0) code = text.slice(start).replace(/```[\s\S]*$/, '')
  }
  if (!code) return null
  return code.trim()
}

/** 校验生成的 TemplateComponent.tsx（纯组件）是否符合契约。返回 null=通过，否则错误描述。 */
export function validateCompositionTsx(code) {
  if (!code || typeof code !== 'string') return '代码为空'
  if (code.length < 300) return '代码过短（<300 字符），不像完整组件'
  if (code.length > 20000) return '代码过长（>20000 字符）'
  if (!/export (const|function|class) TemplateComponent/.test(code)) return '缺少 export const/function TemplateComponent'
  if (/<Composition|TemplateComposition|id=["']MainTemplate["']/.test(code)) return '不允许包含 Composition 包装/TemplateComposition（外层工程统一注册）'
  if (/defaultProps\s*[=:]|durationInFrames\s*[=:]/.test(code)) return '不允许包含 defaultProps/durationInFrames（配置由 meta.json 注入）'
  if (/Math\.random/.test(code)) return '禁止 Math.random（帧确定性要求）'
  if (/Date\.now|setTimeout|setInterval|requestAnimationFrame/.test(code)) return '禁止 Date.now/setTimeout/setInterval/rAF'
  const badImports = (code.match(/^import .* from ["']([^"']+)["']/gm) || [])
    .map((l) => l.match(/from ["']([^"']+)["']/)?.[1])
    .filter((p) => p && p !== 'remotion' && p !== 'react' && !p.startsWith('./') && !p.startsWith('../') && !p.startsWith('remotion/'))
  if (badImports.length) return `禁止 import 第三方包：${badImports.join(', ')}`
  if (!/useCurrentFrame/.test(code)) return '未使用 useCurrentFrame（动画必须帧驱动）'
  return null
}

export function slugify(s) {
  return String(s || 'template').toLowerCase().trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'template'
}

// ———————————————— 规则兜底 ————————————————
const STYLE_RULES = [
  ['扁平插画', /(扁平|插画|illustration|卡通|手绘|涂鸦)/i],
  ['3D 渲染', /(3d|三维|blender|cinema|建模|渲染)/i],
  ['粒子特效', /(粒子|particle|光效|星尘)/i],
  ['复古胶片', /(复古|胶片|retro|vhs|噪点|grain)/i],
  ['科技感 HUD', /(科技|hud|数据|界面|ui|赛博|cyber|未来)/i],
  ['极简排版', /(极简|minimal|排版|文字|typography)/i],
]
const FORM_RULES = [
  ['标题入场', /(标题|title|入场|intro|开场)/i],
  ['转场动画', /(转场|transition|切换)/i],
  ['循环元素', /(循环|loop|背景|bg|无限)/i],
  ['数据可视化', /(数据|图表|chart|数字|graph|统计)/i],
  ['图标动效', /(图标|icon|logo|标志)/i],
  ['文字排版动画', /(文字|字幕|排版|typography|kinetic)/i],
]
const TAG_RULES = [
  ['科技', /(科技|tech|ai|数码|软件)/i], ['教育', /(教育|学习|课程|教程|edu)/i],
  ['营销', /(营销|广告|推广|营销号|brand)/i], ['金融', /(金融|财经|股票|投资|币)/i],
  ['音乐', /(音乐|歌曲|mv|music|节奏)/i], ['游戏', /(游戏|game|电竞)/i],
  ['生活', /(生活|vlog|日常)/i], ['美食', /(美食|食物|烹饪|吃)/i],
]

function firstMatch(text, rules) {
  for (const [label, re] of rules) if (re.test(text)) return label
  return null
}

export function ruleParse(title) {
  const text = String(title || '')
  const tags = TAG_RULES.filter(([, re]) => re.test(text)).map(([l]) => l)
  return {
    style: firstMatch(text, STYLE_RULES) || '极简排版',
    animationForm: firstMatch(text, FORM_RULES) || '文字排版动画',
    tags: tags.length ? tags.slice(0, 6) : ['通用'],
    frameRefs: [],
    summary: '规则模式：仅依据标题生成的粗略判断，请在人工确认工作台核对关键帧后修正。',
  }
}

export function ruleConfirm(parse) {
  return {
    feasible: true,
    reason: '规则模式：默认可行，建议以「标题入场 + 循环元素」为主结构，请在人工确认阶段复核。',
    selectedFrames: [],
    composition: { durationInFrames: 180, fps: 30, width: 1920, height: 1080, keyAnimations: ['标题淡入上滑', '渐变强调条展开', '循环脉冲点'] },
  }
}
