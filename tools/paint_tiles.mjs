import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../public/assets/tiles')

const WIDTH = 96
const HEIGHT = 132

const FONT_STACK = "'Microsoft JhengHei', 'Segoe UI', sans-serif"
const SANS_STACK = "'Microsoft JhengHei', 'Segoe UI', Arial, sans-serif"

const CH_NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九']
const WINDS = ['東', '南', '西', '北']
const DRAGONS = ['中', '發', '白']
const SEASONS = ['春', '夏', '秋', '冬']
const PLANTS = ['梅', '蘭', '竹', '菊']

const C_RED = '#c81e1e'
const C_GREEN = '#15803d'
const C_BLUE = '#1d4ed8'
const C_DARK = '#1c1917'
const C_GOLD = '#b45309'

function getTileMeta(kind) {
  if (kind >= 0 && kind <= 8) {
    const r = kind + 1
    return { kind, suit: 'character', rank: r, name: `${CH_NUMS[kind]}萬`, mini: `${r}萬`, color: C_RED }
  }
  if (kind >= 9 && kind <= 17) {
    const r = kind - 9 + 1
    return { kind, suit: 'dot', rank: r, name: `${CH_NUMS[r - 1]}筒`, mini: `${r}筒`, color: C_BLUE }
  }
  if (kind >= 18 && kind <= 26) {
    const r = kind - 18 + 1
    return { kind, suit: 'bamboo', rank: r, name: `${CH_NUMS[r - 1]}條`, mini: `${r}條`, color: C_GREEN }
  }
  if (kind >= 27 && kind <= 30) {
    const w = WINDS[kind - 27]
    return { kind, suit: 'wind', rank: null, name: w, mini: w, color: C_DARK }
  }
  if (kind >= 31 && kind <= 33) {
    const d = DRAGONS[kind - 31]
    const colors = [C_RED, C_GREEN, C_BLUE]
    return { kind, suit: 'dragon', rank: null, name: d, mini: d, color: colors[kind - 31] }
  }
  if (kind >= 34 && kind <= 37) {
    const idx = kind - 34
    const s = SEASONS[idx]
    return { kind, suit: 'flower', rank: idx + 1, flowerSeat: idx + 1, name: s, mini: s, color: C_RED }
  }
  const idx = kind - 38
  const p = PLANTS[idx]
  return { kind, suit: 'flower', rank: idx + 1, flowerSeat: idx + 1, name: p, mini: p, color: C_BLUE }
}

function wrapFrontSvg(innerContent, meta) {
  const seatBadge = meta.flowerSeat
    ? `<g transform="translate(74, 18)">
        <circle cx="0" cy="0" r="10" fill="${meta.color}" opacity="0.14"/>
        <text x="0" y="4.5" text-anchor="middle" font-family="${SANS_STACK}" font-size="13" font-weight="900" fill="${meta.color}">${meta.flowerSeat}</text>
      </g>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="jadeEdge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
    <linearGradient id="ivoryFace" x1="0" y1="0" x2="0.2" y2="1">
      <stop offset="0%" stop-color="#fffdf9"/>
      <stop offset="65%" stop-color="#f7f0e4"/>
      <stop offset="100%" stop-color="#ebe0ce"/>
    </linearGradient>
  </defs>
  <!-- Drop shadow / 3D base -->
  <rect x="3" y="4" width="90" height="125" rx="13" fill="#022c22" opacity="0.45"/>
  <!-- Jade backing layer (3D bottom edge) -->
  <rect x="3" y="3" width="90" height="124" rx="13" fill="url(#jadeEdge)" stroke="#064e3b" stroke-width="1.5"/>
  <!-- Lower ivory bevel -->
  <rect x="3" y="3" width="90" height="118" rx="12" fill="#d6cbb9" stroke="#a89f91" stroke-width="1"/>
  <!-- Crisp front face -->
  <rect x="5" y="4" width="86" height="113" rx="10" fill="url(#ivoryFace)" stroke="#ffffff" stroke-width="1.2"/>
  <!-- Subtle inner frame -->
  <rect x="8" y="7" width="80" height="107" rx="8" fill="none" stroke="#e5dccb" stroke-width="1"/>
  <!-- Top-left mini index for mobile legibility -->
  <text x="12" y="21" font-family="${SANS_STACK}" font-size="12" font-weight="900" fill="${meta.color}" opacity="0.9">${meta.mini}</text>
  ${seatBadge}
  <!-- Main Center Symbol -->
  ${innerContent}
</svg>`
}

