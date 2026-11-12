// ds-remotion-dashboard 单元/集成测试（不依赖 DSH 运行时）。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'

import { Store, canTransition, validateParseResult, validateAIConfirmation } from '../lib/store.js'
import { ruleParse, ruleConfirm, extractJson, extractTsxCode, validateCompositionTsx, Ai } from '../lib/ai.js'
import { generateTemplate, variantFor } from '../lib/settle.js'
import { createHandler } from '../lib/api.js'
import { apply } from '../lib/index.js'

// ———— store ————
test('状态机迁移', () => {
  assert.equal(canTransition('collected', 'downloading'), true)
  assert.equal(canTransition('settled', 'collected'), false)
  assert.equal(canTransition('human_review', 'settling'), true)
  assert.equal(canTransition('human_review', 'rejected'), true)
})

test('Store 持久化 + URL 去重', () => {
  const d = mkdtempSync(join(tmpdir(), 'rdb-'))
  const s = new Store(d)
  s.mutate((x) => x.materials.push({ id: 'm1', url: 'https://a', status: 'collected', createdAt: 1 }))
  const s2 = new Store(d)
  assert.equal(s2.data.materials.length, 1)
  assert.equal(s2.findMaterialByUrl('https://a').id, 'm1')
  assert.equal(s2.findMaterialByUrl('https://b'), undefined)
})

// ———— ai ————
test('ruleParse / ruleConfirm / extractJson / validate', () => {
  const p = ruleParse('科技感 HUD 数据可视化标题动画')
  assert.equal(p.style, '科技感 HUD')
  const c = ruleConfirm(p)
  assert.equal(c.feasible, true)
  assert.deepEqual(extractJson('前缀 {"a":1} 后缀'), { a: 1 })
  assert.equal(extractJson('no json'), null)
  assert.equal(validateParseResult({ style: 'x', animationForm: 'y', tags: ['a'] }).style, 'x')
  assert.equal(validateAIConfirmation({ feasible: true }).composition.fps, 30)
})

test('Ai 无模型时走规则兜底', async () => {
  const ai = new Ai({ logger: undefined, getLlm: () => undefined, resolveRoute: () => null, attachments: undefined })
  const r = await ai.parseMaterial({ title: '扁平插画标题入场', framePaths: [] })
  assert.equal(r.source, 'rule')
  assert.equal(r.style, '扁平插画')
  const c = await ai.confirm({ title: 'x', parse: r, framePaths: [] })
  assert.equal(c.source, 'rule')
  assert.equal(c.feasible, true)
})

// ———— settle ————
test('generateTemplate 产出共享工程结构（纯组件 + meta.json + README + REGISTRY）', () => {
  const d = mkdtempSync(join(tmpdir(), 'rdb-tpl-'))
  mkdirSync(join(d, 'src', 'compositions'), { recursive: true })
  const parse = ruleParse('科技感 HUD 标题动画')
  const confirm = ruleConfirm(parse)
  generateTemplate({ sharedDir: d, name: 'template-demo', parse, confirm, title: '测试', sourceUrl: 'https://x' })
  const tplDir = join(d, 'src', 'compositions', 'template-demo')
  assert.ok(readFileSync(join(tplDir, 'TemplateComponent.tsx'), 'utf8').length > 0, 'TemplateComponent.tsx')
  assert.ok(readFileSync(join(tplDir, 'meta.json'), 'utf8').length > 0, 'meta.json')
  assert.ok(readFileSync(join(tplDir, 'README.md'), 'utf8').length > 0, 'README.md')
  const meta = JSON.parse(readFileSync(join(tplDir, 'meta.json'), 'utf8'))
  assert.equal(meta.id, 'template-demo')
  assert.ok(meta.defaultProps.title, 'meta 应含标题')
  // 不应生成独立工程文件
  assert.ok(!readFileSync(join(tplDir, 'TemplateComponent.tsx'), 'utf8').includes('<Composition'), '组件不应含 Composition 包装')
  // REGISTRY 已生成
  const reg = readFileSync(join(d, 'src', 'compositions', 'index.ts'), 'utf8')
  assert.ok(reg.includes('template-demo'), 'REGISTRY 应注册模版')
})

