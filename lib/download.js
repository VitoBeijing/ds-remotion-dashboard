// 视频下载（yt-dlp）+ 关键帧抽取（ffmpeg）。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 从粘贴的分享文本里提取第一个 http(s) URL（兼容「标题 + emoji + URL」的小红书/抖音/微信分享格式，也兼容纯 URL 后接备注）。 */
export function extractUrl(text) {
  if (!text) return ''
  const m = String(text).trim().match(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+/i)
  if (!m) return ''
  return m[0].replace(/[),.;!?，。；！？、，】]+$/, '')
}

/** 识别 URL 平台，用于给出针对性的失败提示。 */
export function platformOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (/xiaohongshu\.com$/.test(host)) return 'xiaohongshu'
    if (/douyin\.com$/.test(host)) return 'douyin'
    if (/youtube\.com$|youtu\.be$/.test(host)) return 'youtube'
    if (/bilibili\.com$|b23\.tv$/.test(host)) return 'bilibili'
    return null
  } catch { return null }
}

/** 同步探测外部工具是否可用。 */
export function which(name) {
  try {
    const r = spawnSync('which', [name], { encoding: 'utf8', timeout: 3000 })
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split('\n')[0] : null
  } catch { return null }
}

/** 运行一个外部命令，收集 stdout/stderr；超时或非零退出抛错。 */
export function run(cmd, args, { cwd, timeoutMs = 300000, logger } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error(`${cmd} 超时`), { code: 'TIMEOUT' })) }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ code, stdout, stderr })
      else reject(Object.assign(new Error(`${cmd} 退出码 ${code}：${stderr.slice(-500)}`), { code: 'EXIT', status: code, stderr }))
    })
  })
}

/** 下载视频到 outDir，返回本地文件路径与标题。 */
/** 下载视频到 outDir，返回本地文件路径与标题。cookiesFromBrowser 指定从哪个浏览器读登录 cookies（小红书/抖音/B站等需要），'none' 表示不带。 */
export async function downloadVideo(url, outDir, { logger, cookiesFromBrowser = 'chrome' } = {}) {
  mkdirSync(outDir, { recursive: true })
  const cleanUrl = extractUrl(url) || url
  const platform = platformOf(cleanUrl)
  const ytdlp = which('yt-dlp')
  if (!ytdlp) throw Object.assign(new Error('未找到 yt-dlp，请 `brew install yt-dlp`'), { code: 'NO_YTDLP' })
  const template = join(outDir, 'source.%(ext)s')
  const cookieArgs = cookiesFromBrowser && cookiesFromBrowser !== 'none' ? ['--cookies-from-browser', cookiesFromBrowser] : []
  let title = ''
  try {
    const meta = await run(ytdlp, [...cookieArgs, '--skip-download', '--no-playlist', '--print', '%(title)s', cleanUrl], { timeoutMs: 60000 })
    title = meta.stdout.trim().split('\n').pop() || ''
  } catch { /* 标题获取失败不阻塞下载 */ }
  const args = [
    ...cookieArgs,
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--no-playlist', '--restrict-filenames',
    '-o', template, cleanUrl,
  ]
  try {
    await run(ytdlp, args, { timeoutMs: 600000 })
  } catch (e) {
    // 带 cookies 失败时，重试一次不带 cookies（可能浏览器未登录或 cookies 无效）
    if (cookieArgs.length) {
      logger?.warn?.(`[remotion-dashboard] 带 cookies 下载失败，重试无 cookies: ${e.message.slice(0, 100)}`)
      try {
        await run(ytdlp, args.filter((a) => a !== '--cookies-from-browser' && a !== cookiesFromBrowser), { timeoutMs: 600000 })
      } catch (e2) {
        throw downloadError(platform, e2)
      }
    } else {
      throw downloadError(platform, e)
    }
  }
  const files = readdirSync(outDir).filter((f) => /\.(mp4|webm|mkv|mov)$/i.test(f))
  if (!files.length) throw new Error('下载完成但未找到视频文件')
  return { path: join(outDir, files[0]), title }
}

function downloadError(platform, e) {
  const msg = e.message || String(e)
  if (platform === 'xiaohongshu' || platform === 'douyin') {
    // 区分：extractor 不支持该页面（No video formats）vs 需要登录（403/cookies）
    if (/No video formats|Unsupported URL|unable to extract/i.test(msg)) {
      return Object.assign(new Error(`${platform === 'xiaohongshu' ? '小红书' : '抖音'}：yt-dlp 无法解析这条链接的视频（可能是笔记类型或页面结构不支持）。建议：① 换一条视频链接重试；② 手动下载视频后，后续支持本地文件导入；③ 改用 YouTube/B站 链接（这些平台 yt-dlp 支持稳定）。`), { code: 'EXTRACTOR_UNSUPPORTED' })
    }
    return Object.assign(new Error(`${platform === 'xiaohongshu' ? '小红书' : '抖音'}下载失败（可能需要登录）：${msg.slice(0, 150)}。插件已尝试从浏览器读 cookies——请确认 Chrome 已登录该平台；或在配置里改 cookiesFromBrowser（chrome/safari/edge/none）。也可手动下载后换链接。`), { code: 'PLATFORM_DOWNLOAD_FAILED' })
  }
  return e
}

