// 沉淀：在 ai-remotion-template/shared 共享工程下生成模版（纯动画组件 + meta.json + README + refs），
// 重写 REGISTRY 注册表，渲染 preview.mp4，git commit。
// 模版不再携带独立工程（index/Root/tsconfig/package.json/remotion.config 全部共享在 shared/）。
import { mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync, copyFileSync, readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { run, which } from './download.js'

// 风格 → 配色（bgFrom/bgTo/accentFrom/accentTo）
const PALETTES = [
  [/扁平|插画|卡通|illustration/i, ['#fef3c7', '#fde68a', '#f97316', '#fbbf24']],
  [/3d|三维|渲染/i, ['#1e293b', '#0f172a', '#38bdf8', '#818cf8']],
  [/粒子|particle|光效/i, ['#0b1026', '#1b1b3a', '#a78bfa', '#f472b6']],
  [/复古|胶片|retro|vhs/i, ['#1c1917', '#0c0a09', '#f59e0b', '#ef4444']],
  [/科技|hud|cyber|数据/i, ['#020617', '#0f172a', '#22d3ee', '#3b82f6']],
  [/极简|排版|文字|minimal|typography/i, ['#f8fafc', '#e2e8f0', '#0f172a', '#334155']],
]
const DEFAULT_PALETTE = ['#0f172a', '#020617', '#38bdf8', '#818cf8']

function paletteFor(style) {
  for (const [re, p] of PALETTES) if (re.test(String(style || ''))) return p
  return DEFAULT_PALETTE
}

/** 根据解析结果选择动画结构变体。 */
export function variantFor(parse, confirm) {
  const keyAnims = (confirm?.composition?.keyAnimations || []).join(' ')
  const text = [parse?.animationForm, parse?.style, (parse?.tags || []).join(' '), keyAnims, parse?.summary].filter(Boolean).join(' ')
  if (/数据|可视化|图表|波形|频谱|统计|chart|wave|spectrum|graph|hud|dashboard/i.test(text)) return 'data-viz'
  if (/粒子|particle|光效|星尘|星云|火花/i.test(text)) return 'particles'
  if (/3d|三维|立体|旋转|建模|渲染|立方体/i.test(text)) return '3d'
  return 'typography'
}

const VARIANT_LABEL = { 'data-viz': '数据可视化', particles: '粒子特效', '3d': '3D 渲染', typography: '文字排版' }

/** 生成模版：在 sharedDir/src/compositions/<name>/ 下产出纯组件 + meta.json + README + refs，并重写 REGISTRY。 */
export function generateTemplate({ sharedDir, name, parse, confirm, title, sourceUrl, aiCode, refFramePaths }) {
  const tplDir = join(sharedDir, 'src', 'compositions', name)
  mkdirSync(tplDir, { recursive: true })
  const [bgFrom, bgTo, accentFrom, accentTo] = paletteFor(parse?.style)
  const comp = confirm?.composition || { durationInFrames: 180, fps: 30, width: 1920, height: 1080 }
  const titleText = (title || parse?.style || 'Remotion Template').slice(0, 60)
  const subtitle = `${parse?.style || '动画'} · ${parse?.animationForm || '文字排版动画'}`
  const variant = variantFor(parse, confirm)

  let componentSource, codeSource = 'preset'
  if (aiCode) {
    componentSource = aiCode.trim() + '\n'
    codeSource = 'ai'
  } else {
    componentSource = compositionTsx({ variant, comp })
  }

  writeFileSync(join(tplDir, 'TemplateComponent.tsx'), componentSource)

  const meta = {
    id: name,
    durationInFrames: comp.durationInFrames, fps: comp.fps, width: comp.width, height: comp.height,
    defaultProps: { title: titleText, subtitle, bgFrom, bgTo, accentFrom, accentTo },
  }
  writeFileSync(join(tplDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')

  // 参考帧
  const refNames = []
  if (refFramePaths?.length) {
    mkdirSync(join(tplDir, 'refs'), { recursive: true })
    for (const p of refFramePaths) {
      try {
        copyFileSync(p, join(tplDir, 'refs', basename(p)))
        refNames.push(basename(p))
      } catch { /* 单帧失败不阻塞 */ }
    }
  }

  writeFileSync(join(tplDir, 'README.md'), readme({ name, parse, confirm, title: titleText, sourceUrl, bgFrom, bgTo, accentFrom, accentTo, variant, codeSource, refNames }))
  writeRegistry(sharedDir)
  return { name, variant, codeSource, refNames, dir: tplDir }
}

/** 扫描 compositions 下所有模版目录，重写注册表 index.ts。 */
export function writeRegistry(sharedDir) {
  const compDir = join(sharedDir, 'src', 'compositions')
  const entries = []
  if (existsSync(compDir)) {
    for (const name of readdirSync(compDir).sort()) {
      const tplDir = join(compDir, name)
      if (!existsSync(join(tplDir, 'TemplateComponent.tsx')) || !existsSync(join(tplDir, 'meta.json'))) continue
      let meta
      try { meta = JSON.parse(readFileSync(join(tplDir, 'meta.json'), 'utf8')) } catch { continue }
      entries.push({ name, meta })
    }
  }
  const lines = [
    '// 模版注册表：由沉淀流程（ds-remotion-dashboard）自动重写，请勿手改。',
    "import type { ComponentType } from \"react\";",
    "import type { TemplateProps } from \"../lib/props\";",
    '',
    ...entries.map((e, i) => `import { TemplateComponent as C${i} } from "./${e.name}/TemplateComponent";`),
    '',
    'export type RegistryEntry = {',
    '  id: string;',
    '  Component: ComponentType<TemplateProps>;',
    '  durationInFrames: number;',
    '  fps: number;',
    '  width: number;',
    '  height: number;',
    '  defaultProps: TemplateProps;',
    '};',
    '',
    'export const REGISTRY: RegistryEntry[] = [',
    ...entries.map((e, i) => `  { id: ${JSON.stringify(e.name)}, Component: C${i}, durationInFrames: ${e.meta.durationInFrames}, fps: ${e.meta.fps}, width: ${e.meta.width}, height: ${e.meta.height}, defaultProps: ${JSON.stringify(e.meta.defaultProps)} },`),
    '];',
    '',
  ]
  writeFileSync(join(compDir, 'index.ts'), lines.join('\n'))
  return entries.length
}

/** 渲染 preview.mp4（在 shared 工程内）。 */
export async function renderPreview({ sharedDir, name }) {
  const bin = join(sharedDir, 'node_modules', '.bin', 'remotion')
  if (!existsSync(bin)) throw new Error(`未找到 remotion CLI：${bin}（需在 shared 下 symlink node_modules）`)
  const out = join(sharedDir, 'src', 'compositions', name, 'preview.mp4')
  await run(bin, ['render', 'src/index.ts', name, out], {
    cwd: sharedDir,
    timeoutMs: 600000,
    env: {
      ...process.env,
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      NPM_CONFIG_CACHE: join(process.env.TMPDIR || '/tmp', 'remotion-npm-cache'),
    },
  })
  if (!existsSync(out)) throw new Error('渲染完成但未找到 preview.mp4')
  return out
}

/** git 提交，返回 commit hash。 */
export async function gitCommit(repoDir, message) {
  const git = which('git')
  if (!git) throw new Error('未找到 git')
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'hanxiao_do',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'hanxiao_do@126.com',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'hanxiao_do',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'hanxiao_do@126.com',
  }
  await run(git, ['add', '-A'], { cwd: repoDir })
  const stat = await run(git, ['status', '--porcelain'], { cwd: repoDir }).catch(() => ({ stdout: '' }))
  if (!stat.stdout.trim()) {
    const head = await run(git, ['rev-parse', 'HEAD'], { cwd: repoDir }).catch(() => ({ stdout: '' }))
    return head.stdout.trim()
  }
  await run(git, ['commit', '-m', message, '--no-verify'], { cwd: repoDir, env: commitEnv })
  const head = await run(git, ['rev-parse', 'HEAD'], { cwd: repoDir })
  return head.stdout.trim()
}

/** 确保 shared 工程骨架存在（首次沉淀时自动初始化）。 */
export function ensureSharedScaffold(sharedDir) {
  mkdirSync(join(sharedDir, 'src', 'compositions'), { recursive: true })
  mkdirSync(join(sharedDir, 'src', 'lib'), { recursive: true })
  if (!existsSync(join(sharedDir, 'node_modules'))) {
    // 由调用方负责 symlink（api.js 知道 remotionDir）
  }
}

/** 用 esbuild 真实编译校验 TSX 语法（AI 生成的代码可能有未转义引号等语法错误，靠正则查不出）。返回 null=通过，否则错误描述。 */
export function tsxSyntaxOk(code, remotionDir) {
  const esbuild = join(remotionDir, 'node_modules', '.bin', 'esbuild')
  if (!existsSync(esbuild)) return 'esbuild 不可用（无法做语法校验）'
  const r = spawnSync(esbuild, ['--loader=tsx', '--jsx=automatic', '--log-level=error'], { input: code, encoding: 'utf8', timeout: 30000 })
  if (r.error) return `esbuild 运行失败：${r.error.message}`
  if (r.status !== 0) return `TSX 语法错误：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`
  return null
}

// ———————————————— 纯组件模板（不含 Composition 包装，配置由 REGISTRY/meta.json 注入） ————————————————
function componentHeader() {
  return `import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { TemplateProps } from "../../lib/props";
import { FONT_STACK, accentText } from "../../lib/anim";

`
}

function compositionTsx(ctx) {
  switch (ctx.variant) {
    case 'data-viz': return dataVizTsx(ctx)
    case 'particles': return particlesTsx(ctx)
    case '3d': return threeDTsx(ctx)
    default: return typographyTsx(ctx)
  }
}

// 数据可视化：HUD 网格 + 波形叠加 + 频谱柱状图
function dataVizTsx() {
  return `${componentHeader()}
const HudGrid: React.FC<{ accentFrom?: string }> = ({ accentFrom }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const scanY = ((frame % (fps * 3)) / (fps * 3)) * height;
  return (
    <AbsoluteFill
      style={{
        backgroundImage:
          "linear-gradient(rgba(34,211,238,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.12) 1px, transparent 1px)",
        backgroundSize: "64px 64px",
      }}
    >
      <div style={{ position: "absolute", left: 0, right: 0, top: scanY, height: 2, background: accentFrom, opacity: 0.35 }} />
    </AbsoluteFill>
  );
};

const WaveForm: React.FC<{ accentFrom?: string; accentTo?: string }> = ({ accentFrom, accentTo }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const N = 240;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const x = (i / N) * width;
    const u = x / width;
    const y = height / 2 + Math.sin(u * Math.PI * 2 * 2 + t * 2.0) * 46 + Math.sin(u * Math.PI * 2 * 3 + t * 3.4) * 28 + Math.sin(u * Math.PI * 2 * 5 + t * 5.2) * 14;
    pts.push(\`\${x.toFixed(1)},\${y.toFixed(1)}\`);
  }
  return (
    <svg width="100%" height="100%" viewBox={\`0 0 \${width} \${height}\`} style={{ position: "absolute", inset: 0 }}>
      <polyline points={pts.join(" ")} fill="none" stroke={accentFrom} strokeWidth={3} strokeLinejoin="round" />
      <polyline points={pts.join(" ")} fill="none" stroke={accentTo} strokeWidth={1} opacity={0.4} />
    </svg>
  );
};

const Spectrum: React.FC<{ accentFrom?: string; accentTo?: string }> = ({ accentFrom, accentTo }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 150 }}>
      {Array.from({ length: 36 }).map((_, i) => {
        const h = 36 + Math.abs(Math.sin(frame / (fps * 0.6) + i * 0.45)) * 108;
        return <div key={i} style={{ width: 11, height: h, borderRadius: 4, background: \`linear-gradient(180deg, \${accentFrom}, \${accentTo})\`, opacity: 0.85 }} />;
      })}
    </div>
  );
};

const Title: React.FC<TemplateProps> = ({ title, bgFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const translateY = interpolate(frame, [0, fps], [60, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return <div style={{ opacity, transform: \`translateY(\${translateY}px)\`, fontFamily: FONT_STACK, fontSize: 72, fontWeight: 800, letterSpacing: -2, textAlign: "center", color: accentText(bgFrom), textShadow: "0 0 24px rgba(34,211,238,0.35)" }}>{title}</div>;
};

const Subtitle: React.FC<TemplateProps> = ({ subtitle, bgFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [1 * fps, 2 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return <div style={{ opacity, fontFamily: FONT_STACK, fontSize: 26, fontWeight: 500, letterSpacing: 3, textAlign: "center", color: accentText(bgFrom, 0.65) }}>{subtitle}</div>;
};

export const TemplateComponent: React.FC<TemplateProps> = (props) => {
  const { title, subtitle, bgFrom, bgTo, accentFrom, accentTo } = props;
  return (
    <AbsoluteFill style={{ background: \`radial-gradient(circle at 50% 30%, \${bgFrom} 0%, \${bgTo} 100%)\`, justifyContent: "center", alignItems: "center", gap: 34, overflow: "hidden" }}>
      <HudGrid accentFrom={accentFrom} />
      <Title title={title} bgFrom={bgFrom} />
      <Subtitle subtitle={subtitle} bgFrom={bgFrom} />
      <div style={{ width: "86%", height: 260, position: "relative" }}>
        <WaveForm accentFrom={accentFrom} accentTo={accentTo} />
      </div>
      <Spectrum accentFrom={accentFrom} accentTo={accentTo} />
    </AbsoluteFill>
  );
};
`
}

// 粒子特效：确定性漂浮粒子场
function particlesTsx() {
  return `${componentHeader()}
function seeded(i: number) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const ParticleField: React.FC<{ count: number; accentFrom?: string; accentTo?: string }> = ({ count, accentFrom, accentTo }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ position: "absolute", inset: 0 }}>
      {Array.from({ length: count }).map((_, i) => {
        const speed = 0.2 + seeded(i) * 0.8;
        const drift = (frame / fps) * speed * 60;
        const x = ((seeded(i + 7) * width + drift) % width + width) % width;
        const y = ((seeded(i + 13) * height + Math.sin(frame / fps + i) * 40) % height + height) % height;
        const size = 3 + seeded(i + 3) * 8;
        const glow = 0.25 + Math.abs(Math.sin(frame / fps * 1.5 + i)) * 0.75;
        return <div key={i} style={{ position: "absolute", left: x, top: y, width: size, height: size, borderRadius: 999, background: i % 2 === 0 ? accentFrom : accentTo, opacity: glow, boxShadow: \`0 0 \${size * 2}px \${accentFrom}\` }} />;
      })}
    </AbsoluteFill>
  );
};

const Title: React.FC<TemplateProps> = ({ title, bgFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const scale = interpolate(frame, [0, fps], [0.9, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return <div style={{ opacity, transform: \`scale(\${scale})\`, fontFamily: FONT_STACK, fontSize: 110, fontWeight: 800, letterSpacing: -3, textAlign: "center", color: accentText(bgFrom) }}>{title}</div>;
};

const Subtitle: React.FC<TemplateProps> = ({ subtitle, bgFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0.8 * fps, 1.8 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return <div style={{ opacity, fontFamily: FONT_STACK, fontSize: 44, fontWeight: 500, letterSpacing: 2, textAlign: "center", color: accentText(bgFrom, 0.7) }}>{subtitle}</div>;
};

export const TemplateComponent: React.FC<TemplateProps> = (props) => {
  const { title, subtitle, bgFrom, bgTo, accentFrom, accentTo } = props;
  return (
    <AbsoluteFill style={{ background: \`radial-gradient(circle at 50% 50%, \${bgFrom} 0%, \${bgTo} 100%)\`, justifyContent: "center", alignItems: "center", gap: 40, overflow: "hidden" }}>
      <ParticleField count={70} accentFrom={accentFrom} accentTo={accentTo} />
      <Title title={title} bgFrom={bgFrom} />
      <Subtitle subtitle={subtitle} bgFrom={bgFrom} />
    </AbsoluteFill>
  );
};
`
}

// 3D：透视旋转层叠卡片
function threeDTsx() {
  return `${componentHeader()}
const RotatingCard: React.FC<{ depth: number; accentFrom?: string; accentTo?: string }> = ({ depth, accentFrom, accentTo }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rotY = (frame / fps) * 40 + depth * 18;
  const rotX = 18 + Math.sin(frame / fps) * 8;
  return (
    <div style={{ perspective: 900 }}>
      <div style={{ width: 300, height: 200, borderRadius: 20, background: \`linear-gradient(135deg, \${accentFrom}, \${accentTo})\`, opacity: 0.18 + (depth % 5) * 0.04, transform: \`rotateX(\${rotX}deg) rotateY(\${rotY}deg) translateZ(\${depth * 40}px)\`, boxShadow: "0 30px 60px rgba(0,0,0,0.5)", border: "1px solid rgba(255,255,255,0.15)" }} />
    </div>
  );
};

const Title: React.FC<TemplateProps> = ({ title, bgFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return <div style={{ opacity, fontFamily: FONT_STACK, fontSize: 90, fontWeight: 800, letterSpacing: -2, textAlign: "center", color: accentText(bgFrom) }}>{title}</div>;
};

const Subtitle: React.FC<TemplateProps> = ({ subtitle, bgFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0.8 * fps, 1.8 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return <div style={{ opacity, fontFamily: FONT_STACK, fontSize: 40, fontWeight: 500, letterSpacing: 2, textAlign: "center", color: accentText(bgFrom, 0.7) }}>{subtitle}</div>;
};

export const TemplateComponent: React.FC<TemplateProps> = (props) => {
  const { title, subtitle, bgFrom, bgTo, accentFrom, accentTo } = props;
  return (
    <AbsoluteFill style={{ background: \`radial-gradient(circle at 50% 45%, \${bgFrom} 0%, \${bgTo} 100%)\`, justifyContent: "center", alignItems: "center", gap: 46, overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", alignItems: "center" }}>
        {Array.from({ length: 6 }).map((_, i) => <RotatingCard key={i} depth={i} accentFrom={accentFrom} accentTo={accentTo} />)}
      </div>
      <Title title={title} bgFrom={bgFrom} />
      <Subtitle subtitle={subtitle} bgFrom={bgFrom} />
    </AbsoluteFill>
  );
};
`
}

// 文字排版（兜底）
function typographyTsx() {
  return `${componentHeader()}
const Background: React.FC<TemplateProps> = ({ bgFrom, bgTo }) => (
  <AbsoluteFill style={{ background: \`radial-gradient(circle at 50% 40%, \${bgFrom} 0%, \${bgTo} 100%)\` }} />
);

const Title: React.FC<TemplateProps> = ({ title, bgFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const translateY = interpolate(frame, [0, fps], [80, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const scale = interpolate(frame, [0, fps], [0.92, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return <div style={{ opacity, transform: \`translateY(\${translateY}px) scale(\${scale})\`, fontFamily: FONT_STACK, fontSize: 140, fontWeight: 800, letterSpacing: -4, textAlign: "center", color: accentText(bgFrom) }}>{title}</div>;
};

const AccentBar: React.FC<TemplateProps> = ({ accentFrom, accentTo }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const width = interpolate(frame, [0.5 * fps, 2 * fps], [0, 640], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return <div style={{ width, height: 10, borderRadius: 999, background: \`linear-gradient(90deg, \${accentFrom} 0%, \${accentTo} 100%)\` }} />;
};

const Subtitle: React.FC<TemplateProps> = ({ subtitle, bgFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [1.2 * fps, 2.2 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return <div style={{ opacity, fontFamily: FONT_STACK, fontSize: 48, fontWeight: 500, letterSpacing: 2, textAlign: "center", color: accentText(bgFrom, 0.7) }}>{subtitle}</div>;
};

const ProgressDot: React.FC<{ index: number; total: number; accentFrom?: string }> = ({ index, total, accentFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cycle = fps * 1.5;
  const phase = (frame + (index / total) * cycle) % cycle;
  const opacity = interpolate(phase, [0, cycle / 2, cycle], [0.15, 1, 0.15], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <div style={{ width: 16, height: 16, borderRadius: 999, backgroundColor: accentFrom, opacity }} />;
};

export const TemplateComponent: React.FC<TemplateProps> = (props) => {
  const { title, subtitle, bgFrom, bgTo, accentFrom, accentTo } = props;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", gap: 48 }}>
      <Background bgFrom={bgFrom} bgTo={bgTo} />
      <Title title={title} bgFrom={bgFrom} />
      <AccentBar accentFrom={accentFrom} accentTo={accentTo} />
      <Subtitle subtitle={subtitle} bgFrom={bgFrom} />
      <div style={{ display: "flex", gap: 20, marginTop: 40 }}>
        {Array.from({ length: 5 }).map((_, i) => <ProgressDot key={i} index={i} total={5} accentFrom={accentFrom} />)}
      </div>
    </AbsoluteFill>
  );
};
`
}

function readme({ name, parse, confirm, title, sourceUrl, bgFrom, bgTo, accentFrom, accentTo, variant, codeSource, refNames }) {
  const comp = confirm?.composition || { durationInFrames: 180, fps: 30, width: 1920, height: 1080 }
  const tags = (parse?.tags || []).map((t) => `\`${t}\``).join(' ') || '`通用`'
  const vLabel = codeSource === 'ai' ? 'AI 生成（参考关键帧）' : (VARIANT_LABEL[variant] || '文字排版')
  const timeline = parse?.animationTimeline?.length
    ? parse.animationTimeline.map((s) => `| ${s.range} | ${s.elements} | ${s.motion} | ${s.purpose} |`).join('\n')
    : ''
  const refs = refNames?.length
    ? `\n## 参考帧（原视频关键帧，供对照修改）\n${refNames.map((f) => `![${f}](refs/${f})`).join('\n')}\n`
    : ''
  return `# ${name}

> 由 ds-remotion-dashboard 从「${title}」沉淀的可复用 Remotion 模版（共享工程结构：组件位于 shared/src/compositions/${name}/）。

## 内容标签
${tags}

## 风格与动画形式
- 风格：${parse?.style || '未知'}
- 动画主体形式：${parse?.animationForm || '未知'}
- 模版来源：${vLabel}
- 摘要：${parse?.summary || '（无）'}
${timeline ? `\n## 动画时间轴\n| 时间段 | 视觉元素 | 运动方式 | 表达目的 |\n|---|---|---|---|\n${timeline}\n` : ''}
## 合成结构
- 分辨率：${comp.width}×${comp.height}
- 帧率：${comp.fps} fps
- 时长：${comp.durationInFrames} 帧（约 ${Math.round(comp.durationInFrames / comp.fps)} 秒）
- 关键动画：${(comp.keyAnimations || []).map((k) => `\`${k}\``).join('、') || '见 TemplateComponent.tsx'}
${refs}
## 使用场景
- ${parse?.tags?.[0] || '通用'} 类短片，可作为片头 / 转场 / 循环背景元素复用。

## 如何渲染
在共享工程 \`shared/\` 目录下：

\`\`\`bash
cd shared
npx remotion render src/index.ts ${name} src/compositions/${name}/preview.mp4
\`\`\`

## 自定义
- 文案/配色：改 \`meta.json\` 的 \`defaultProps\`（title/subtitle/bgFrom/bgTo/accentFrom/accentTo），不动动画逻辑。
- 动画逻辑：改 \`TemplateComponent.tsx\`（可对照 refs/ 下的原视频关键帧微调）。

- 主色：\`${accentFrom}\` → \`${accentTo}\`
- 背景：\`${bgFrom}\` → \`${bgTo}\`

## 来源
${sourceUrl ? `源视频：${sourceUrl}\n` : ''}
`
}
