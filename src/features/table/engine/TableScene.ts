import Phaser from 'phaser'
import { kindOf, type SeatIndex, type TileId } from '@/shared/kernel/types'
import type { TableState } from '../domain/tableState'

export interface TableSceneCallbacks {
  onSelectTile: (tileId: TileId | null) => void
  onDiscardTile: (tileId: TileId) => void
  /** 回報本家手牌區頂端（CSS px，自畫面底部起算），供 DOM 操作列貼齊手牌上緣 */
  onLayout?: (handZoneCssHeight: number, portrait: boolean) => void
}

type Rel = 0 | 1 | 2 | 3

const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif'
const C = {
  feltIn: '#25466c',
  feltOut: '#0a1626',
  ink: 0x0b1729,
  line: 0x3d5a80,
  accent: 0xf0533a,
  gold: 0xe9c46a,
  ivory: '#f4ecdc',
  muted: '#8fa3bf',
}
const WIND = ['東', '南', '西', '北'] as const
const ROUND_WIND: Record<string, string> = { east: '東風圈', south: '南風圈', west: '西風圈', north: '北風圈' }
const TILE_RATIO = 132 / 96

interface Layout {
  w: number
  h: number
  u: number
  portrait: boolean
  tileW: number
  tileH: number
  handRows: 1 | 2
  handZoneH: number
  y0: number
  y1: number
  cx: number
  cy: number
  oppW: number
  oppH: number
  rw: number
  rh: number
  colsTB: number
  colsLR: number
  cW: number
  cH: number
}

/**
 * 牌桌渲染：以裝置像素繪製（canvas = CSS 尺寸 × DPR，zoom = 1/DPR），手機上牌面清晰。
 * 版面：上方對家、左右兩家直列、中央羅盤（風位 + 分數 + 餘牌）、四方牌河、底部本家手牌。
 */
export class TableScene extends Phaser.Scene {
  private callbacks: TableSceneCallbacks | null = null
  private state: TableState | null = null
  private localSeat: SeatIndex = 0
  private selectedTileId: TileId | null = null
  private migiSelectMode = false
  private migiAllowed = new Set<TileId>()
  private tenpaiDiscards = new Set<TileId>()
  private ready = false
  private lastCalloutId = 0
  private lastDiscardKey = ''
  private lastLayoutKey = ''

  private bg!: Phaser.GameObjects.Image
  private layer!: Phaser.GameObjects.Container
  private fx!: Phaser.GameObjects.Container

  constructor() {
    super('TableScene')
  }

  bindCallbacks(cb: TableSceneCallbacks): void {
    this.callbacks = cb
  }

  preload(): void {
    for (let k = 0; k < 42; k++) this.load.image(`tile_${k}`, `assets/tiles/tile_${k}.png`)
    this.load.image('tile_back', 'assets/tiles/tile_back.png')
  }

  create(): void {
    this.layer = this.add.container(0, 0)
    this.fx = this.add.container(0, 0)
    this.ready = true
    this.drawFelt()
    this.render()
    this.scale.on('resize', () => {
      this.drawFelt()
      this.render()
    })
  }

  syncState(
    state: TableState,
    localSeat: SeatIndex,
    selectedTileId: TileId | null,
    migiSelectMode: boolean,
    migiAllowed: readonly TileId[],
    tenpaiDiscards: ReadonlySet<TileId> = new Set(),
  ): void {
    this.state = state
    this.localSeat = localSeat
    this.selectedTileId = selectedTileId
    this.migiSelectMode = migiSelectMode
    this.migiAllowed = new Set(migiAllowed)
    this.tenpaiDiscards = new Set(tenpaiDiscards)
    if (!this.ready) return
    this.render()
    if (state.lastCallout && state.lastCallout.id !== this.lastCalloutId) {
      this.lastCalloutId = state.lastCallout.id
      this.playCallout(state.lastCallout.seat, state.lastCallout.label)
    }
  }

  // ───────────────────────── layout ─────────────────────────

  private rel(seat: SeatIndex): Rel {
    return ((seat + 4 - this.localSeat) % 4) as Rel
  }

