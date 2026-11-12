// HTTP API（前缀 /ds-remotion-dashboard）。写操作同源 + JSON；媒体（帧/MP4）流式返回。
import { createReadStream, existsSync, statSync, rmSync } from 'node:fs'
import { join, basename, extname, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { newId, now, STATUS_LABEL } from './store.js'
import { downloadVideo, extractFrames, extractSceneFrames, makeContactSheets, extractUrl, which } from './download.js'
import { generateTemplate, renderPreview, gitCommit, tsxSyntaxOk } from './settle.js'

const PREFIX = '/ds-remotion-dashboard'

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const bad = (message, status = 400) => Object.assign(new Error(message), { status })

const isLoopback = (hostname) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(String(hostname).toLowerCase())
const hostnameOf = (host) => { try { return new URL(`http://${host}`).hostname } catch { return null } }

export function sameOrigin(req) {
  const host = req.headers.host
  if (host !== undefined && !isLoopback(hostnameOf(host))) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const o = new URL(origin)
    if (o.host === host) return true
    return o.port === '' && host !== undefined && o.hostname === hostnameOf(host)
  } catch { return false }
}

async function readWrite(req, max = 512 * 1024) {
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  const bareDelete = req.method === 'DELETE' && !ct
  if (ct !== 'application/json' && !bareDelete) throw bad('请求必须为 application/json', 415)
  if (!sameOrigin(req)) throw bad('跨站请求已拒绝', 403)
  const chunks = []; let total = 0
  for await (const c of req) { total += c.length; if (total > max) throw bad('请求体过大', 413); chunks.push(c) }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  if (bareDelete) throw bad('请求必须为 application/json', 415)
  let body
  try { body = JSON.parse(text) } catch { throw bad('JSON 无效') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('请求体必须是 JSON 对象')
  return body
}

const str = (v, name, max = 2000, required = true) => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} 不能为空`); return undefined }
  if (typeof v !== 'string') throw bad(`${name} 必须是字符串`)
  return v.trim().slice(0, max)
}

/** 安全解析媒体文件路径：只允许 basename，禁止目录穿越。 */
function safeJoin(dir, name) {
  const b = basename(String(name || ''))
  if (!b || b === '.' || b === '..' || b.includes('/') || b.includes('\\')) throw bad('非法文件名', 400)
  return join(dir, b)
}

const MEDIA_TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.md': 'text/markdown; charset=utf-8', '.tsx': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8' }

/** 模版目录：shared/src/compositions/<name>。name 必须是纯目录名（无路径分隔符）。 */
function templateDirOf(config, name) {
  const raw = String(name || '')
  const b = basename(raw)
  if (!b || b === '.' || b === '..' || b !== raw || raw.includes('/') || raw.includes('\\')) throw bad('非法模版名', 400)
  return join(config.sharedDir, 'src', 'compositions', b)
}

/** 在系统文件管理器中打开目录（macOS open / Windows explorer / Linux xdg-open）。 */
function openInFileManager(dir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const plat = process.platform
    const cmd = plat === 'darwin' ? 'open' : plat === 'win32' ? 'explorer' : 'xdg-open'
    execFile(cmd, [dir], (err) => (err ? rejectPromise(err) : resolvePromise()))
  })
}

function streamFile(res, absPath) {
  if (!existsSync(absPath)) return Promise.resolve(send(res, 404, { error: 'not found' }))
  const ext = extname(absPath).toLowerCase()
  const type = MEDIA_TYPES[ext] || 'application/octet-stream'
  const size = statSync(absPath).size
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': 'no-store', 'accept-ranges': 'none' })
  const rs = createReadStream(absPath)
  return new Promise((resolve) => {
    rs.on('error', () => { try { res.destroy?.() } catch { /* noop */ } resolve() })
    rs.on('end', () => resolve())
    rs.pipe(res)
  })
}

/** 把 material 转成可展示视图（不含本地绝对路径）。 */
function viewMaterial(m) {
  if (!m) return null
  return {
    id: m.id, runId: m.runId, platform: m.platform, title: m.title, url: m.url,
    views: m.views, thumb: m.thumb, status: m.status, statusLabel: STATUS_LABEL[m.status] || m.status,
    error: m.error || null, frames: m.frames || [], createdAt: m.createdAt, updatedAt: m.updatedAt,
    parse: m.parse || null, aiConfirm: m.aiConfirm || null, review: m.review || null,
    template: m.template || null, templates: m.templates || [],
  }
}

export function createPipeline(deps) {
  const { store, ai, config, logger } = deps
  const running = new Set()
  // settle 串行化：避免并行 uniqueName 竞态（两个 settle 拿到同名目录互相覆盖）
  let settleQueue = Promise.resolve()
  const enqueueSettle = (m) => {
    const task = settleQueue.then(() => _settleImpl(m)).catch((e) => logger?.warn?.(`[remotion-dashboard] settle 队列错误: ${e?.message}`))
    settleQueue = task.then(() => {}, () => {})
    return task
  }

  const framesDirOf = (m) => join(config.dataDir, 'frames', m.id)
  const downloadDirOf = (m) => join(config.dataDir, 'downloads', m.id)

  function persist(fn) { return store.mutate(fn) }

  function collect({ url, platform }) {
    const raw = str(url, '链接', 2000)
    const u = extractUrl(raw)
    if (!u) throw bad('未找到有效链接。请粘贴视频页面地址，支持 YouTube 链接或小红书/抖音分享文案（自动提取其中的 https:// 链接）。')
    const existing = store.findMaterialByUrl(u)
    if (existing) return { material: viewMaterial(existing), duplicate: true }
    const run = { id: newId('run'), keyword: '', source: platform || 'link', topX: 1, createdAt: now() }
    const m = {
      id: newId('mat'), runId: run.id, platform: platform || 'link', title: '', url: u,
      views: null, thumb: '', localPath: '', framesDir: '', frames: [], status: 'collected',
      error: null, parse: null, aiConfirm: null, review: null, template: null,
      createdAt: now(), updatedAt: now(),
    }
    persist((d) => { d.runs.push(run); d.materials.push(m) })
    return { material: viewMaterial(m), duplicate: false }
  }

  async function parse(m) {
    if (running.has(m.id)) return
    running.add(m.id)
    try {
      persist((d) => { const mm = store.getMaterial(m.id); if (mm) { mm.status = 'downloading'; mm.updatedAt = now(); mm.error = null } })
      const dlDir = downloadDirOf(m)
      const { path, title } = await downloadVideo(m.url, dlDir, { logger, cookiesFromBrowser: config.cookiesFromBrowser })
      if (title && !m.title) persist((d) => { const mm = store.getMaterial(m.id); if (mm) mm.title = title })
      const fdir = framesDirOf(m)
      // 全片采样：场景检测帧 + 均匀补帧，覆盖整个时间轴（带真实时间戳）
      const frameList = await extractSceneFrames(path, fdir, { maxFrames: config.maxFrames || 24, logger })
      const framePaths = frameList.map((f) => join(fdir, f.name))
      // 拼成 contact sheet（视觉模型一次看全片）；gridTimes 记录每格时间戳
      let sheets = [], gridTimes = []
      try {
        const r = await makeContactSheets(frameList.map((f) => ({ ...f, path: join(fdir, f.name) })), join(fdir, '_sheets'), { logger })
        sheets = r.sheets; gridTimes = r.gridTimes
      } catch (e) { logger?.warn?.(`[remotion-dashboard] 拼图失败（退回单帧）: ${e?.message}`) }
      persist((d) => {
        const mm = store.getMaterial(m.id)
        if (mm) { mm.localPath = path; mm.framesDir = fdir; mm.frames = frameList; mm.status = 'parsing'; mm.updatedAt = now() }
      })
      const title2 = store.getMaterial(m.id)?.title || m.title
      const result = await ai.parseMaterial({ title: title2, framePaths, sheets, gridTimes })
      // 把帧按时间分配给各 segment（parse.segments[].frames = [{name, t}]）
      if (result?.segments?.length && frameList.length) {
        for (const seg of result.segments) {
          const start = parseFloat(seg.start) || 0
          const end = parseFloat(seg.end) || Infinity
          seg.frames = frameList.filter((f) => f.t >= start - 1 && f.t <= end + 1).map((f) => f.name)
          if (!seg.frames.length) seg.frames = frameList.slice(0, 2).map((f) => f.name)
        }
      }
      persist((d) => {
        const mm = store.getMaterial(m.id)
        if (mm) { mm.parse = result; mm.status = 'ai_confirm'; mm.updatedAt = now(); mm.error = null }
      })
    } catch (e) {
      logger?.warn?.(`[remotion-dashboard] parse 失败 ${m.id}: ${e?.message}`)
      persist((d) => { const mm = store.getMaterial(m.id); if (mm) { mm.status = 'failed'; mm.error = e?.message ?? String(e); mm.updatedAt = now() } })
    } finally { running.delete(m.id) }
  }

  async function confirm(m) {
    if (running.has(m.id)) return
    running.add(m.id)
    try {
      const cur = store.getMaterial(m.id)
      const framePaths = (cur?.framesDir && cur?.frames?.length) ? cur.frames.map((f) => join(cur.framesDir, f.name || f)) : []
      const result = await ai.confirm({ title: cur?.title, parse: cur?.parse, framePaths })
      persist((d) => { const mm = store.getMaterial(m.id); if (mm) { mm.aiConfirm = result; mm.status = 'human_review'; mm.updatedAt = now(); mm.error = null } })
    } catch (e) {
      logger?.warn?.(`[remotion-dashboard] confirm 失败 ${m.id}: ${e?.message}`)
      persist((d) => { const mm = store.getMaterial(m.id); if (mm) { mm.status = 'failed'; mm.error = e?.message ?? String(e); mm.updatedAt = now() } })
    } finally { running.delete(m.id) }
  }

  /** 沉淀单个模版（一个动画片段）。segComp 提供该片段的合成参数。含 AI 视觉校准闭环：生成→渲染→对比原视频→校准→重渲染。 */
  async function settleOne({ cur, name, segParse, segComp, framePaths, genLog }) {
    const tplDir = join(config.sharedDir, 'src', 'compositions', name)
    const segConfirm = { feasible: cur.aiConfirm?.feasible !== false, composition: segComp, reason: cur.aiConfirm?.reason || '' }
    let code = await ai.generateCompositionCode({ title: cur.title, parse: segParse, confirm: segConfirm, framePaths, logFile: genLog })
    // 真实 TSX 语法校验（AI 代码可能有未转义引号等错误，正则查不出，须用 esbuild 编译确认）
    if (code) {
      const syntaxErr = tsxSyntaxOk(code, config.remotionDir)
      if (syntaxErr) {
        logger?.warn?.(`[remotion-dashboard] ${name} AI 代码语法错误，回退预设：${syntaxErr.slice(0, 200)}`)
        code = null
      }
    }
    let codeSource = code ? 'ai' : 'preset'

    const writeAndRender = async (src, tag) => {
      generateTemplate({ sharedDir: config.sharedDir, name, parse: segParse, confirm: segConfirm, title: cur.title, sourceUrl: cur.url, aiCode: src, refFramePaths: framePaths })
      return renderPreview({ sharedDir: config.sharedDir, name })
    }

    let previewMp4 = '', renderFailed = false
    if (code) {
      try {
        previewMp4 = await writeAndRender(code, 'gen1')
        // —— AI 视觉校准：抽渲染帧，与原视频帧对比，找出差异并修改 ——
        const renderedDir = join(config.dataDir, 'calib-frames', name)
        try {
          const renderedFrames = await extractFrames(previewMp4, renderedDir, { intervalSec: 2, maxFrames: 3, logger })
          const renderedPaths = renderedFrames.map((f) => join(renderedDir, f.name))
          const calibrated = await ai.verifyAndCalibrate({ originalFramePaths: framePaths, renderedFramePaths: renderedPaths, currentCode: code, parse: segParse, logFile: genLog })
          if (calibrated) {
            const calErr = tsxSyntaxOk(calibrated, config.remotionDir)
            if (calErr) {
              logger?.warn?.(`[remotion-dashboard] ${name} 校准代码语法错误，保留第一版：${calErr.slice(0, 150)}`)
            } else {
              logger?.warn?.(`[remotion-dashboard] ${name} 校准后重渲染`)
              previewMp4 = await writeAndRender(calibrated, 'calibrated')
              code = calibrated
            }
          }
        } catch (e) { logger?.warn?.(`[remotion-dashboard] 校准流程跳过 ${name}: ${e?.message}`) }
      } catch (e) {
        logger?.warn?.(`[remotion-dashboard] AI 代码渲染失败，回退预设 ${name}: ${e?.message}`)
        rmSync(tplDir, { recursive: true, force: true })
        codeSource = 'preset'
        try { previewMp4 = await writeAndRender(null, 'preset') } catch (e2) { renderFailed = true; logger?.warn?.(`[remotion-dashboard] 预设渲染也失败 ${name}: ${e2?.message}`) }
      }
    } else {
      try { previewMp4 = await writeAndRender(null, 'preset') } catch (e) { renderFailed = true; logger?.warn?.(`[remotion-dashboard] 渲染失败 ${name}: ${e?.message}`) }
    }
    return {
      name, dir: tplDir, style: segParse?.style || '', animationForm: segParse?.animationForm || '',
      tags: segParse?.tags || [], useCases: [], previewMp4, commitHash: '', renderFailed, codeSource, createdAt: now(),
    }
  }

  async function _settleImpl(m) {
    if (running.has(m.id)) return
    running.add(m.id)
    try {
      const cur = store.getMaterial(m.id)
      const genLog = join(config.dataDir, 'ai-generate.log')
      // 多动画：parse.segments 有多个片段时，每个片段沉淀一个独立模版
      const segments = (cur.parse?.segments?.length ? cur.parse.segments : [{ index: 0, style: cur.parse?.style, animationForm: cur.parse?.animationForm, tags: cur.parse?.tags, description: cur.parse?.summary, frames: null }])
      const base = await uniqueName(cur)
      const templates = []
      let anyFailed = false

      for (const seg of segments) {
        const segName = segments.length > 1 ? `${base}-s${seg.index}` : base
        const segParse = {
          style: seg.style || cur.parse?.style, animationForm: seg.animationForm || cur.parse?.animationForm,
          tags: seg.tags?.length ? seg.tags : (cur.parse?.tags || []),
          summary: seg.description || cur.parse?.summary,
          animationTimeline: [],   // segment 代码聚焦该段动画，不用整体时间轴
          segments: [],
        }
        // 该片段的合成参数：时长按 segment 起止算，避免整体 keyAnimations 干扰变体分派
        const fps = cur.aiConfirm?.composition?.fps || 30
        const segDur = (parseFloat(seg.end) - parseFloat(seg.start)) > 0 ? Math.round((parseFloat(seg.end) - parseFloat(seg.start)) * fps) : (cur.aiConfirm?.composition?.durationInFrames || 180)
        const segComp = { ...(cur.aiConfirm?.composition || {}), durationInFrames: Math.min(600, Math.max(30, segDur)), keyAnimations: [] }
        const segFrames = (seg.frames?.length && cur.framesDir)
          ? seg.frames.map((f) => join(cur.framesDir, f)).filter((p) => existsSync(p))
          : (cur.framesDir && cur.frames?.length ? cur.frames.slice(0, 4).map((f) => join(cur.framesDir, f.name || f)).filter((p) => existsSync(p)) : [])
        persist((d) => { const mm = store.getMaterial(m.id); if (mm) { mm.template = { name: segName, dir: join(config.sharedDir, 'src', 'compositions', segName), status: 'generating', segmentIndex: seg.index } } })
        const tpl = await settleOne({ cur, name: segName, segParse, segComp, framePaths: segFrames, genLog })
        templates.push({ ...tpl, segmentIndex: seg.index, segmentRange: `${seg.start || ''}-${seg.end || ''}` })
        if (tpl.renderFailed) anyFailed = true
      }

      let commitHash = ''
      try { commitHash = await gitCommit(config.templateDir, `add template(s) ${templates.map((t) => t.name).join(', ')}`) } catch (e) { logger?.warn?.(`[remotion-dashboard] git 提交失败: ${e?.message}`) }
      for (const t of templates) t.commitHash = commitHash
      persist((d) => {
        const mm = store.getMaterial(m.id)
        if (mm) {
          mm.templates = templates
          mm.template = templates[0]
          mm.status = anyFailed ? 'failed' : 'settled'
          mm.error = anyFailed ? '部分模版渲染失败（源码已保留，可重试）' : null
          mm.updatedAt = now()
          for (const t of templates) d.templates.unshift(t)
        }
      })
    } catch (e) {
      logger?.warn?.(`[remotion-dashboard] settle 失败 ${m.id}: ${e?.message}`)
      persist((d) => { const mm = store.getMaterial(m.id); if (mm) { mm.status = 'failed'; mm.error = e?.message ?? String(e); mm.updatedAt = now() } })
    } finally { running.delete(m.id) }
  }

  async function uniqueName(cur) {
    let base
    try { base = await ai.suggestName(cur.parse) } catch { base = 'template' }
    base = (base || 'template').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'template'
    if (!base.startsWith('template')) base = 'template-' + base
    let name = base, i = 2
    while (store.data.templates.some((t) => t.name === name) || existsSync(join(config.sharedDir, 'src', 'compositions', name))) {
      name = `${base}-${i++}`
    }
    return name
  }

  /** 串行入口：排队执行，避免并行 settle 的 uniqueName 目录竞态。 */
  function settle(m) { return enqueueSettle(m) }

  return { collect, parse, confirm, settle, running: () => [...running], view: viewMaterial }
}

export function createHandler(deps) {
  const { store, ai, config, logger } = deps
  const pipeline = createPipeline(deps)

  const findMaterial = (id) => { const m = store.getMaterial(id); if (!m) throw bad('素材不存在', 404); return m }

  const routes = {
    'GET /status': () => {
      const tools = { ytdlp: !!which('yt-dlp'), ffmpeg: !!which('ffmpeg'), git: !!which('git') }
      return { ai: ai.status(), tools, config: { dataDir: config.dataDir, templateDir: config.templateDir, sharedDir: config.sharedDir, remotionDir: config.remotionDir, defaultKeyword: config.defaultKeyword, defaultTopX: config.defaultTopX, youtubeApiKey: !!config.youtubeApiKey }, running: pipeline.running() }
    },
    'GET /runs': () => ({ runs: store.data.runs, materials: store.listMaterials().map(viewMaterial), templates: store.listTemplates() }),
    'GET /materials': () => ({ materials: store.listMaterials().map(viewMaterial) }),
    'GET /templates': () => ({ templates: store.listTemplates() }),

    'POST /collect': (b) => pipeline.collect({ url: b.url, platform: b.platform }),

    'POST /materials/:id/parse': (b, p) => { pipeline.parse(findMaterial(p.id)); return { ok: true, status: 'downloading' } },
    'POST /materials/:id/confirm': (b, p) => { pipeline.confirm(findMaterial(p.id)); return { ok: true, status: 'ai_confirm' } },
    // 一键：解析 → AI 确认 → 停在人工确认
    'POST /materials/:id/auto': async (b, p) => {
      const m = findMaterial(p.id)
      pipeline.parse(m).then(() => { const cur = store.getMaterial(p.id); if (cur?.status === 'ai_confirm') pipeline.confirm(cur) })
      return { ok: true, status: 'downloading' }
    },

    'POST /materials/:id/review': (b, p) => {
      const m = findMaterial(p.id)
      const decision = ['pass', 'reject', 'edit'].includes(b.decision) ? b.decision : 'edit'
      const tags = Array.isArray(b.tags) ? b.tags.map(String).filter(Boolean).slice(0, 12) : undefined
      const notes = typeof b.notes === 'string' ? b.notes.slice(0, 2000) : undefined
      store.mutate((d) => {
        const mm = store.getMaterial(p.id)
        mm.review = { decision, tags: tags ?? mm.parse?.tags ?? [], notes: notes ?? mm.review?.notes ?? '', at: now() }
        if (tags) mm.parse = { ...(mm.parse || {}), tags }
        if (decision === 'pass') { mm.status = 'settling'; mm.updatedAt = now() }
        else if (decision === 'reject') { mm.status = 'rejected'; mm.updatedAt = now() }
      })
      if (decision === 'pass') pipeline.settle(store.getMaterial(p.id))
      return { ok: true, material: viewMaterial(store.getMaterial(p.id)) }
    },

    'POST /materials/:id/retry': (b, p) => {
      findMaterial(p.id)
      store.mutate((d) => { const mm = store.getMaterial(p.id); mm.status = 'collected'; mm.error = null; mm.updatedAt = now() })
      return { ok: true, material: viewMaterial(store.getMaterial(p.id)) }
    },
    'DELETE /materials/:id': (b, p) => {
      findMaterial(p.id)
      store.mutate((d) => { d.materials = d.materials.filter((x) => x.id !== p.id) })
      return { ok: true }
    },

    // 删除模版：从列表移除 + 删除磁盘目录 + 解绑引用它的素材（回到待人工确认，可重新沉淀）
    'DELETE /templates/:name': (b, p) => {
      const name = str(p.name, '模版名', 200)
      const dir = templateDirOf(config, name)
      if (!store.data.templates.some((t) => t.name === name)) throw bad('模版不存在', 404)
      store.mutate((d) => {
        d.templates = d.templates.filter((t) => t.name !== name)
        for (const mm of d.materials) {
          if (mm.template?.name === name) {
            mm.template = null
            if (mm.status === 'settled' || mm.status === 'failed') { mm.status = 'human_review'; mm.updatedAt = now(); mm.error = null }
          }
        }
      })
      try { rmSync(dir, { recursive: true, force: true }) } catch (e) { logger?.warn?.(`[remotion-dashboard] 删除模版目录失败 ${name}: ${e?.message}`) }
      return { ok: true }
    },

    // 在系统文件管理器中打开模版所在目录
    'POST /templates/:name/open': async (b, p) => {
      const name = str(p.name, '模版名', 200)
      const dir = templateDirOf(config, name)
      if (!store.data.templates.some((t) => t.name === name)) throw bad('模版不存在', 404)
      if (!existsSync(dir)) throw bad('模版目录不存在（可能已被移动或删除）', 404)
      try { await openInFileManager(dir) } catch (e) { throw bad(`打开文件夹失败：${e?.message ?? e}`, 500) }
      return { ok: true, dir }
    },
  }

  const compiled = Object.entries(routes).map(([key, fn]) => {
    const [method, routePath] = key.split(' ')
    const names = []
    const re = new RegExp(`^${routePath.replace(/:(\w+)/g, (_m, n) => { names.push(n); return '([^/]+)' })}$`)
    return { method, re, names, fn }
  })

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    if (!path.startsWith(PREFIX)) return send(res, 404, { error: 'not found' })

    // —— 媒体服务 ——
    if (path.startsWith(PREFIX + '/media/')) {
      const rest = path.slice(PREFIX.length + '/media/'.length)
      const seg = rest.split('/')
      try {
        if (seg[0] === 'frames' && seg.length >= 3) {
          const m = store.getMaterial(seg[1])
          if (!m?.framesDir) return send(res, 404, { error: 'not found' })
          return streamFile(res, safeJoin(m.framesDir, seg.slice(2).join('/')))
        }
        if (seg[0] === 'templates' && seg.length >= 2) {
          const name = basename(seg[1])
          if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return send(res, 400, { error: '非法模板名' })
          const rel = seg.slice(2).join('/') || 'preview.mp4'
          // 优先新结构（shared/src/compositions/<name>/），兼容旧独立目录
          const newPath = join(config.sharedDir, 'src', 'compositions', name, rel)
          if (existsSync(newPath)) return streamFile(res, newPath)
          return streamFile(res, safeJoin(join(config.templateDir, name), rel))
        }
        return send(res, 404, { error: 'not found' })
      } catch (e) { return send(res, e?.status ?? 500, { error: e?.message ?? String(e) }) }
    }

    // —— API ——
    const sub = path.slice(PREFIX.length) || '/'
    try {
      for (const r of compiled) {
        if (r.method !== req.method) continue
        const m = sub.match(r.re); if (!m) continue
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]))
        let body = {}
        if (req.method !== 'GET') body = await readWrite(req)
        return send(res, 200, await r.fn(body, params, url))
      }
      send(res, 404, { error: 'not found' })
    } catch (e) {
      logger?.warn?.(`[remotion-dashboard] ${req.method} ${sub}: ${e?.message}`)
      send(res, e?.status ?? 500, { error: e?.message ?? String(e) })
    }
  }
}

export const API_PREFIX = PREFIX