function drawDotCircle(cx, cy, r, outerColor, innerColor = '#ffffff') {
  const rMid = +(r * 0.62).toFixed(2)
  const rCore = +(r * 0.28).toFixed(2)
  return `<g>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${outerColor}" stroke="#1c1917" stroke-width="1"/>
    <circle cx="${cx}" cy="${cy}" r="${rMid}" fill="none" stroke="${innerColor}" stroke-width="${Math.max(1.4, r * 0.14).toFixed(1)}" stroke-dasharray="2.2 1.6"/>
    <circle cx="${cx}" cy="${cy}" r="${rCore}" fill="${innerColor}"/>
  </g>`
}

function renderDots(rank) {
  const cx = 48
  const cy = 67
  switch (rank) {
    case 1:
      return `<g>
        <circle cx="${cx}" cy="${cy}" r="27" fill="${C_RED}" stroke="#1c1917" stroke-width="1.5"/>
        <circle cx="${cx}" cy="${cy}" r="21" fill="none" stroke="#ffffff" stroke-width="2" stroke-dasharray="3 2"/>
        <circle cx="${cx}" cy="${cy}" r="15" fill="${C_GREEN}" stroke="#ffffff" stroke-width="1.5"/>
        <circle cx="${cx}" cy="${cy}" r="8" fill="${C_GOLD}" stroke="#ffffff" stroke-width="1.5"/>
        <circle cx="${cx}" cy="${cy}" r="3" fill="#ffffff"/>
      </g>`
    case 2:
      return [
        drawDotCircle(48, 45, 16, C_GREEN),
        drawDotCircle(48, 88, 16, C_BLUE),
      ].join('\n')
    case 3:
      return [
        drawDotCircle(29, 41, 13, C_BLUE),
        drawDotCircle(48, 67, 13, C_RED),
        drawDotCircle(67, 93, 13, C_GREEN),
      ].join('\n')
    case 4:
      return [
        drawDotCircle(33, 46, 13.5, C_BLUE),
        drawDotCircle(63, 46, 13.5, C_GREEN),
        drawDotCircle(33, 88, 13.5, C_GREEN),
        drawDotCircle(63, 88, 13.5, C_BLUE),
      ].join('\n')
    case 5:
      return [
        drawDotCircle(31, 44, 12, C_BLUE),
        drawDotCircle(65, 44, 12, C_GREEN),
        drawDotCircle(48, 67, 12, C_RED),
        drawDotCircle(31, 90, 12, C_GREEN),
        drawDotCircle(65, 90, 12, C_BLUE),
      ].join('\n')
    case 6:
      return [
        drawDotCircle(33, 42, 11.5, C_GREEN),
        drawDotCircle(63, 42, 11.5, C_GREEN),
        drawDotCircle(33, 70, 11.5, C_RED),
        drawDotCircle(63, 70, 11.5, C_RED),
        drawDotCircle(33, 94, 11.5, C_RED),
        drawDotCircle(63, 94, 11.5, C_RED),
      ].join('\n')
    case 7:
      return [
        drawDotCircle(26, 37, 9.5, C_GREEN),
        drawDotCircle(48, 45, 9.5, C_GREEN),
        drawDotCircle(70, 53, 9.5, C_GREEN),
        drawDotCircle(33, 75, 10.5, C_RED),
        drawDotCircle(63, 75, 10.5, C_RED),
        drawDotCircle(33, 97, 10.5, C_RED),
        drawDotCircle(63, 97, 10.5, C_RED),
      ].join('\n')
    case 8: {
      const ys = [37, 57, 77, 97]
      return ys
        .flatMap((y) => [drawDotCircle(33, y, 9.2, C_BLUE), drawDotCircle(63, y, 9.2, C_BLUE)])
        .join('\n')
    }
    case 9: {
      const xs = [26, 48, 70]
      const rows = [
        { y: 42, c: C_BLUE },
        { y: 68, c: C_RED },
        { y: 94, c: C_GREEN },
      ]
      return rows
        .flatMap((r) => xs.map((x) => drawDotCircle(x, r.y, 9.5, r.c)))
        .join('\n')
    }
  }
}