  private layout(): Layout {
    const w = this.scale.width
    const h = this.scale.height
    const u = Math.min(window.devicePixelRatio || 1, 2)
    const portrait = h > w * 1.05
    const compact = !portrait && h / u < 520
    const self = this.state!.seats[this.localSeat]
    const meldTiles = self.melds.reduce((a, m) => a + m.tiles.length, 0)
    const concealedSlots = (5 - self.melds.length) * 3 + 2

    let tileW: number
    let handRows: 1 | 2 = 1
    if (portrait) {
      handRows = concealedSlots > 9 ? 2 : 1
      tileW = Math.min(58 * u, Math.floor((w - 16 * u) / 9.4))
    } else {
      const slots = concealedSlots + 0.6 + meldTiles * 0.78 + self.melds.length * 0.2 + self.flowers.length * 0.5 + 0.6
      tileW = Math.min(64 * u, h * 0.13, Math.floor((w - 24 * u) / slots))
    }
    tileW = Math.max(22 * u, tileW)
    const tileH = Math.round(tileW * TILE_RATIO)
    const lift = tileH * 0.24
    const bottomPad = 8 * u
    const meldRow = portrait ? Math.round(tileH * 0.72) + 6 * u : 0
    const handZoneH = handRows * tileH + (handRows - 1) * 4 * u + lift + bottomPad + meldRow

    const y0 = compact ? 4 * u : 52 * u
    const y1 = h - handZoneH
    const cx = w / 2
    const cy = (y0 + y1) / 2
    const boardH = y1 - y0
    const oppW = Math.round(Math.max(12 * u, Math.min(26 * u, Math.min(w, boardH * 1.3) / 30)))
    const oppH = Math.round(oppW * TILE_RATIO)

    const aspect = w / boardH
    const colsTB = portrait ? 6 : aspect > 2 ? 10 : 8
    const colsLR = portrait ? 8 : 6
    const expect = 20 // ponytail: 依常見捨牌數 20 張配置牌河尺寸，極端長局溢出時向外延伸
    const rowsTB = Math.ceil(expect / colsTB)
    const rowsLR = Math.ceil(expect / colsLR)
    const innerHalfH = boardH / 2 - (oppH + 12 * u)
    const innerHalfW = w / 2 - (oppH + 12 * u)
    const rw = Math.floor(
      Math.max(
        12 * u,
        Math.min(
          40 * u,
          innerHalfH / (colsLR / 2 + rowsTB * TILE_RATIO + 0.2),
          innerHalfW / (colsTB / 2 + rowsLR * TILE_RATIO + 0.2),
        ),
      ),
    )
    const rh = Math.round(rw * TILE_RATIO)
    const cW = (colsTB * rw) / 2 + 3 * u
    const cH = (colsLR * rw) / 2 + 3 * u

    return { w, h, u, portrait, tileW, tileH, handRows, handZoneH, y0, y1, cx, cy, oppW, oppH, rw, rh, colsTB, colsLR, cW, cH }
  }

  // ───────────────────────── drawing ─────────────────────────

