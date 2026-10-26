import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

// PWA 圖示：酒紅絨布上一張「中」牌，沿用牌桌的朱漆黃銅配色
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../public/icons')

const FONT_STACK = "'Microsoft JhengHei', 'Noto Serif TC', 'PMingLiU', serif"

/** maskable 需滿版且主體縮在 80% 安全圓內；一般圖示保留圓角木框 */
function iconSvg({ maskable }) {
  const s = 512
  const tileScale = maskable ? 0.62 : 0.74
  const tw = 300 * tileScale
  const th = 400 * tileScale
  const tx = (s - tw) / 2
  const ty = (s - th) / 2 - 6
  const r = 34 * tileScale
  const bg = maskable
    ? `<rect width="${s}" height="${s}" fill="url(#felt)"/>`
    : `<rect width="${s}" height="${s}" rx="112" fill="#1f140e"/>
       <rect x="22" y="22" width="${s - 44}" height="${s - 44}" rx="92" fill="url(#felt)" stroke="#d4a64a" stroke-opacity="0.55" stroke-width="4"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <radialGradient id="felt" cx="50%" cy="42%" r="70%">
      <stop offset="0" stop-color="#7a2a35"/>
      <stop offset="1" stop-color="#2b0c13"/>
    </radialGradient>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fffaf0"/>
      <stop offset="1" stop-color="#ead9b8"/>
    </linearGradient>
  </defs>
  ${bg}
  <rect x="${tx}" y="${ty + 22 * tileScale}" width="${tw}" height="${th}" rx="${r}" fill="#1f6e50"/>
  <rect x="${tx + 6}" y="${ty + 30 * tileScale}" width="${tw - 12}" height="${th}" rx="${r}" fill="#000" opacity="0.25"/>
  <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="${r}" fill="url(#face)" stroke="#d4a64a" stroke-width="${6 * tileScale}"/>
  <text x="${s / 2}" y="${ty + th / 2}" font-family="${FONT_STACK}" font-weight="700" font-size="${260 * tileScale}"
    fill="#c81e1e" text-anchor="middle" dominant-baseline="central">中</text>
</svg>`
}

function png(svg, size) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng()
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const plain = iconSvg({ maskable: false })
const maskable = iconSvg({ maskable: true })
const outputs = [
  ['icon-192.png', plain, 192],
  ['icon-512.png', plain, 512],
  ['icon-maskable-512.png', maskable, 512],
  ['apple-touch-icon.png', maskable, 180],
  ['favicon-64.png', plain, 64],
]
for (const [file, svg, size] of outputs) {
  fs.writeFileSync(path.join(OUT_DIR, file), png(svg, size))
  console.log(`✓ ${file}`)
}
