// ds-remotion-dashboard 宿主入口（Cordis 插件）。
// 复用 DSH 宿主服务：llm（模型）、agents（路由）、attachments（视觉输入）、webServer（HTTP API）。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Store } from './store.js'
import { Ai } from './ai.js'
import { createHandler, API_PREFIX } from './api.js'

export const name = 'ds-remotion-dashboard'
export const inject = ['llm', 'agents']

const DEFAULT_DATA_DIR = join(homedir(), '.dsh', 'ds-remotion-dashboard')
const DEFAULT_TEMPLATE_DIR = '/Users/temptrip/learn/video/ai-remotion-template'
const DEFAULT_REMOTION_DIR = '/Users/temptrip/learn/video/remotion-demo'

/** 文件兜底：取最近一次使用的 provider/model（DSH 会话缓存 modelSelection.lastUsed）。 */
function lastUsedModelFromDisk() {
  const dir = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')
  let best = null
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const rows = JSON.parse(readFileSync(join(dir, f), 'utf8'))?.record?.rows ?? {}
        const used = rows.modelSelection?.val?.lastUsed
        const at = rows.sessionListMetadata?.val?.lastPromptAt ?? 0
        if (used?.provider && used?.model && (!best || at > best.at)) best = { provider: used.provider, model: used.model, at }
      } catch { /* 跳过损坏文件 */ }
    }
  } catch { /* 目录不存在 */ }
  return best ? { provider: best.provider, model: best.model } : null
}

export function apply(ctx, config = {}) {
  const dataDir = typeof config.dataDir === 'string' && config.dataDir ? config.dataDir : DEFAULT_DATA_DIR
  const templateDir = typeof config.templateDir === 'string' && config.templateDir ? config.templateDir : DEFAULT_TEMPLATE_DIR
  const remotionDir = typeof config.remotionDir === 'string' && config.remotionDir ? config.remotionDir : DEFAULT_REMOTION_DIR
  const frameIntervalSec = Number(config.frameIntervalSec) > 0 ? Number(config.frameIntervalSec) : 1.5
  const maxFrames = Number(config.maxFrames) > 0 ? Math.round(Number(config.maxFrames)) : 6
  const defaultKeyword = typeof config.defaultKeyword === 'string' ? config.defaultKeyword : 'vibe大赏'
  const defaultTopX = Number(config.defaultTopX) > 0 ? Math.round(Number(config.defaultTopX)) : 10
  const youtubeApiKey = typeof config.youtubeApiKey === 'string' ? config.youtubeApiKey : ''
  const cookiesFromBrowser = typeof config.cookiesFromBrowser === 'string' && config.cookiesFromBrowser ? config.cookiesFromBrowser : 'chrome'
  // DirectLlm（直连模型 API，用于兜底解析/代码生成/校准）三参数，均可在 cordis.patch.yml config 覆盖
  const llmModel = typeof config.llmModel === 'string' && config.llmModel ? config.llmModel : 'kimi-k3'
  const llmBaseURL = typeof config.llmBaseURL === 'string' && config.llmBaseURL ? config.llmBaseURL : undefined
  const llmApiKey = typeof config.llmApiKey === 'string' && config.llmApiKey ? config.llmApiKey : undefined

  const store = new Store(dataDir)

  const agents = () => { try { return ctx.get('agents') } catch { return undefined } }
  const listAgents = () => { const a = agents(); try { return a?.list?.() ?? a?.roots?.() ?? [] } catch { return [] } }
  const attachments = () => { try { return ctx.get('attachments') } catch { return undefined } }

  const ai = new Ai({
    logger: ctx.logger,
    getLlm: () => {
      try { const root = ctx.get?.('root') ?? ctx.root; const l = root?.get?.('llm'); if (l?.stream) return l } catch { /* ignore */ }
      try { return ctx.get('llm') } catch { return ctx.llm }
    },
    resolveRoute: () => {
      if (config.provider && config.model) return { provider: config.provider, model: config.model }
      const live = listAgents().find((a) => a?.options?.provider && a?.options?.model)
      if (live) return { provider: live.options.provider, model: live.options.model }
      return lastUsedModelFromDisk()
    },
    attachments: attachments(),
    llmModel,
    llmBaseURL,
    llmApiKey,
  })

  const sharedDir = typeof config.sharedDir === 'string' && config.sharedDir ? config.sharedDir : join(templateDir, 'shared')

  const resolved = { dataDir, templateDir, sharedDir, remotionDir, frameIntervalSec, maxFrames, defaultKeyword, defaultTopX, youtubeApiKey, cookiesFromBrowser }

  ctx.inject(['webServer'], (web) => {
    const handler = createHandler({ store, ai, config: resolved, logger: ctx.logger })
    web.effect(() => web.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'ds-remotion-dashboard: api')
  })
}
