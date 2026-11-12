// ds-remotion-dashboard 持久化 + 状态机。
// 单 JSON 文件存储（垂直切片阶段够用），目录 dataDir 下另放 frames/、downloads/ 等二进制产物。
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const MATERIAL_STATUS = [
  'collected', 'downloading', 'parsing', 'ai_confirm', 'human_review', 'settling', 'settled', 'rejected', 'failed',
]

export const STATUS_LABEL = {
  collected: '已收集', downloading: '下载中', parsing: '解析中', ai_confirm: 'AI 确认',
  human_review: '待人工确认', settling: '沉淀中', settled: '已沉淀', rejected: '已驳回', failed: '失败',
}

export function newId(prefix = '') {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 12)
}

export const now = () => Date.now()

// —— 实体 schema 校验（单元测试与入库共用） ——
export function validateParseResult(p) {
  if (!p || typeof p !== 'object') return null
  const timeline = Array.isArray(p.animationTimeline)
    ? p.animationTimeline.filter((s) => s && typeof s === 'object').slice(0, 8).map((s) => ({
      range: String(s.range ?? '').slice(0, 40),
      elements: String(s.elements ?? '').slice(0, 200),
      motion: String(s.motion ?? '').slice(0, 300),
      purpose: String(s.purpose ?? '').slice(0, 120),
    }))
    : []
  // 多动画分段：AI 识别视频里的多个动画片段
  const segments = Array.isArray(p.segments)
    ? p.segments.filter((s) => s && typeof s === 'object').slice(0, 8).map((s, i) => ({
      index: i,
      start: String(s.start ?? '').slice(0, 20),
      end: String(s.end ?? '').slice(0, 20),
      style: String(s.style ?? '').slice(0, 120),
      animationForm: String(s.animationForm ?? '').slice(0, 120),
      description: String(s.description ?? '').slice(0, 500),
      tags: Array.isArray(s.tags) ? s.tags.map(String).slice(0, 8) : [],
    }))
    : []
  const out = {
    style: typeof p.style === 'string' ? p.style.slice(0, 120) : '',
    animationForm: typeof p.animationForm === 'string' ? p.animationForm.slice(0, 120) : '',
    tags: Array.isArray(p.tags) ? p.tags.map(String).map((s) => s.slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    frameRefs: Array.isArray(p.frameRefs) ? p.frameRefs.map(String).slice(0, 24) : [],
    summary: typeof p.summary === 'string' ? p.summary.slice(0, 2000) : '',
    animationTimeline: timeline,
    segments,
    source: ['ai', 'rule'].includes(p.source) ? p.source : 'rule',
  }
  return out
}

export function validateAIConfirmation(c) {
  if (!c || typeof c !== 'object') return null
  const out = {
    feasible: c.feasible !== false,
    reason: typeof c.reason === 'string' ? c.reason.slice(0, 2000) : '',
    selectedFrames: Array.isArray(c.selectedFrames) ? c.selectedFrames.map(String).slice(0, 24) : [],
    composition: c.composition && typeof c.composition === 'object' ? {
      durationInFrames: Number.isFinite(Number(c.composition.durationInFrames)) ? Math.min(1800, Math.max(30, Math.round(Number(c.composition.durationInFrames)))) : 180,
      fps: Number.isFinite(Number(c.composition.fps)) ? Math.min(60, Math.max(10, Math.round(Number(c.composition.fps)))) : 30,
      width: Number.isFinite(Number(c.composition.width)) ? Number(c.composition.width) : 1920,
      height: Number.isFinite(Number(c.composition.height)) ? Number(c.composition.height) : 1080,
      keyAnimations: Array.isArray(c.composition.keyAnimations) ? c.composition.keyAnimations.map(String).slice(0, 12) : [],
    } : { durationInFrames: 180, fps: 30, width: 1920, height: 1080, keyAnimations: [] },
  }
  return out
}

export function validateTemplate(t) {
  if (!t || typeof t !== 'object') return null
  const out = {
    name: typeof t.name === 'string' ? t.name.slice(0, 120) : '',
    dir: typeof t.dir === 'string' ? t.dir : '',
    style: typeof t.style === 'string' ? t.style.slice(0, 120) : '',
    animationForm: typeof t.animationForm === 'string' ? t.animationForm.slice(0, 120) : '',
    tags: Array.isArray(t.tags) ? t.tags.map(String).slice(0, 12) : [],
    useCases: Array.isArray(t.useCases) ? t.useCases.map(String).slice(0, 12) : [],
    previewMp4: typeof t.previewMp4 === 'string' ? t.previewMp4 : '',
    commitHash: typeof t.commitHash === 'string' ? t.commitHash : '',
    renderFailed: t.renderFailed === true,
  }
  return out
}

// —— 状态迁移表：允许的迁移目标（宽松：任何状态可进 failed/rejected，其余按主线） ——
const NEXT = {
  collected: ['downloading', 'failed', 'rejected'],
  downloading: ['parsing', 'failed'],
  parsing: ['ai_confirm', 'failed', 'human_review'],
  ai_confirm: ['human_review', 'failed'],
  human_review: ['settling', 'rejected', 'failed'],
  settling: ['settled', 'failed'],
  settled: [],
  rejected: ['collected', 'failed'],
  failed: ['collected', 'downloading'],
}

export function canTransition(from, to) {
  return (NEXT[from] ?? []).includes(to)
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'data.json')
    this.data = this._load()
    if (!Array.isArray(this.data.runs)) this.data.runs = []
    if (!Array.isArray(this.data.materials)) this.data.materials = []
    if (!Array.isArray(this.data.templates)) this.data.templates = []
  }

  _load() {
    try { return JSON.parse(readFileSync(this.file, 'utf8')) } catch { return { runs: [], materials: [], templates: [] } }
  }

  /** 原子写：先写临时文件再 rename。 */
  save() {
    const tmp = this.file + '.tmp'
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  load() { return this.data }

  mutate(fn) {
    const result = fn(this.data)
    this.save()
    return result
  }

  setStatus(material, status, error) {
    if (status === material.status) return
    if (!canTransition(material.status, status)) {
      // 降级/失败/驳回允许从任何非终态进入；否则保持宽松但记录
      if (!['failed', 'rejected'].includes(status)) return
    }
    material.status = status
    material.updatedAt = now()
    if (error) material.error = String(error).slice(0, 2000)
    if (status === 'settled') material.settledAt = now()
  }

  getMaterial(id) { return this.data.materials.find((m) => m.id === id) }

  findMaterialByUrl(url) {
    const key = String(url || '').trim()
    if (!key) return undefined
    return this.data.materials.find((m) => m.url === key)
  }

  listMaterials() {
    return [...this.data.materials].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  listTemplates() {
    return [...this.data.templates].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }
}
