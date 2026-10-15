// Turns the showcase recordings into README GIFs. Frames carrying the magenta
// cut mark (top-left 12px, set by showcase-drive.mjs around loading and waits) are
// dropped — found by colour in the frames themselves, so no clock has to line up.
//   node tests/e2e/showcase-gif.mjs <dir> [width]
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'

const [DIR = '.', WIDTH = '960'] = process.argv.slice(2)

/** [start, end] spans (seconds) where the corner is magenta: high U and V chroma. */
export function markedSpans(statsLog) {
  const spans = []
  let t = null
  let open = null
  for (const line of statsLog.split('\n')) {
    const pts = line.match(/pts_time:([\d.]+)/)
    if (pts) { t = Number(pts[1]); continue }
    const u = line.match(/UAVG=([\d.]+)/)
    if (u) open = { t, u: Number(u[1]) }
    const v = line.match(/VAVG=([\d.]+)/)
    if (v && open) {
      const marked = open.u > 180 && Number(v[1]) > 180
      const last = spans.at(-1)
      if (marked && last && last[1] === null) { /* still inside */ }
      else if (marked) spans.push([open.t, null])
      else if (last && last[1] === null) last[1] = open.t
      open = null
    }
  }
  if (spans.at(-1)?.[1] === null) spans.at(-1)[1] = t
  return spans
}

for (const f of readdirSync(DIR).filter(f => f.endsWith('.webm'))) {
  const name = f.slice(0, -5)
  const stats = spawnSync('ffmpeg', ['-v', 'error', '-i', `${DIR}/${f}`, '-vf',
    'crop=8:8:2:2,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout
  const spans = markedSpans(stats)
  const keep = spans.length ? `select='not(${spans.map(([a, b]) => `between(t,${a},${b})`).join('+')})',setpts=N/FRAME_RATE/TB,` : ''
  const vf = `${keep}fps=10,scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${DIR}/${f}`, '-vf', vf, '-loop', '0', `${DIR}/${name}.gif`])
  console.log(`${name}.gif ${(statSync(`${DIR}/${name}.gif`).size / 1e6).toFixed(2)} MB, dropped ${JSON.stringify(spans.map(s => s.map(x => +x.toFixed(1))))}`)
}
