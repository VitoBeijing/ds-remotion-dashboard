/* ds-remotion-dashboard 前端：纯 JS，React 由 DSH 模块加载器提供（不打包第二份 React）。 */
window.__ModuleLoader__.load({
  id: 'ds-remotion-dashboard',
  factory(require) {
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback, Fragment } = React
    const API = '/ds-remotion-dashboard'

    // ———————————————— 工具 ————————————————
    async function api(method, path, body) {
      const write = method !== 'GET'
      const res = await fetch(API + path, { method, headers: write ? { 'content-type': 'application/json' } : {}, body: write ? JSON.stringify(body ?? {}) : undefined })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`)
      return data
    }
    const cx = (...xs) => xs.filter(Boolean).join(' ')
    const frameUrl = (id, f) => `${API}/media/frames/${id}/${f}`
    const previewUrl = (name) => `${API}/media/templates/${name}/preview.mp4`
    const readmeUrl = (name) => `${API}/media/templates/${name}/README.md`

    const STATUS_COLOR = { collected: 'muted', downloading: 'info', parsing: 'info', ai_confirm: 'warn', human_review: 'warn', settling: 'info', settled: 'ok', rejected: 'bad', failed: 'bad' }

    // ———————————————— 状态保持（模块级，切页不丢） ————————————————
    const mem = new Map()
    function useKept(key, init) {
      if (!mem.has(key)) mem.set(key, typeof init === 'function' ? init() : init)
      const [v, setV] = useState(() => mem.get(key))
      return [v, (n) => { const nv = typeof n === 'function' ? n(mem.get(key)) : n; mem.set(key, nv); setV(nv) }]
    }

    function useToast() {
      const [toast, setToast] = useState(null)
      const notify = useCallback((text, err) => { setToast({ text, err }); setTimeout(() => setToast(null), err ? 5000 : 2600) }, [])
      return [toast, notify]
    }

    function Badge({ status, label }) {
      return h('span', { className: cx('badge', STATUS_COLOR[status] || 'muted') }, label || status)
    }

    // ———————————————— 素材收集看板 ————————————————
    function CollectBoard({ notify, onAdded }) {
      const [url, setUrl] = useKept('collect.url', '')
      const [busy, setBusy] = useState(false)
      const submit = async (e) => {
        e?.preventDefault()
        const u = url.trim()
        if (!u) return notify('请粘贴视频链接', true)
        setBusy(true)
        try {
          const r = await api('POST', '/collect', { url: u })
          if (r.duplicate) notify('该链接已存在，跳过重复')
          else notify(`已导入素材 #${r.material.id.slice(-6)}`)
          setUrl(''); onAdded?.()
        } catch (err) { notify(err.message, true) } finally { setBusy(false) }
      }
      return h('div', { className: 'card' },
        h('h3', null, '导入视频素材'),
        h('p', { className: 'muted' }, '粘贴 YouTube / 抖音 / 小红书链接，导入后进入 5 步流水线。'),
        h('form', { className: 'row', style: { marginTop: 10 }, onSubmit: submit },
          h('input', { className: 'in grow', placeholder: 'https://…', value: url, onChange: (e) => setUrl(e.target.value) }),
          h('button', { className: 'btn pri', disabled: busy || !url.trim() }, busy ? '导入中…' : '导入链接')),
        h('p', { className: 'muted', style: { marginTop: 8, fontSize: 11 } }, 'YouTube 检索（API key）为可选后续能力，本切片主路径为粘贴链接导入。'))
    }

    // ———————————————— 工作流进度 ————————————————
    function Pipeline({ materials, status, reload, notify }) {
      if (!materials) return h('p', { className: 'muted' }, '加载中…')
      if (!materials.length) return h('p', { className: 'muted' }, '还没有素材。先在「素材收集」里导入一条视频。')
      const act = async (m, op) => {
        try { await api('POST', `/materials/${m.id}/${op}`, {}); notify(op === 'auto' ? '开始解析 + AI 确认…' : op === 'parse' ? '开始下载解析…' : op === 'confirm' ? '开始 AI 确认…' : '已重试'); reload() }
        catch (e) { notify(e.message, true) }
      }
      const del = async (m) => { if (!confirm(`删除素材「${m.title || m.id}」？`)) return; try { await api('DELETE', `/materials/${m.id}`); notify('已删除'); reload() } catch (e) { notify(e.message, true) } }
      const STEP = { collected: '1 收集', downloading: '2 下载', parsing: '2 解析', ai_confirm: '3 AI确认', human_review: '4 人工确认', settling: '5 沉淀', settled: '完成', rejected: '已驳回', failed: '失败' }
      return h('div', null,
        h('div', { className: 'row', style: { marginBottom: 10 } },
          h('p', { className: 'muted grow' }, `共 ${materials.length} 条素材`),
          h('button', { className: 'btn ghost', onClick: reload }, '刷新')),
        h('div', { className: 'group' },
          materials.map((m) => h(PipeRow, {
            key: m.id, m, running: (status?.running || []).includes(m.id), step: STEP[m.status],
            onAuto: () => act(m, 'auto'), onConfirm: () => act(m, 'confirm'), onRetry: () => act(m, 'retry'), onDel: () => del(m),
          }))))
    }

    function PipeRow({ m, running, step, onAuto, onConfirm, onRetry, onDel }) {
      return h('div', { className: cx('rowi', running && 'running') },
        h('div', { className: 'grow', style: { minWidth: 0 } },
          h('div', { className: 't' }, m.title || `素材 ${m.id.slice(-6)}`),
          h('div', { className: 'm' }, m.url.slice(0, 80), ' · ', step),
          m.error && h('div', { className: 'err' }, m.error)),
        h(Badge, { status: m.status, label: running ? '处理中…' : m.statusLabel }),
        m.status === 'collected' && h('button', { className: 'btn', onClick: onAuto }, '一键解析+确认'),
        m.status === 'ai_confirm' && h('button', { className: 'btn', onClick: onConfirm }, 'AI 确认'),
        (m.status === 'failed' || m.status === 'rejected') && h('button', { className: 'btn', onClick: onRetry }, '重试'),
        h('button', { className: 'link danger', onClick: onDel }, '删除'))
    }

    // ———————————————— 人工确认区（嵌入工作台底部） ————————————————
    function ReviewPanel({ materials, reload, notify }) {
      const pending = (materials || []).filter((m) => m.status === 'human_review')
      const [sel, setSel] = useKept('review.sel', null)
      const m = pending.find((x) => x.id === sel) || pending[0]
      useEffect(() => { if (!pending.length) setSel(null) }, [materials?.length])
      if (!pending.length) return null
      return h('div', { className: 'card', style: { marginTop: 16, borderColor: 'var(--warn)' } },
        h('div', { className: 'row' },
          h('h3', { className: 'grow' }, `人工确认（${pending.length} 条待处理）`),
          pending.length > 1 && h('span', { className: 'seg' },
            pending.map((x) => h('button', { key: x.id, className: cx(x.id === m.id && 'on'), onClick: () => setSel(x.id) }, (x.title || x.id.slice(-6)).slice(0, 12))))),
        m && h(ReviewDetail, { m, reload, notify }))
    }

    function ReviewDetail({ m, reload, notify }) {
      const [tags, setTags] = useState((m.parse?.tags || []).join(', '))
      const [notes, setNotes] = useState(m.review?.notes || '')
      const [busy, setBusy] = useState(false)
      const decision = async (d) => {
        setBusy(true)
        try {
          await api('POST', `/materials/${m.id}/review`, { decision: d, tags: tags.split(/[,，、]/).map((s) => s.trim()).filter(Boolean), notes })
          notify(d === 'pass' ? `已通过，开始沉淀 ${m.parse?.segments?.length || 1} 个动画模版…` : d === 'reject' ? '已驳回' : '已保存修改')
          reload()
        } catch (e) { notify(e.message, true) } finally { setBusy(false) }
      }
      const c = m.aiConfirm
      const segs = m.parse?.segments || []
      const frameName = (f) => (typeof f === 'string' ? f : f.name)
      return h(Fragment, null,
        h('h3', null, m.title || '未命名素材'),
        h('p', { className: 'muted' }, m.url),
        segs.length > 1 && h('div', { className: 'card', style: { borderColor: 'var(--acc)', marginBottom: 10 } },
          h('p', { style: { fontWeight: 600 } }, `识别出 ${segs.length} 个动画片段，通过后将各沉淀为一个模版`),
          segs.map((s) => h('div', { key: s.index, className: 'row', style: { marginTop: 6, alignItems: 'flex-start' } },
            h('span', { className: 'pill' }, `${s.start}-${s.end}`),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', null, h('b', null, s.animationForm || '动画'), h('span', { className: 'muted' }, ` · ${s.style || ''}`)),
              h('div', { className: 'muted', style: { fontSize: 12 } }, s.description),
              (s.frames || []).length > 0 && h('div', { className: 'frames', style: { marginTop: 4 } },
                s.frames.slice(0, 3).map((f) => h('img', { key: f, src: frameUrl(m.id, f), alt: f, loading: 'lazy', style: { maxWidth: 90 } }))))))),
        h('h4', null, '关键帧'),
        m.frames.length
          ? h('div', { className: 'frames' }, m.frames.map((f) => h('img', { key: frameName(f), src: frameUrl(m.id, frameName(f)), alt: frameName(f), loading: 'lazy' })))
          : h('p', { className: 'muted' }, '（无关键帧，解析可能降级为文本/规则）'),
        h('h4', null, 'AI 解析结果'),
        m.parse ? h('div', { className: 'card' },
          h('div', { className: 'row' }, h('b', null, '风格：'), h('span', null, m.parse.style), h('b', null, '动画形式：'), h('span', null, m.parse.animationForm)),
          h('p', { className: 'muted', style: { marginTop: 6 } }, m.parse.summary),
          h('div', { className: 'muted', style: { fontSize: 11, marginTop: 4 } }, m.parse.source === 'ai' ? '来源：AI 模型' : '来源：规则兜底（模型不可用）')) : h('p', { className: 'muted' }, '（无）'),
        h('h4', null, 'AI 可行性确认'),
        c ? h('div', { className: cx('card', c.feasible ? 'ok' : 'bad') },
          h('p', null, c.feasible ? '✓ 可 Remotion 化' : '✗ 不建议 Remotion 化'),
          h('p', { className: 'muted' }, c.reason),
          c.composition && h('p', { className: 'muted', style: { fontSize: 11 } }, `${c.composition.width}×${c.composition.height} · ${c.composition.fps}fps · ${c.composition.durationInFrames}帧 · 关键动画：${(c.composition.keyAnimations || []).join('、')}`)) : h('p', { className: 'muted' }, '（无）'),
        h('h4', null, '编辑'),
        h('label', { className: 'muted' }, '内容标签（逗号分隔）'),
        h('input', { className: 'in', style: { marginTop: 4 }, value: tags, onChange: (e) => setTags(e.target.value) }),
        h('label', { className: 'muted', style: { marginTop: 10, display: 'block' } }, '修改意见 / 说明'),
        h('textarea', { className: 'in', rows: 2, style: { marginTop: 4 }, value: notes, onChange: (e) => setNotes(e.target.value) }),
        h('div', { className: 'row', style: { marginTop: 14 } },
          h('button', { className: 'btn pri', disabled: busy, onClick: () => decision('pass') }, busy ? '处理中…' : `✓ 通过，沉淀 ${segs.length || 1} 个模版`),
          h('button', { className: 'btn', disabled: busy, onClick: () => decision('edit') }, '仅保存修改'),
          h('button', { className: 'btn ghost danger', disabled: busy, onClick: () => decision('reject') }, '驳回')))
    }

    // ———————————————— 模版预览 ————————————————
    function Templates({ templates, notify, reload }) {
      if (!templates) return h('p', { className: 'muted' }, '加载中…')
      if (!templates.length) return h('p', { className: 'muted' }, '还没有沉淀的模版。等人工确认「通过」后，模版会出现在这里。')
      return h('div', { className: 'group' },
        templates.map((t) => h(TemplateCard, { key: t.name, t, notify, reload })))
    }

    function TemplateCard({ t, notify, reload }) {
      const [readme, setReadme] = useState(null)
      const [showReadme, setShowReadme] = useState(false)
      const [busy, setBusy] = useState(false)
      const loadReadme = async () => {
        if (readme) { setShowReadme(!showReadme); return }
        try { const r = await fetch(readmeUrl(t.name)); setReadme(await r.text()); setShowReadme(true) } catch (e) { notify(e.message, true) }
      }
      const openDir = async () => {
        setBusy(true)
        try { await api('POST', `/templates/${encodeURIComponent(t.name)}/open`, {}); notify('已在文件管理器中打开') }
        catch (e) { notify(e.message, true) } finally { setBusy(false) }
      }
      const del = async () => {
        if (!confirm(`删除模版「${t.name}」？\n将同时删除磁盘目录 ${t.dir}，且不可恢复。`)) return
        setBusy(true)
        try { await api('DELETE', `/templates/${encodeURIComponent(t.name)}`); notify('已删除模版'); reload?.() }
        catch (e) { notify(e.message, true) } finally { setBusy(false) }
      }
      return h('div', { className: 'card' },
        h('div', { className: 'row' },
          h('h3', { className: 'grow' }, t.name),
          t.renderFailed ? h('span', { className: 'badge bad' }, '渲染失败') : h('span', { className: 'badge ok' }, '已沉淀'),
          t.commitHash && h('span', { className: 'muted', style: { fontSize: 11 } }, `commit ${t.commitHash.slice(0, 7)}`)),
        h('div', { className: 'row', style: { flexWrap: 'wrap', gap: 6 } },
          h('span', { className: 'muted' }, t.style), h('span', { className: 'muted' }, t.animationForm),
          (t.tags || []).map((x) => h('span', { key: x, className: 'chip' }, x))),
        t.previewMp4 && !t.renderFailed
          ? h('video', { className: 'video', controls: true, preload: 'metadata', src: previewUrl(t.name) })
          : h('p', { className: 'muted', style: { marginTop: 10 } }, t.renderFailed ? '渲染失败，源码已保留，可在进度页重试。' : '无预览。'),
        h('div', { className: 'row', style: { marginTop: 10 } },
          h('button', { className: 'btn', onClick: loadReadme }, showReadme ? '收起说明' : '查看 README'),
          h('button', { className: 'btn', disabled: busy, onClick: openDir }, '打开文件夹'),
          h('button', { className: 'link danger', disabled: busy, onClick: del }, '删除'),
          h('span', { className: 'muted grow', style: { fontSize: 11, textAlign: 'right' } }, t.dir)),
        showReadme && h('pre', { className: 'md' }, readme))
    }

    // ———————————————— 主应用 ————————————————
    function App() {
      const [tab, setTab] = useKept('app.tab', 'workbench')
      const [toast, notify] = useToast()
      const [materials, setMaterials] = useState(null)
      const [templates, setTemplates] = useState(null)
      const [status, setStatus] = useState(null)
      const reload = useCallback(async () => {
        try {
          const [runs, st] = await Promise.all([
            api('GET', '/runs').catch(() => ({ materials: [], templates: [] })),
            api('GET', '/status').catch(() => null),
          ])
          setMaterials(runs.materials); setTemplates(runs.templates); setStatus(st)
        } catch (e) { notify(e.message, true) }
      }, [notify])
      useEffect(() => { reload() }, [reload])
      // 有任务在跑时轮询
      useEffect(() => {
        const hasRunning = (status?.running || []).length > 0
        const t = setInterval(() => { if ((status?.running || []).length > 0) reload() }, 2000)
        if (!hasRunning) clearInterval(t)
        return () => clearInterval(t)
      }, [status, reload])

      const tabs = [['workbench', '工作台'], ['templates', '模版预览']]
      const aiReady = status?.ai?.available
      return h('div', { className: 'rdb' }, h('style', null, css),
        toast && h('div', { className: cx('toast', toast.err && 'err'), role: 'status' }, h('span', null, toast.text)),
        h('div', { className: 'topbar' },
          h('nav', { className: 'tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', { key: id, role: 'tab', 'aria-selected': tab === id, className: cx('tab', tab === id && 'on'), onClick: () => setTab(id) }, label))),
          h('span', { className: 'grow' }),
          status && h('span', { className: 'pill', title: aiReady ? `${status.ai.provider}/${status.ai.model}` : '模型不可用，使用规则兜底' }, aiReady ? 'AI 就绪' : '规则模式'),
          status && h('span', { className: 'pill', title: '工具状态' }, [status.tools?.ytdlp && 'yt-dlp', status.tools?.ffmpeg && 'ffmpeg', status.tools?.git && 'git'].filter(Boolean).join(' · ') || '工具缺失')),
        h('div', { className: 'page' },
          tab === 'workbench'
            ? h(Workbench, { materials, status, reload, notify })
            : h(Templates, { templates, notify, reload })))
    }

    // ———————————————— 工作台（收集 + 进度 + 人工确认 合一） ————————————————
    function Workbench({ materials, status, reload, notify }) {
      return h(Fragment, null,
        h(CollectBoard, { notify, onAdded: reload }),
        h('h4', { style: { margin: '16px 0 8px' } }, '工作流进度'),
        h(Pipeline, { materials, status, reload, notify }),
        h(ReviewPanel, { materials, reload, notify }))
    }

    function SidebarIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', 'aria-hidden': true, focusable: false },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }),
        h('path', { d: 'M6 2.5v11' }),
        h('circle', { cx: 10.5, cy: 8, r: 2 }))
    }

    const PanelPage = () => h('div', { style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' } },
      h('div', { style: { flex: 1, minHeight: 0, maxWidth: 1180, width: '100%', margin: '0 auto' } }, h(App)))

    const PANEL_ID = 'ds-remotion-dashboard'

    function apply(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['layout'], (pageCtx) => pageCtx.slots.inject('main', () => {
        const offMain = pageCtx.slots.register({ name: 'main', key: PANEL_ID }, PanelPage)
        const offRow = pageCtx.slots.inject('sidebar.panellist', () => pageCtx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => 'Remotion 模版库',
        }, SidebarIcon))
        return () => { offRow?.(); offMain?.() }
      }))
    }
    const css = `
    :root{--ink:oklch(22% .014 255);--ink-2:oklch(40% .014 255);--muted:oklch(52% .014 255);--paper:oklch(98% .007 95);--paper-2:oklch(95% .012 95);--rule:oklch(88% .013 95);--acc:oklch(55% .17 250);--acc-soft:oklch(93% .05 250);--ok:oklch(50% .13 155);--warn:oklch(50% .11 80);--bad:oklch(55% .19 25);--info:oklch(50% .12 250)}
    .rdb{height:100%;overflow:auto;padding:0 24px 40px;box-sizing:border-box;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.5;background:var(--paper)}
    .rdb *{box-sizing:border-box}
    .rdb h1,.rdb h2,.rdb h3,.rdb h4,.rdb p{margin:0}
    .topbar{display:flex;align-items:center;gap:10px;padding:14px 0;position:sticky;top:0;background:var(--paper);z-index:5}
    .tabs{display:flex;gap:2px}
    .tab{padding:7px 14px;border:0;background:transparent;color:var(--ink-2);border-radius:999px;cursor:pointer;font-size:14px}
    .tab.on{background:var(--ink);color:#fff}
    .page{max-width:960px;margin:0 auto}
    .grow{flex:1;min-width:0}
    .muted{color:var(--muted)}
    .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .card{background:#fff;border:1px solid var(--rule);border-radius:14px;padding:16px;margin-bottom:12px}
    .card.ok{border-color:var(--ok)}.card.bad{border-color:var(--bad)}
    .group{display:flex;flex-direction:column;gap:8px}
    .rowi{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border:1px solid var(--rule);border-radius:12px}
    .rowi.running{border-color:var(--acc)}
    .rowi .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .rowi .m{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .rowi .err{font-size:12px;color:var(--bad)}
    .split{display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start}
    .rail{position:sticky;top:64px;display:flex;flex-direction:column;gap:6px}
    .frames{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:8px 0}
    .frames img{width:100%;border-radius:8px;border:1px solid var(--rule)}
    .video{width:100%;max-height:360px;border-radius:12px;background:#000;margin-top:10px}
    .in{width:100%;padding:8px 10px;border:1px solid var(--rule);border-radius:10px;font:inherit;color:var(--ink);background:#fff}
    .btn{padding:7px 14px;border:1px solid var(--rule);background:#fff;border-radius:999px;cursor:pointer;font:inherit;color:var(--ink)}
    .btn:hover{border-color:var(--acc)}
    .btn.pri{background:var(--ink);color:#fff;border-color:var(--ink)}
    .btn.ghost{background:transparent}
    .btn.ghost.danger{color:var(--bad);border-color:transparent}
    .link{border:0;background:transparent;color:var(--acc);cursor:pointer;font:inherit;padding:2px}
    .link.danger{color:var(--bad)}
    .chip{display:inline-block;padding:3px 10px;border:1px solid var(--rule);border-radius:999px;font-size:12px;background:#fff;color:var(--ink-2)}
    .chip.on{background:var(--acc-soft);border-color:var(--acc);color:var(--ink)}
    .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;white-space:nowrap}
    .badge.ok{background:color-mix(in srgb,var(--ok) 16%,#fff);color:var(--ok)}
    .badge.bad{background:color-mix(in srgb,var(--bad) 12%,#fff);color:var(--bad)}
    .badge.warn{background:color-mix(in srgb,var(--warn) 14%,#fff);color:var(--warn)}
    .badge.info{background:color-mix(in srgb,var(--info) 12%,#fff);color:var(--info)}
    .badge.muted{background:var(--paper-2);color:var(--muted)}
    .pill{padding:3px 10px;border-radius:999px;font-size:12px;background:var(--paper-2);color:var(--muted)}
    .toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;z-index:100;box-shadow:0 6px 20px rgba(0,0,0,.18)}
    .toast.err{background:var(--bad)}
    .md{white-space:pre-wrap;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12px;background:var(--paper-2);border:1px solid var(--rule);border-radius:10px;padding:12px;margin-top:10px;overflow:auto;max-height:360px}
    `
    return { inject: ['slots'], apply }
  },
})

