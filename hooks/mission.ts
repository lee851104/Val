// 任務顯示幕：面板最上方那張會動的圖（桌面版、手機版才有，終端機用文字版）。
// 純函式：給它目前的數字，回傳一段 SVG 文字。

export type Lamp = 'go' | 'fault' | 'off' | 'wait' | 'run'

export type Mission = {
  /** 生效中的防線數：每一條是一顆繞軌道的衛星 */
  armed: number
  blocks: number
  /** 9 種驗證，依序的代號和狀態 */
  checks: { code: string; lamp: Lamp }[]
  status: 'nominal' | 'fault' | 'standby'
  /** 剛上鎖、動畫還在跑 */
  isArming: boolean
  ranAt: string
}

const W = 480
const H = 300
/** 地平線最高點的高度 */
const HORIZON = 212
const FONT = `'D-DIN','Barlow','Rajdhani','Segoe UI',system-ui,sans-serif`

const LAMP: Record<Lamp, string> = {
  go: '#2EE59D',
  fault: '#FF4D5E',
  off: '#1C2633',
  wait: '#3A4A5E',
  run: '#FFC94D',
}

const STATUS = {
  nominal: { text: 'NOMINAL', color: '#2EE59D' },
  fault: { text: 'FAULT', color: '#FF4D5E' },
  standby: { text: 'STANDBY', color: '#8FA3BA' },
}

/** 固定的亂數：同樣的種子每次畫出同樣的星空，畫面不會每次重繪就亂跳 */
function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function stars(): string {
  const next = random(7)
  const out: string[] = []
  for (let i = 0; i < 70; i++) {
    const x = (next() * W).toFixed(1)
    const y = (next() * (HORIZON - 10)).toFixed(1)
    const r = (0.3 + next() * 0.9).toFixed(2)
    const o = (0.25 + next() * 0.6).toFixed(2)
    const twinkle =
      next() < 0.35
        ? `<animate attributeName="opacity" values="${o};0.05;${o}" dur="${(2 + next() * 4).toFixed(1)}s" begin="${(next() * 3).toFixed(1)}s" repeatCount="indefinite"/>`
        : ''
    out.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${o}">${twinkle}</circle>`)
  }
  return out.join('')
}

function satellites(armed: number): string {
  const count = Math.min(armed, 6)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const start = (18 / count) * i
    // 彗星尾巴：同一條軌道上，晚一點出發、越來越淡的幾顆小點
    for (let t = 6; t >= 1; t--) {
      out.push(
        `<circle r="${(2.4 - t * 0.25).toFixed(2)}" fill="#7CC4FF" opacity="${(0.5 - t * 0.07).toFixed(2)}">` +
          `<animateMotion dur="18s" begin="-${(start - t * 0.09 + 18).toFixed(2)}s" repeatCount="indefinite"><mpath href="#orbit"/></animateMotion></circle>`,
      )
    }
    out.push(
      `<g filter="url(#glow)"><circle r="3.4" fill="#F2FAFF"/><circle r="7" fill="none" stroke="#9AD6FF" stroke-opacity="0.6">` +
        `<animate attributeName="r" values="4;12;4" dur="2.4s" repeatCount="indefinite"/>` +
        `<animate attributeName="stroke-opacity" values="0.8;0;0.8" dur="2.4s" repeatCount="indefinite"/></circle>` +
        `<animateMotion dur="18s" begin="-${(start + 18).toFixed(2)}s" repeatCount="indefinite"><mpath href="#orbit"/></animateMotion></g>`,
    )
  }
  return out.join('')
}

/** 四個角的瞄準框 */
function brackets(): string {
  const m = 10
  const l = 14
  const corners = [
    `M ${m} ${m + l} V ${m} H ${m + l}`,
    `M ${W - m - l} ${m} H ${W - m} V ${m + l}`,
    `M ${m} ${H - m - l} V ${H - m} H ${m + l}`,
    `M ${W - m - l} ${H - m} H ${W - m} V ${H - m - l}`,
  ]
  return `<path d="${corners.join(' ')}" fill="none" stroke="#9FB3C8" stroke-opacity="0.45" stroke-width="1"/>`
}