  private drawFelt(): void {
    const { width: w, height: h } = this.scale
    if (this.textures.exists('felt')) this.textures.remove('felt')
    const tex = this.textures.createCanvas('felt', Math.max(1, w), Math.max(1, h))
    if (!tex) return
    const ctx = tex.getContext()
    const g = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, Math.hypot(w, h) * 0.6)
    g.addColorStop(0, C.feltIn)
    g.addColorStop(1, C.feltOut)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    tex.refresh()
    if (this.bg) this.bg.destroy()
    this.bg = this.add.image(0, 0, 'felt').setOrigin(0).setDepth(-1)
  }

  private text(x: number, y: number, s: string, size: number, color = C.ivory, bold = true) {
    const t = this.add
      .text(x, y, s, { fontFamily: FONT, fontSize: `${Math.round(size)}px`, fontStyle: bold ? 'bold' : 'normal', color })
      .setOrigin(0.5)
    this.layer.add(t)
    return t
  }

  private tile(x: number, y: number, key: string, w: number, angle = 0) {
    const img = this.add.image(x, y, key).setDisplaySize(w, Math.round(w * TILE_RATIO)).setAngle(angle)
    this.layer.add(img)
    return img
  }

  private render(): void {
    if (!this.state || !this.ready) return
    this.tweens.killTweensOf(this.layer.list)
    this.layer.removeAll(true)
    const L = this.layout()

    const layoutKey = `${L.handZoneH}|${L.portrait}|${L.u}`
    if (layoutKey !== this.lastLayoutKey) {
      this.lastLayoutKey = layoutKey
      this.callbacks?.onLayout?.(L.handZoneH / L.u, L.portrait)
    }

    this.drawCompass(L)
    for (const seat of [0, 1, 2, 3] as const) {
      this.drawRiver(L, seat)
      if (this.rel(seat) === 0) this.drawSelfHand(L, seat)
      else this.drawOpponent(L, seat)
    }
  }

  private drawCompass(L: Layout): void {
    const s = this.state!
    const { cx, cy, cW, cH, u } = L
    const g = this.add.graphics()
    g.fillStyle(C.ink, 0.72)
    g.fillRoundedRect(cx - cW, cy - cH, cW * 2, cH * 2, 10 * u)
    g.lineStyle(1 * u, C.line, 0.9)
    g.strokeRoundedRect(cx - cW, cy - cH, cW * 2, cH * 2, 10 * u)
    this.layer.add(g)

    const small = Math.max(10 * u, Math.min(13 * u, cW / 9))
    const big = Math.max(18 * u, Math.min(30 * u, cH / 3.2))
    this.text(cx, cy - big * 0.75, `${ROUND_WIND[s.roundWind] ?? ''}${s.dealerStreak > 0 ? ` 連${s.dealerStreak}` : ''}`, small, C.muted)
    this.text(cx, cy + small * 0.1, `${s.remainingTiles}`, big, C.ivory)
    this.text(cx, cy + big * 0.72, '餘牌', small * 0.85, C.muted, false)

    // 四邊：風位徽章 + 分數（當前行動者以朱砂色脈動標示）
    const badge = Math.max(18 * u, Math.min(26 * u, cH / 3.4))
    for (const seat of [0, 1, 2, 3] as const) {
      const r = this.rel(seat)
      const p = s.seats[seat]
      const windIdx = (seat + 4 - s.dealerSeat) % 4
      const isTurn = s.currentSeat === seat && s.phase !== 'ROUND_SETTLEMENT'
      const inset = badge * 0.5 + 5 * u
      // 上下兩家：徽章在左、分數在右；左右兩家：徽章在上、分數在下
      const horizontal = r === 0 || r === 2
      const bx = r === 1 ? cx + cW - inset : r === 3 ? cx - cW + inset : cx - badge * 0.9
      const by = r === 0 ? cy + cH - inset : r === 2 ? cy - cH + inset : cy - small * 0.6
      const [sx, sy] = horizontal ? [cx + badge * 0.55, by] : [bx, by + badge * 0.5 + small * 0.85]

      const bg = this.add.graphics()
      bg.fillStyle(isTurn ? C.accent : 0x16263f, 1)
      bg.fillRoundedRect(bx - badge / 2, by - badge / 2, badge, badge, 6 * u)
      if (windIdx === 0) {
        bg.lineStyle(2 * u, C.gold, 1)
        bg.strokeRoundedRect(bx - badge / 2, by - badge / 2, badge, badge, 6 * u)
      }
      this.layer.add(bg)
      if (isTurn) {
        this.tweens.add({ targets: bg, alpha: 0.55, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      }
      this.text(bx, by, WIND[windIdx], badge * 0.6, isTurn ? '#fff' : windIdx === 0 ? '#e9c46a' : C.ivory)
      this.text(sx, sy, `${p.score}`, small, isTurn ? '#ffd2c8' : C.muted)
    }
  }

  private drawRiver(L: Layout, seat: SeatIndex): void {
    const s = this.state!
    const r = this.rel(seat)
    const { cx, cy, cW, cH, rw, rh, colsTB, colsLR, u } = L
    const cols = r === 0 || r === 2 ? colsTB : colsLR
    const discards = s.seats[seat].discards
    const gap = 1 * u
    discards.forEach((tid, i) => {
      const row = Math.floor(i / cols)
      const col = i % cols
      const along = (col - (cols - 1) / 2) * (rw + gap)
      const out = row * (rh + gap) + rh / 2 + 4 * u
      let x = cx
      let y = cy
      let angle = 0
      if (r === 0) [x, y] = [cx + along, cy + cH + out]
      else if (r === 2) [x, y, angle] = [cx - along, cy - cH - out, 180]
      else if (r === 1) [x, y, angle] = [cx + cW + out, cy - along, -90]
      else [x, y, angle] = [cx - cW - out, cy + along, 90]

      const img = this.tile(x, y, `tile_${kindOf(tid)}`, rw, angle)
      const isLast =
        s.lastDiscard?.seat === seat && i === discards.length - 1 && !s.lastDiscard.isChankanTarget
      if (!isLast) return

      const key = `${seat}-${discards.length}-${s.calloutSeq}`
      if (key !== this.lastDiscardKey) {
        this.lastDiscardKey = key
        const from = { 0: [cx, L.h], 1: [L.w, cy], 2: [cx, 0], 3: [0, cy] }[r]
        img.setPosition(from[0], from[1]).setScale(img.scaleX * 1.6, img.scaleY * 1.6)
        this.tweens.add({ targets: img, x, y, scaleX: img.scaleX / 1.6, scaleY: img.scaleY / 1.6, duration: 200, ease: 'Cubic.easeOut' })
      }
      const ring = this.add.graphics()
      const [bw, bh] = angle === 0 || angle === 180 ? [rw, rh] : [rh, rw]
      ring.lineStyle(2.5 * u, C.accent, 1)
      ring.strokeRoundedRect(x - bw / 2 - 2 * u, y - bh / 2 - 2 * u, bw + 4 * u, bh + 4 * u, 4 * u)
      this.layer.add(ring)
      this.tweens.add({ targets: ring, alpha: 0.25, duration: 520, yoyo: true, repeat: -1 })
    })
  }

  private drawSelfHand(L: Layout, seat: SeatIndex): void {
    const s = this.state!
    const p = s.seats[seat]
    const { w, h, u, tileW, tileH, portrait } = L
    const n = p.concealed.length
    const hasDraw = s.lastDrawnTile?.seat === seat && s.phase === 'TURN_ACTION_OR_DISCARD' && n % 3 === 2
    const canAct = s.phase === 'TURN_ACTION_OR_DISCARD' && s.currentSeat === seat && !p.isBot
    const gap = 2 * u
    const drawGap = tileW * 0.35
    const baseY = h - 8 * u - tileH / 2

    const drawTile = (tid: TileId, idx: number, x: number, y: number) => {
      const selected = this.selectedTileId === tid
      const allowed = !this.migiSelectMode || this.migiAllowed.has(tid)
      const locked = p.isMigi && (!hasDraw || idx < n - 1)
      const lift = selected ? tileH * 0.22 : 0
      const img = this.tile(x, y - lift, `tile_${kindOf(tid)}`, tileW)
      if (!allowed || locked) img.setTint(0x8a94a6)
      if (selected) {
        const glow = this.add.graphics()
        glow.lineStyle(3 * u, C.gold, 1)
        glow.strokeRoundedRect(x - tileW / 2 - 1.5 * u, y - lift - tileH / 2 - 1.5 * u, tileW + 3 * u, tileH + 3 * u, 6 * u)
        this.layer.add(glow)
      } else if (canAct && this.tenpaiDiscards.has(tid) && !p.isMigi) {
        const dot = this.add.circle(x, y - tileH / 2 - 6 * u, 3.5 * u, C.accent)
        this.layer.add(dot)
      }
      if (canAct && allowed && !locked) {
        img.setInteractive({ useHandCursor: true })
        img.on('pointerover', () => !selected && img.setY(y - tileH * 0.08))
        img.on('pointerout', () => !selected && img.setY(y))
        img.on('pointerdown', () =>
          selected ? this.callbacks?.onDiscardTile(tid) : this.callbacks?.onSelectTile(tid),
        )
      }
    }

    const meldW = Math.round(tileW * 0.72)
    const meldH = Math.round(meldW * TILE_RATIO)
    const flowerW = Math.round(tileW * 0.5)
    const drawMelds = (startX: number, y: number) => {
      let x = startX
      for (const m of p.melds) {
        m.tiles.forEach((tid, i) => {
          const back = m.type === 'ankan' && (i === 0 || i === 3)
          this.tile(x + meldW / 2, y, back ? 'tile_back' : `tile_${kindOf(tid)}`, meldW)
          x += meldW + 1 * u
        })
        x += 5 * u
      }
      return x
    }
    const drawFlowers = (startX: number, y: number) => {
      p.flowers.forEach((fid, i) => this.tile(startX + i * (flowerW + 1 * u) + flowerW / 2, y, `tile_${kindOf(fid)}`, flowerW))
    }

    if (portrait) {
      const perRow = 9
      const split = Math.max(0, n - perRow)
      const rows = split > 0 ? [p.concealed.slice(0, split), p.concealed.slice(split)] : [p.concealed]
      rows.forEach((row, ri) => {
        const isBottom = ri === rows.length - 1
        const y = isBottom ? baseY : baseY - tileH - 4 * u
        const offset = isBottom ? split : 0
        const extra = isBottom && hasDraw ? drawGap : 0
        let x = w / 2 - (row.length * (tileW + gap) + extra) / 2 + tileW / 2
        row.forEach((tid, i) => {
          const idx = offset + i
          if (hasDraw && idx === n - 1) x += drawGap
          drawTile(tid, idx, x, y)
          x += tileW + gap
        })
      })
      const topOfHand = baseY - tileH / 2 - (rows.length - 1) * (tileH + 4 * u) - tileH * 0.24
      const meldY = topOfHand - meldH / 2 - 2 * u
      drawMelds(8 * u, meldY)
      drawFlowers(w - 8 * u - p.flowers.length * (flowerW + 1 * u), meldY + (meldH - flowerW * TILE_RATIO) / 2)
      return
    }

    const meldTotal = p.melds.reduce((a, m) => a + m.tiles.length * (meldW + 1 * u) + 5 * u, 0)
    const flowerTotal = p.flowers.length * (flowerW + 1 * u)
    const total =
      n * (tileW + gap) + (hasDraw ? drawGap : 0) + (meldTotal ? meldTotal + 12 * u : 0) + (flowerTotal ? flowerTotal + 8 * u : 0)
    let x = w / 2 - total / 2 + tileW / 2
    p.concealed.forEach((tid, i) => {
      if (hasDraw && i === n - 1) x += drawGap
      drawTile(tid, i, x, baseY)
      x += tileW + gap
    })
    let after = x - tileW / 2 + 12 * u
    if (meldTotal) after = drawMelds(after, baseY + (tileH - meldH) / 2) + 8 * u
    if (flowerTotal) drawFlowers(after, baseY + (tileH - flowerW * TILE_RATIO) / 2)
  }

  private drawOpponent(L: Layout, seat: SeatIndex): void {
    const s = this.state!
    const p = s.seats[seat]
    const r = this.rel(seat)
    const { w, cx, cy, y0, u, oppW, oppH } = L
    const reveal = s.phase === 'ROUND_SETTLEMENT'
    const handKey = (tid: TileId) => (reveal ? `tile_${kindOf(tid)}` : 'tile_back')
    const items: { key: string; gapBefore: number }[] = [
      ...p.concealed.map((t) => ({ key: handKey(t), gapBefore: 0 })),
      ...p.melds.flatMap((m) =>
        m.tiles.map((t, i) => ({
          key: m.type === 'ankan' && (i === 0 || i === 3) ? 'tile_back' : `tile_${kindOf(t)}`,
          gapBefore: i === 0 ? 5 * u : 0,
        })),
      ),
      ...p.flowers.map((t, i) => ({ key: `tile_${kindOf(t)}`, gapBefore: i === 0 ? 7 * u : 0 })),
    ]
    const step = oppW + 1 * u
    const len = items.reduce((a, it) => a + step + it.gapBefore, 0)
    const windIdx = (seat + 4 - s.dealerSeat) % 4
    const label = `${WIND[windIdx]}${windIdx === 0 ? '莊' : ''} · ${p.name}${p.isMigi ? ' · 聽' : ''}`
    const fs = Math.max(10 * u, Math.min(13 * u, oppW * 0.62))
    const isTurn = s.currentSeat === seat && s.phase !== 'ROUND_SETTLEMENT'
    const labelColor = isTurn ? '#ffb4a3' : p.isMigi ? '#e9c46a' : C.muted

    if (r === 2) {
      const y = y0 + oppH / 2 + 4 * u
      let x = cx + len / 2 - step / 2
      for (const it of items) {
        x -= it.gapBefore
        this.tile(x, y, it.key, oppW, 180)
        x -= step
      }
      const t = this.text(0, 0, label, fs, labelColor)
      const leftRoom = cx - len / 2 - 10 * u
      if (t.width + 8 * u <= leftRoom) t.setPosition(leftRoom - t.width / 2, y)
      else t.setPosition(cx, y + oppH / 2 + fs)
      return
    }

    const x = r === 1 ? w - 6 * u - oppH / 2 : 6 * u + oppH / 2
    const angle = r === 1 ? -90 : 90
    let y = r === 1 ? cy + len / 2 - step / 2 : cy - len / 2 + step / 2
    for (const it of items) {
      y += r === 1 ? -it.gapBefore : it.gapBefore
      this.tile(x, y, it.key, oppW, angle)
      y += r === 1 ? -step : step
    }
    const t = this.text(0, 0, label, fs, labelColor)
    t.setOrigin(r === 1 ? 1 : 0, 0.5)
    t.setPosition(r === 1 ? w - 6 * u : 6 * u, cy - len / 2 - fs)
  }

  // ───────────────────────── VFX ─────────────────────────

  /** 吃/碰/槓/聽/胡/自摸 朱砂方印蓋章動畫 */
  private playCallout(seat: SeatIndex, label: string): void {
    const L = this.layout()
    const r = this.rel(seat)
    const { cx, cy, cW, cH, u } = L
    const dist = 0.5
    const pos = {
      0: [cx, cy + cH + (L.y1 - cy - cH) * dist],
      1: [cx + cW + (L.w - cx - cW) * dist, cy],
      2: [cx, cy - cH - (cy - cH - L.y0) * dist],
      3: [cx - cW - (cx - cW) * dist, cy],
    }[r]
    const win = label === '胡' || label === '自摸'
    if (win || label === '槓') this.cameras.main.shake(200, 0.005)

    const size = (win ? 92 : 68) * u * Math.min(1, L.w / (720 * u) + 0.25)
    const box = this.add.container(pos[0], pos[1])
    const g = this.add.graphics()
    g.fillStyle(win ? C.accent : 0x16263f, 0.96)
    g.fillRoundedRect(-size / 2, -size / 2, size, size, 12 * u)
    g.lineStyle(3 * u, win ? 0xffe1d6 : C.gold, 1)
    g.strokeRoundedRect(-size / 2 + 5 * u, -size / 2 + 5 * u, size - 10 * u, size - 10 * u, 8 * u)
    const t = this.add
      .text(0, 0, label, {
        fontFamily: `"Noto Serif TC","PMingLiU",${FONT}`,
        fontSize: `${Math.round(size * (label.length > 1 ? 0.36 : 0.55))}px`,
        fontStyle: 'bold',
        color: win ? '#fff' : '#f4ecdc',
      })
      .setOrigin(0.5)
    box.add([g, t]).setAngle(-8).setScale(2.4).setAlpha(0)
    this.fx.add(box)

    const ring = this.add.circle(pos[0], pos[1], size * 0.5).setStrokeStyle(3 * u, win ? C.accent : C.gold).setAlpha(0)
    this.fx.add(ring)

    this.tweens.add({
      targets: box,
      scale: 1,
      alpha: 1,
      duration: 200,
      ease: 'Back.easeOut',
      onComplete: () => {
        ring.setAlpha(0.9)
        this.tweens.add({ targets: ring, scale: 2.2, alpha: 0, duration: 450, onComplete: () => ring.destroy() })
        this.tweens.add({ targets: box, alpha: 0, delay: 650, duration: 260, onComplete: () => box.destroy() })
      },
    })
  }
}