/** 按间隔抽帧，返回带时间戳的帧数组 [{name, t}]（t=秒，用于多动画分段时把帧分配给各 segment）。 */
export async function extractFrames(videoPath, framesDir, { intervalSec = 1.5, maxFrames = 6, logger } = {}) {
  mkdirSync(framesDir, { recursive: true })
  const ffmpeg = which('ffmpeg')
  if (!ffmpeg) throw Object.assign(new Error('未找到 ffmpeg，请 `brew install ffmpeg`'), { code: 'NO_FFMPEG' })
  const args = [
    '-y', '-i', videoPath,
    '-vf', `fps=1/${intervalSec},scale='min(960,iw)':-2`,
    '-frames:v', String(maxFrames),
    '-q:v', '3',
    join(framesDir, 'frame_%03d.jpg'),
  ]
  await run(ffmpeg, args, { timeoutMs: 120000 })
  return readdirSync(framesDir).filter((f) => /\.jpe?g$/i.test(f)).sort()
    .map((name, i) => ({ name, t: Math.round(i * intervalSec * 10) / 10 }))
}

/** ffprobe 取视频时长（秒），失败返回 null。 */
export async function probeDuration(videoPath) {
  const ffprobe = which('ffprobe')
  if (!ffprobe) return null
  try {
    const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], { timeoutMs: 30000 })
    const d = parseFloat(r.stdout.trim())
    return Number.isFinite(d) && d > 0 ? d : null
  } catch { return null }
}

/**
 * 全片采样：场景检测帧（画面内容变化处）+ 均匀补帧，覆盖整个时间轴。
 * 返回 [{name, t}]（t=真实秒数），按时间排序，数量 ≈ maxFrames。
 */
export async function extractSceneFrames(videoPath, framesDir, { maxFrames = 24, logger } = {}) {
  mkdirSync(framesDir, { recursive: true })
  const ffmpeg = which('ffmpeg')
  if (!ffmpeg) throw Object.assign(new Error('未找到 ffmpeg，请 `brew install ffmpeg`'), { code: 'NO_FFMPEG' })
  const duration = (await probeDuration(videoPath)) || 30
  const collected = new Map() // t(秒) -> name

  // 1) 场景检测帧：内容变化处，showinfo 从 stderr 读 pts_time
  try {
    const r = await run(ffmpeg, [
      '-y', '-i', videoPath,
      '-vf', "select='gt(scene,0.28)',scale='min(640,iw)':-2,showinfo",
      '-vsync', 'vfr', '-q:v', '3', join(framesDir, 'scene_%03d.jpg'),
    ], { timeoutMs: 180000 })
    const times = [...r.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => parseFloat(m[1]))
    const sceneFiles = readdirSync(framesDir).filter((f) => /^scene_\d+\.jpe?g$/i.test(f)).sort()
    sceneFiles.forEach((name, i) => { const t = times[i]; if (Number.isFinite(t)) collected.set(Math.round(t * 10) / 10, name) })
  } catch (e) { logger?.warn?.(`[remotion-dashboard] 场景检测抽帧失败（用均匀采样兜底）: ${e?.message}`) }

  // 2) 均匀补帧：按 maxFrames 目标密度补齐，保证全片覆盖
  const target = Math.min(maxFrames, Math.max(8, Math.round(duration / 3)))
  const need = target - collected.size
  if (need > 0) {
    const step = duration / (target + 1)
    const missing = []
    for (let i = 1; i <= target; i++) {
      const t = Math.round(i * step * 10) / 10
      // 与已有场景帧间隔 < step/2 则跳过（避免重复）
      let tooClose = false
      for (const et of collected.keys()) if (Math.abs(et - t) < step / 2) { tooClose = true; break }
      if (!tooClose) missing.push(t)
      if (missing.length >= need) break
    }
    for (let i = 0; i < missing.length; i++) {
      const t = missing[i]
      const name = `uni_${String(i).padStart(3, '0')}.jpg`
      try {
        await run(ffmpeg, ['-y', '-ss', String(t), '-i', videoPath, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '3', join(framesDir, name)], { timeoutMs: 60000 })
        collected.set(t, name)
      } catch { /* 单帧失败跳过 */ }
    }
  }

  return [...collected.entries()].sort((a, b) => a[0] - b[0]).map(([t, name]) => ({ name, t }))
}

/**
 * 把带时间戳的帧拼成 contact sheet（每张 cols×rows 格，xstack 纯几何拼接，不依赖 drawtext）。
 * 返回 { sheets: [路径], gridTimes: [每张拼图内从左到右、从上到下的格子时间戳秒数] }。
 * brew ffmpeg 无 drawtext 滤镜，时间戳由返回值供调用方写进文本提示，不烧录进图。
 */
export async function makeContactSheets(frames, outDir, { perSheet = 12, cols = 4, logger } = {}) {
  const ffmpeg = which('ffmpeg')
  if (!ffmpeg) throw Object.assign(new Error('未找到 ffmpeg'), { code: 'NO_FFMPEG' })
  mkdirSync(outDir, { recursive: true })
  const sheets = []
  const gridTimes = []
  for (let s = 0; s < frames.length; s += perSheet) {
    const group = frames.slice(s, s + perSheet)
    const inputs = []
    const filterParts = []
    group.forEach((g, i) => { inputs.push('-i', g.path); filterParts.push(`[${i}:v]scale=480:270[t${i}]`) })
    const layout = group.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 270}`)
    const tileIn = group.map((_, i) => `[t${i}]`).join('')
    const filter = `${filterParts.join(';')};${tileIn}xstack=inputs=${group.length}:layout=${layout.join('|')}[out]`
    const out = join(outDir, `sheet_${String(sheets.length + 1).padStart(2, '0')}.jpg`)
    try {
      await run(ffmpeg, ['-y', ...inputs, '-filter_complex', filter, '-map', '[out]', '-q:v', '3', '-update', '1', out], { timeoutMs: 120000 })
      sheets.push(out)
      gridTimes.push(group.map((g) => g.t))
    } catch (e) { logger?.warn?.(`[remotion-dashboard] 拼图失败 sheet${sheets.length + 1}: ${e?.message}`) }
  }
  return { sheets, gridTimes }
}