function readout(x: number, value: string, label: string, sub: string, color = '#FFFFFF'): string {
  return (
    `<text x="${x}" y="128" text-anchor="middle" font-size="46" font-weight="200" fill="${color}" letter-spacing="1">${value}</text>` +
    `<text x="${x}" y="150" text-anchor="middle" font-size="9.5" font-weight="700" fill="#A9BCD0" letter-spacing="2.8">${label}</text>` +
    `<text x="${x}" y="164" text-anchor="middle" font-size="9" fill="#61768C" letter-spacing="1">${sub}</text>`
  )
}

function strip(checks: Mission['checks']): string {
  const gap = 4
  const left = 24
  const width = (W - left * 2 - gap * (checks.length - 1)) / checks.length
  return checks
    .map((check, i) => {
      const x = left + i * (width + gap)
      const color = LAMP[check.lamp]
      const blink =
        check.lamp === 'fault' || check.lamp === 'run'
          ? `<animate attributeName="opacity" values="1;0.35;1" dur="${check.lamp === 'run' ? '0.8' : '1.4'}s" repeatCount="indefinite"/>`
          : ''
      const lit = check.lamp === 'go' || check.lamp === 'fault' || check.lamp === 'run'
      return (
        `<rect x="${x.toFixed(1)}" y="268" width="${width.toFixed(1)}" height="5" rx="1" fill="${color}"${lit ? ' filter="url(#glow)"' : ''}>${blink}</rect>` +
        `<text x="${(x + width / 2).toFixed(1)}" y="285" text-anchor="middle" font-size="7.5" font-weight="600" letter-spacing="1" fill="${lit ? '#C9D6E3' : '#4B5B6E'}">${check.code}</text>`
      )
    })
    .join('')
}