test('variantFor 按动画形式分派 + 差异化组件', () => {
  const vizConfirm = { feasible: true, composition: { durationInFrames: 180, fps: 30, width: 1920, height: 1080, keyAnimations: ['多组正弦波叠加循环动画', '频谱柱状图随波形实时变化'] } }
  const plain = { feasible: true, composition: { durationInFrames: 180, fps: 30, width: 1920, height: 1080, keyAnimations: [] } }
  assert.equal(variantFor({ style: '科技感 HUD', animationForm: '数据可视化', tags: ['科技'], summary: '波形叠加' }, vizConfirm), 'data-viz')
  assert.equal(variantFor({ style: '粒子特效', animationForm: '循环元素', tags: ['音乐'] }, plain), 'particles')
  assert.equal(variantFor({ style: '3D 渲染', animationForm: '转场动画', tags: ['产品'] }, plain), '3d')
  assert.equal(variantFor({ style: '极简排版', animationForm: '文字排版动画', tags: ['通用'] }, plain), 'typography')

  // data-viz 生成的源码必须含波形/频谱/HUD 组件，而非纯文字
  const d = mkdtempSync(join(tmpdir(), 'rdb-variant-'))
  mkdirSync(join(d, 'src', 'compositions'), { recursive: true })
  const r = generateTemplate({ sharedDir: d, name: 't', parse: { style: '科技感 HUD', animationForm: '数据可视化', tags: ['科技'], summary: 'x' }, confirm: vizConfirm, title: '傅立叶', sourceUrl: 'x' })
  assert.equal(r.variant, 'data-viz')
  const tsx = readFileSync(join(d, 'src', 'compositions', 't', 'TemplateComponent.tsx'), 'utf8')
  assert.ok(tsx.includes('WaveForm'), '应含波形组件')
  assert.ok(tsx.includes('Spectrum'), '应含频谱组件')
  assert.ok(tsx.includes('HudGrid'), '应含 HUD 网格')
  assert.ok(tsx.includes('polyline'), '波形应为 SVG polyline')
  assert.ok(!tsx.includes('ParticleField'), 'data-viz 不应含粒子组件')
})

// ———— AI 代码生成契约（纯组件） ————
test('extractTsxCode / validateCompositionTsx（纯组件契约）', () => {
  const valid = `import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { TemplateProps } from "../../lib/props";

export const TemplateComponent: React.FC<TemplateProps> = ({ title, accentFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, fps], [0, 1]);
  return <AbsoluteFill style={{ opacity }}><h1 style={{ color: accentFrom }}>{title}</h1></AbsoluteFill>;
};
`
  const code = extractTsxCode('```tsx\n' + valid + '\n```')
  assert.ok(code, '应提取围栏代码')
  assert.equal(validateCompositionTsx(code), null, '合规纯组件应通过校验')

  assert.ok(validateCompositionTsx(valid.replace('useVideoConfig', 'useVideoConfig; Math.random()')) !== null, 'Math.random 应被拒')
  assert.ok(validateCompositionTsx(valid + '\nimport _ from "lodash";') !== null, '第三方包应被拒')
  assert.ok(validateCompositionTsx(valid.replace('export const TemplateComponent', 'const TemplateComponent')) !== null, '缺 TemplateComponent 应被拒')
  assert.ok(validateCompositionTsx(valid + '\nconst x = <Composition id="MainTemplate" />;') !== null, 'Composition 包装应被拒')
  assert.ok(validateCompositionTsx(valid + '\nconst x = { defaultProps: {} };') !== null, 'defaultProps 应被拒')
  assert.equal(extractTsxCode('没有代码'), null, '无代码返回 null')
})

test('generateTemplate 使用 aiCode 时标记 codeSource=ai 且不包装', () => {
  const aiCode = `import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { TemplateProps } from "../../lib/props";

export const TemplateComponent: React.FC<TemplateProps> = ({ title }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, fps], [0, 1]);
  return <AbsoluteFill style={{ opacity }}><h1>{title}</h1></AbsoluteFill>;
};
`
  const d = mkdtempSync(join(tmpdir(), 'rdb-aicode-'))
  mkdirSync(join(d, 'src', 'compositions'), { recursive: true })
  const parse = { style: '科技感 HUD', animationForm: '数据可视化', tags: ['科技'], summary: 'x' }
  const confirm = { feasible: true, composition: { durationInFrames: 180, fps: 30, width: 1920, height: 1080, keyAnimations: ['波形'] } }
  const r = generateTemplate({ sharedDir: d, name: 't', parse, confirm, title: '测试标题', sourceUrl: 'x', aiCode })
  assert.equal(r.codeSource, 'ai')
  const tsx = readFileSync(join(d, 'src', 'compositions', 't', 'TemplateComponent.tsx'), 'utf8')
  assert.ok(tsx.includes('TemplateComponent'), '应含组件')
  assert.ok(!tsx.includes('<Composition'), '不应含包装')
  const meta = JSON.parse(readFileSync(join(d, 'src', 'compositions', 't', 'meta.json'), 'utf8'))
  assert.equal(meta.defaultProps.title, '测试标题', '标题应在 meta.json')
})