function drawStick(cx, cy, len, color) {
  const w = 7.5
  const x = cx - w / 2
  const y = cy - len / 2
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${len}" rx="3.5" fill="${color}" stroke="#1c1917" stroke-width="0.9"/>
    <line x1="${x + 1.5}" y1="${cy}" x2="${x + w - 1.5}" y2="${cy}" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
    <line x1="${x + 2.2}" y1="${y + 3}" x2="${x + 2.2}" y2="${y + len - 3}" stroke="#ffffff" stroke-width="1" opacity="0.45" stroke-linecap="round"/>
  </g>`
}

function renderBirdOneBamboo() {
  return `<g transform="translate(48, 68)">
    <!-- Tail feathers -->
    <path d="M-6,18 L-22,34 L-8,30 L0,36 L8,30 L22,34 L6,18 Z" fill="${C_GREEN}" stroke="#1c1917" stroke-width="1.2"/>
    <path d="M-3,18 L-10,30 L0,33 L10,30 L3,18 Z" fill="${C_RED}"/>
    <!-- Perch branch -->
    <line x1="-26" y1="20" x2="26" y2="20" stroke="${C_GOLD}" stroke-width="4" stroke-linecap="round"/>
    <circle cx="-22" cy="20" r="3.5" fill="${C_GREEN}"/>
    <circle cx="22" cy="20" r="3.5" fill="${C_GREEN}"/>
    <!-- Body -->
    <ellipse cx="0" cy="2" rx="18" ry="20" fill="${C_GREEN}" stroke="#1c1917" stroke-width="1.4"/>
    <!-- Chest / Belly -->
    <ellipse cx="0" cy="6" rx="11" ry="13" fill="#fef3c7" stroke="${C_GOLD}" stroke-width="1.2"/>
    <!-- Wings -->
    <path d="M-16,-4 Q-26,8 -12,16 Q-8,6 -16,-4 Z" fill="${C_RED}" stroke="#1c1917" stroke-width="1.1"/>
    <path d="M16,-4 Q26,8 12,16 Q8,6 16,-4 Z" fill="${C_RED}" stroke="#1c1917" stroke-width="1.1"/>
    <!-- Head -->
    <circle cx="0" cy="-18" r="11" fill="${C_GREEN}" stroke="#1c1917" stroke-width="1.4"/>
    <!-- Crest -->
    <path d="M0,-29 L-6,-36 L0,-33 L6,-36 Z" fill="${C_RED}" stroke="#1c1917" stroke-width="1"/>
    <!-- Eyes & Beak -->
    <circle cx="-4" cy="-19" r="2.2" fill="#ffffff"/>
    <circle cx="-4" cy="-19" r="1.1" fill="#1c1917"/>
    <circle cx="4" cy="-19" r="2.2" fill="#ffffff"/>
    <circle cx="4" cy="-19" r="1.1" fill="#1c1917"/>
    <polygon points="-3.5,-15 3.5,-15 0,-9" fill="#f59e0b" stroke="#1c1917" stroke-width="0.8"/>
  </g>`
}

function renderBamboos(rank) {
  switch (rank) {
    case 1:
      return renderBirdOneBamboo()
    case 2:
      return [drawStick(48, 48, 30, C_GREEN), drawStick(48, 86, 30, C_GREEN)].join('\n')
    case 3:
      return [
        drawStick(48, 46, 28, C_RED),
        drawStick(34, 85, 28, C_GREEN),
        drawStick(62, 85, 28, C_GREEN),
      ].join('\n')
    case 4:
      return [
        drawStick(34, 48, 28, C_GREEN),
        drawStick(62, 48, 28, C_GREEN),
        drawStick(34, 86, 28, C_GREEN),
        drawStick(62, 86, 28, C_GREEN),
      ].join('\n')
    case 5:
      return [
        drawStick(30, 48, 28, C_GREEN),
        drawStick(66, 48, 28, C_GREEN),
        drawStick(48, 67, 28, C_RED),
        drawStick(30, 86, 28, C_GREEN),
        drawStick(66, 86, 28, C_GREEN),
      ].join('\n')
    case 6:
      return [28, 48, 68]
        .flatMap((x) => [drawStick(x, 48, 28, C_GREEN), drawStick(x, 86, 28, C_GREEN)])
        .join('\n')
    case 7:
      return [
        drawStick(48, 39, 21, C_RED),
        ...[28, 48, 68].flatMap((x) => [
          drawStick(x, 66, 21, C_GREEN),
          drawStick(x, 93, 21, C_BLUE),
        ]),
      ].join('\n')
    case 8:
      return [24, 40, 56, 72]
        .flatMap((x, i) => {
          const c = i === 1 || i === 2 ? C_BLUE : C_GREEN
          return [drawStick(x, 48, 28, c), drawStick(x, 86, 28, c)]
        })
        .join('\n')
    case 9:
      return [28, 48, 68]
        .flatMap((x, i) => {
          const c = i === 1 ? C_RED : C_GREEN
          return [
            drawStick(x, 41, 21, c),
            drawStick(x, 67, 21, c),
            drawStick(x, 93, 21, c),
          ]
        })
        .join('\n')
  }
}

function renderTileSvg(kind) {
  const meta = getTileMeta(kind)
  let body = ''

  if (meta.suit === 'character') {
    const numChar = CH_NUMS[meta.rank - 1]
    body = `<g>
      <text x="48" y="57" text-anchor="middle" font-family="${FONT_STACK}" font-size="38" font-weight="900" fill="${C_DARK}" stroke="${C_DARK}" stroke-width="0.6">${numChar}</text>
      <text x="48" y="101" text-anchor="middle" font-family="${FONT_STACK}" font-size="40" font-weight="900" fill="${C_RED}" stroke="${C_RED}" stroke-width="0.6">萬</text>
    </g>`
  } else if (meta.suit === 'dot') {
    body = renderDots(meta.rank)
  } else if (meta.suit === 'bamboo') {
    body = renderBamboos(meta.rank)
  } else if (meta.suit === 'wind') {
    body = `<g>
      <text x="48" y="86" text-anchor="middle" font-family="${FONT_STACK}" font-size="56" font-weight="900" fill="${C_DARK}" stroke="${C_DARK}" stroke-width="1">${meta.name}</text>
    </g>`
  } else if (meta.suit === 'dragon') {
    if (kind === 33) {
      // 白板: Crisp double blue rectangular frame with corner ornaments
      body = `<g>
        <rect x="20" y="30" width="56" height="72" rx="6" fill="none" stroke="${C_BLUE}" stroke-width="4"/>
        <rect x="25" y="35" width="46" height="62" rx="3" fill="none" stroke="${C_BLUE}" stroke-width="1.8"/>
        <circle cx="28" cy="38" r="2.2" fill="${C_BLUE}"/>
        <circle cx="68" cy="38" r="2.2" fill="${C_BLUE}"/>
        <circle cx="28" cy="94" r="2.2" fill="${C_BLUE}"/>
        <circle cx="68" cy="94" r="2.2" fill="${C_BLUE}"/>
      </g>`
    } else {
      body = `<g>
        <text x="48" y="86" text-anchor="middle" font-family="${FONT_STACK}" font-size="56" font-weight="900" fill="${meta.color}" stroke="${meta.color}" stroke-width="1">${meta.name}</text>
      </g>`
    }
  } else if (meta.suit === 'flower') {
    const isSeason = kind < 38
    const accent = isSeason ? '#f59e0b' : '#10b981'
    const tag = isSeason ? ['壹', '貳', '參', '肆'][meta.flowerSeat - 1] : ['一', '二', '三', '四'][meta.flowerSeat - 1]
    body = `<g>
      <!-- Decorative botanical blossom -->
      <g transform="translate(48, 45)">
        <circle cx="0" cy="-10" r="7" fill="${accent}" opacity="0.25"/>
        <circle cx="10" cy="-3" r="7" fill="${accent}" opacity="0.25"/>
        <circle cx="6" cy="8" r="7" fill="${accent}" opacity="0.25"/>
        <circle cx="-6" cy="8" r="7" fill="${accent}" opacity="0.25"/>
        <circle cx="-10" cy="-3" r="7" fill="${accent}" opacity="0.25"/>
        <circle cx="0" cy="0" r="5" fill="${meta.color}" opacity="0.4"/>
      </g>
      <text x="48" y="88" text-anchor="middle" font-family="${FONT_STACK}" font-size="44" font-weight="900" fill="${meta.color}" stroke="${meta.color}" stroke-width="0.8">${meta.name}</text>
      <text x="20" y="106" font-family="${FONT_STACK}" font-size="13" font-weight="900" fill="${C_GOLD}">${tag}</text>
    </g>`
  }

  return wrapFrontSvg(body, meta)
}

function renderBackSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="backFace" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="50%" stop-color="#059669"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
  </defs>
  <!-- Drop shadow -->
  <rect x="3" y="4" width="90" height="125" rx="13" fill="#022c22" opacity="0.5"/>
  <!-- Ivory bottom base visible under face-down tile -->
  <rect x="3" y="3" width="90" height="124" rx="13" fill="#ebe0ce" stroke="#a89f91" stroke-width="1.5"/>
  <!-- Emerald green top shell -->
  <rect x="3" y="3" width="90" height="118" rx="12" fill="#065f46" stroke="#022c22" stroke-width="1.2"/>
  <rect x="5" y="4" width="86" height="113" rx="10" fill="url(#backFace)" stroke="#6ee7b7" stroke-width="1.2"/>
  <!-- Ornate carved lattice frame -->
  <rect x="12" y="11" width="72" height="99" rx="6" fill="none" stroke="#a7f3d0" stroke-width="1.8" opacity="0.75"/>
  <rect x="16" y="15" width="64" height="91" rx="4" fill="none" stroke="#d1fae5" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
  <!-- Center medallion -->
  <g transform="translate(48, 60)">
    <circle cx="0" cy="0" r="18" fill="#064e3b" stroke="#a7f3d0" stroke-width="1.8"/>
    <path d="M0,-12 L12,0 L0,12 L-12,0 Z" fill="none" stroke="#6ee7b7" stroke-width="1.5"/>
    <circle cx="0" cy="0" r="4" fill="#a7f3d0"/>
  </g>
</svg>`
}

function svgToPngBuffer(svg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Microsoft JhengHei',
    },
  })
  return resvg.render().asPng()
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const tiles = []
  for (let kind = 0; kind < 42; kind++) {
    const meta = getTileMeta(kind)
    const file = `tile_${kind}.png`
    const svg = renderTileSvg(kind)
    const png = svgToPngBuffer(svg)
    fs.writeFileSync(path.join(OUT_DIR, file), png)
    tiles.push({
      kind,
      name: meta.name,
      suit: meta.suit,
      rank: meta.rank,
      flowerSeat: meta.flowerSeat ?? null,
      file,
    })
  }

  const backFile = 'tile_back.png'
  fs.writeFileSync(path.join(OUT_DIR, backFile), svgToPngBuffer(renderBackSvg()))

  const manifest = {
    width: WIDTH,
    height: HEIGHT,
    back: backFile,
    tiles,
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Baked ${tiles.length} front tiles + ${backFile} + manifest.json -> ${OUT_DIR}`)
}

main()