export function missionSvg(m: Mission): string {
  const status = STATUS[m.status]
  const go = m.checks.filter(check => check.lamp === 'go').length
  const set = m.checks.filter(check => check.lamp !== 'off').length
  const pad = (n: number) => String(n).padStart(2, '0')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">` +
    `<defs>` +
    `<radialGradient id="sky" cx="50%" cy="0%" r="110%"><stop offset="0" stop-color="#0E1B2E"/><stop offset="0.55" stop-color="#060B14"/><stop offset="1" stop-color="#020408"/></radialGradient>` +
    `<linearGradient id="earth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0B2346"/><stop offset="0.12" stop-color="#061428"/><stop offset="1" stop-color="#01040A"/></linearGradient>` +
    `<radialGradient id="haze" cx="50%" cy="100%" r="75%"><stop offset="0.55" stop-color="#2F8CFF" stop-opacity="0"/><stop offset="0.86" stop-color="#2F8CFF" stop-opacity="0.28"/><stop offset="1" stop-color="#2F8CFF" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="limb" x1="0" x2="1"><stop offset="0" stop-color="#4FB2FF" stop-opacity="0"/><stop offset="0.5" stop-color="#BFE6FF"/><stop offset="1" stop-color="#4FB2FF" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="sweep" x1="0" x2="1"><stop offset="0" stop-color="#9AD6FF" stop-opacity="0"/><stop offset="0.85" stop-color="#9AD6FF" stop-opacity="0.09"/><stop offset="1" stop-color="#9AD6FF" stop-opacity="0"/></linearGradient>` +
    `<filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `<clipPath id="frame"><rect width="${W}" height="${H}" rx="14"/></clipPath>` +
    `<path id="orbit" d="M 14 214 A 232 52 -5 1 1 466 174 A 232 52 -5 1 1 14 214 Z"/>` +
    `</defs>` +
    `<g clip-path="url(#frame)">` +
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>` +
    stars() +
    // 地球的邊緣：大圓的頂端從畫面下方露出來，外面一圈藍色大氣
    `<use href="#orbit" fill="none" stroke="#7CC4FF" stroke-opacity="0.22" stroke-dasharray="2 5"/>` +
    `<ellipse cx="${W / 2}" cy="${HORIZON + 620}" rx="760" ry="660" fill="url(#haze)"/>` +
    `<ellipse cx="${W / 2}" cy="${HORIZON + 620}" rx="720" ry="620" fill="url(#earth)"/>` +
    `<ellipse cx="${W / 2}" cy="${HORIZON + 620}" rx="720" ry="620" fill="none" stroke="url(#limb)" stroke-width="1.8" filter="url(#glow)"/>` +
    `<ellipse cx="${W / 2}" cy="${HORIZON + 620}" rx="720" ry="620" fill="none" stroke="#E6F5FF" stroke-opacity="0.5" stroke-width="0.6"/>` +
    // 掃描光：一道很淡的光從左掃到右
    `<rect x="-80" y="0" width="80" height="${H}" fill="url(#sweep)"><animate attributeName="x" values="-80;${W}" dur="7s" repeatCount="indefinite"/></rect>` +
    satellites(m.armed) +
    `<line x1="24" y1="252" x2="${W - 24}" y2="252" stroke="#fff" stroke-opacity="0.06"/>` +
    // 標題和狀態燈
    `<text x="24" y="38" font-size="15" font-weight="700" fill="#fff" letter-spacing="6">FIXNOTE</text>` +
    `<text x="24" y="54" font-size="8.5" font-weight="600" fill="#6F86A0" letter-spacing="3.2">MISSION CONTROL · 糾正筆記</text>` +
    `<g transform="translate(${W - 24} 30)">` +
    `<rect x="-104" y="-12" width="104" height="24" rx="12" fill="${status.color}" fill-opacity="0.08" stroke="${status.color}" stroke-opacity="0.55"/>` +
    `<circle cx="-88" cy="0" r="3.5" fill="${status.color}" filter="url(#glow)"><animate attributeName="opacity" values="1;0.25;1" dur="${m.status === 'fault' ? '0.9' : '2.2'}s" repeatCount="indefinite"/></circle>` +
    `<text x="-48" y="3.5" text-anchor="middle" font-size="9.5" font-weight="700" fill="${status.color}" letter-spacing="2.4">${status.text}</text>` +
    `</g>` +
    (m.isArming
      ? `<text x="${W / 2}" y="76" text-anchor="middle" font-size="10" font-weight="700" fill="#2EE59D" letter-spacing="5">ARMING NEW GUARD<animate attributeName="opacity" values="1;0.2;1" dur="0.5s" repeatCount="indefinite"/></text>`
      : '') +
    // 三組遙測數字
    readout(W / 6, pad(m.armed), 'GUARDS ARMED', '防線生效中') +
    `<line x1="${W / 3}" y1="94" x2="${W / 3}" y2="164" stroke="#fff" stroke-opacity="0.12"/>` +
    readout(W / 2, pad(m.blocks), 'INTERCEPTS', '已擋下次數') +
    `<line x1="${(W * 2) / 3}" y1="94" x2="${(W * 2) / 3}" y2="164" stroke="#fff" stroke-opacity="0.12"/>` +
    readout((W * 5) / 6, m.ranAt === '' ? '—' : `${go}/${set}`, 'CHECKS GO', m.ranAt === '' ? '還沒跑驗證' : `上次 ${m.ranAt}`, m.status === 'fault' ? '#FF4D5E' : '#FFFFFF') +
    // 9 種驗證的狀態列
    `<text x="24" y="261" font-size="8" font-weight="700" fill="#6F86A0" letter-spacing="2.6">PRE-FLIGHT</text>` +
    `<text x="${W - 24}" y="261" text-anchor="end" font-size="8" fill="#4B5B6E" letter-spacing="1.5">${go} GO · ${m.checks.filter(check => check.lamp === 'fault').length} FAULT · ${m.checks.filter(check => check.lamp === 'off').length} OFF</text>` +
    strip(m.checks) +
    brackets() +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="#fff" stroke-opacity="0.08"/>` +
    `</g></svg>`
  )
}