// ———— api（用假 req/res） ————
function fakeRes() {
  const r = { status: 0, headers: {}, body: '', ended: false }
  r.writeHead = (s, h) => { r.status = s; r.headers = h }
  r.end = (b) => { r.body = typeof b === 'string' ? b : ''; r.ended = true }
  return r
}
async function req(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method, url,
    headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}

function makeApi() {
  const d = mkdtempSync(join(tmpdir(), 'rdb-api-'))
  const sharedDir = join(d, 'tpl', 'shared')
  mkdirSync(join(sharedDir, 'src', 'compositions'), { recursive: true })
  const store = new Store(d)
  const ai = new Ai({ logger: undefined, getLlm: () => undefined, resolveRoute: () => null, attachments: undefined })
  const config = { dataDir: d, templateDir: join(d, 'tpl'), sharedDir, remotionDir: '/nonexistent', frameIntervalSec: 1.5, maxFrames: 6, defaultKeyword: 'x', defaultTopX: 10, youtubeApiKey: '' }
  const handler = createHandler({ store, ai, config, logger: undefined })
  return { store, handler }
}

test('GET /status + POST /collect + GET /runs', async () => {
  const { store, handler } = makeApi()
  let res = fakeRes()
  await handler(await req('GET', '/ds-remotion-dashboard/status'), res)
  assert.equal(res.status, 200)
  const status = JSON.parse(res.body)
  assert.equal(typeof status.ai.available, 'boolean')
  assert.equal(typeof status.tools.ytdlp, 'boolean')

  res = fakeRes()
  await handler(await req('POST', '/ds-remotion-dashboard/collect', { url: 'https://example.com/v1' }), res)
  const collected = JSON.parse(res.body)
  assert.equal(collected.duplicate, false)
  assert.equal(collected.material.status, 'collected')

  // 重复 URL
  res = fakeRes()
  await handler(await req('POST', '/ds-remotion-dashboard/collect', { url: 'https://example.com/v1' }), res)
  assert.equal(JSON.parse(res.body).duplicate, true)

  res = fakeRes()
  await handler(await req('GET', '/ds-remotion-dashboard/runs'), res)
  assert.equal(JSON.parse(res.body).materials.length, 1)

  // 媒体服务：不存在的素材 → 404；真实帧文件 → 200
  const m = store.data.materials[0]
  const fdir = join(store.dataDir, 'frames', m.id)
  mkdirSync(fdir, { recursive: true })
  writeFileSync(join(fdir, 'frame_001.jpg'), Buffer.from([1, 2, 3]))
  m.framesDir = fdir; m.frames = ['frame_001.jpg']
  res = fakeRes()
  await handler(await req('GET', '/ds-remotion-dashboard/media/frames/nope/..%2F..%2Fx'), res)
  assert.equal(res.status, 404)
  // 真实帧文件 → 200（用真实 Writable 承接 pipe）
  const streamRes = (() => {
    let chunks = []
    const w = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
    w.status = 0; w.headers = {}
    w.writeHead = (s, h) => { w.status = s; w.headers = h }
    return { w, getBody: () => Buffer.concat(chunks) }
  })()
  await handler(await req('GET', `/ds-remotion-dashboard/media/frames/${m.id}/frame_001.jpg`), streamRes.w)
  assert.equal(streamRes.w.status, 200)
  assert.equal(streamRes.w.headers['content-type'], 'image/jpeg')
  assert.equal(streamRes.getBody().length, 3)
})

test('DELETE /templates/:name 删除记录+磁盘目录并解绑素材；POST /templates/:name/open 校验', async () => {
  const d = mkdtempSync(join(tmpdir(), 'rdb-api-'))
  const store = new Store(d)
  const ai = new Ai({ logger: undefined, getLlm: () => undefined, resolveRoute: () => null, attachments: undefined })
  const templateDir = join(d, 'tpl')
  const sharedDir = join(templateDir, 'shared')
  mkdirSync(join(sharedDir, 'src', 'compositions'), { recursive: true })
  const config = { dataDir: d, templateDir, sharedDir, remotionDir: '/nonexistent', frameIntervalSec: 1.5, maxFrames: 6, defaultKeyword: 'x', defaultTopX: 10, youtubeApiKey: '' }
  const handler = createHandler({ store, ai, config, logger: undefined })

  // 造一个模版：磁盘目录（新结构 shared/src/compositions/） + store 记录 + 引用它的 settled 素材
  const tplDir = join(sharedDir, 'src', 'compositions', 'template-demo')
  mkdirSync(tplDir, { recursive: true })
  writeFileSync(join(tplDir, 'README.md'), '# demo')
  store.mutate((x) => {
    x.templates.push({ name: 'template-demo', dir: tplDir, style: '', animationForm: '', tags: [], useCases: [], previewMp4: '', commitHash: '', renderFailed: false, createdAt: 1 })
    x.materials.push({ id: 'mat9', url: 'https://e', status: 'settled', template: { name: 'template-demo', dir: tplDir }, createdAt: 1, updatedAt: 1 })
  })

  // 非法名：目录穿越 → 400
  let res = fakeRes()
  await handler(await req('DELETE', '/ds-remotion-dashboard/templates/..%2F..%2Fetc'), res)
  assert.equal(res.status, 400)

  // 不存在 → 404
  res = fakeRes()
  await handler(await req('DELETE', '/ds-remotion-dashboard/templates/nope'), res)
  assert.equal(res.status, 404)

  // open：不存在的模版 → 404
  res = fakeRes()
  await handler(await req('POST', '/ds-remotion-dashboard/templates/nope/open', {}), res)
  assert.equal(res.status, 404)

  // 正常删除 → 200；store 清空；素材解绑回到 human_review；磁盘目录被删
  res = fakeRes()
  await handler(await req('DELETE', '/ds-remotion-dashboard/templates/template-demo'), res)
  assert.equal(res.status, 200)
  assert.equal(store.data.templates.length, 0)
  const m = store.getMaterial('mat9')
  assert.equal(m.template, null)
  assert.equal(m.status, 'human_review')
  assert.equal(existsSync(tplDir), false)
})

test('host apply() 注册 webServer', async () => {
  const registered = []
  const web = { effect: (fn) => fn(), webServer: { register: (spec) => registered.push(spec) } }
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    get: (n) => ({ llm: { stream: async function* () {} }, agents: { list: () => [] }, attachments: null }[n]),
    root: undefined,
    inject: (deps, cb) => { if (deps[0] === 'webServer') cb(web) },
  }
  apply(ctx, { dataDir: join(tmpdir(), 'rdb-apply'), templateDir: '/tmp/x', remotionDir: '/tmp/y' })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/ds-remotion-dashboard')
  assert.equal(typeof registered[0].handler, 'function')
})

// ———— 端到端（规则模式，跳过真实下载/渲染）：collect → review(pass) 会触发 settle，但 remotionDir 不存在应标 failed 且保留源码 ————
test('review pass 触发 settle，源码保留且模板入列表', async () => {
  const { store, handler } = makeApi()
  // 直接注入一个已解析的 material，绕过下载
  store.mutate((d) => d.materials.push({
    id: 'mat1', runId: 'run1', platform: 'link', title: '测试视频', url: 'https://example.com/v1',
    views: null, thumb: '', localPath: '', framesDir: '', frames: [], status: 'human_review',
    error: null, parse: ruleParse('扁平插画标题入场'), aiConfirm: ruleConfirm(ruleParse('扁平插画标题入场')),
    review: null, template: null, createdAt: 1, updatedAt: 1,
  }))
  const res = fakeRes()
  await handler(await req('POST', '/ds-remotion-dashboard/materials/mat1/review', { decision: 'pass' }), res)
  assert.equal(res.status, 200)
  // settle 是后台任务，等待其完成
  await new Promise((r) => setTimeout(r, 500))
  const m = store.getMaterial('mat1')
  // remotionDir 不存在 → 渲染失败，但源码已生成、模板已入库
  assert.ok(m.template, '应生成 template 记录')
  assert.ok(m.template.name)
})
