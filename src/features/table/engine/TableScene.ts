import Phaser from 'phaser'
import { kindOf, type SeatIndex, type TileId } from '@/shared/kernel/types'
import type { TableState } from '../domain/tableState'

export interface TableSceneCallbacks {
  onSelectTile: (tileId: TileId | null) => void
  onDiscardTile: (tileId: TileId) => void
  /** 回報本家手牌區頂端（CSS px，自畫面底部起算），供 DOM 操作列貼齊手牌上緣 */
  onLayout?: (handZoneCssHeight: number, portrait: boolean, sideInsetCss: number) => void
}

type Rel = 0 | 1 | 2 | 3

const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif'
const SERIF = `"Noto Serif TC","Songti TC","PMingLiU",${FONT}`
/** 「朱漆黃銅」配色，與 style.css 的 CSS 變數一致 */
const C = {
  woodHi: '#3a2618',
  wood: '#1f140e',
  woodDeep: '#120b08',
  feltIn: '#7a2a35',
  feltMid: '#561b25',
  feltOut: '#2b0c13',
  lacquer: 0x140d0a,
  lacquerHi: 0x2a1b12,
  brass: 0xd4a64a,
  brassHi: 0xf1d38a,
  jade: 0x3fae82,
  cinnabar: 0xe0482f,
  ivory: '#f3e9d2',
  muted: '#b5a48a',
  faint: '#7d6d58',
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
 * 版面：胡桃木框酒紅絨布、上方對家、左右兩家直列、中央漆盒電子台（風位 + 分數 + 餘牌 + 輪次燈）、
 * 四方牌河、底部本家牌架。
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
  /** 畫布像素 / CSS 像素；由 TableArena 依實際畫布設定，排版一律以此為單位 */
  private u = 1

  private bg!: Phaser.GameObjects.Image
  private layer!: Phaser.GameObjects.Container
  private fx!: Phaser.GameObjects.Container

  constructor() {
    super('TableScene')
  }

  bindCallbacks(cb: TableSceneCallbacks): void {
    this.callbacks = cb
  }

  setDpr(dpr: number): void {
    this.u = dpr
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
    // 開局補花等「場景建立前」就產生的宣告，在此補播
    const opening = this.state?.lastCallout
    if (opening && opening.id !== this.lastCalloutId) {
      this.lastCalloutId = opening.id
      this.playCallout(opening.seat, opening.label)
    }
    this.scale.on('resize', () => {
      this.drawFelt()
      this.render()
    })
    // 網頁字型載入後重繪，避免 canvas 文字停留在後備字型
    document.fonts?.ready.then(() => this.ready && this.render())
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

  private dpr(): number {
    return this.u
  }

  private layout(): Layout {
    const w = this.scale.width
    const h = this.scale.height
    const u = this.dpr()
    const portrait = h > w * 1.05
    const compact = !portrait && h / u < 520
    const self = this.state!.seats[this.localSeat]
    const meldTiles = self.melds.reduce((a, m) => a + m.tiles.length, 0)
    const concealedSlots = (5 - self.melds.length) * 3 + 2

    let tileW: number
    let handRows: 1 | 2 = 1
    if (portrait) {
      handRows = concealedSlots > 9 ? 2 : 1
      tileW = Math.min(58 * u, Math.floor((w - 24 * u) / 9.9))
    } else {
      const slots = concealedSlots + 0.6 + meldTiles * 0.78 + self.melds.length * 0.2 + self.flowers.length * 0.5 + 0.6
      tileW = Math.min(64 * u, h * 0.12, Math.floor((w - 32 * u) / slots))
    }
    tileW = Math.max(22 * u, tileW)
    const tileH = Math.round(tileW * TILE_RATIO)
    const lift = tileH * 0.24
    const bottomPad = 10 * u
    const meldRow = portrait ? Math.round(tileH * 0.72) + 6 * u : 0
    const handZoneH = handRows * tileH + (handRows - 1) * 4 * u + lift + bottomPad + meldRow

    const y0 = compact ? 12 * u : 54 * u
    const y1 = h - handZoneH
    const cx = w / 2
    const cy = (y0 + y1) / 2
    const boardH = y1 - y0
    const oppW = Math.round(Math.max(14 * u, Math.min(26 * u, Math.min(w, boardH * 1.3) / 30)))
    const oppH = Math.round(oppW * TILE_RATIO)

    const aspect = w / boardH
    const colsTB = portrait ? 6 : aspect > 2 ? 10 : 8
    const colsLR = portrait ? 8 : 6
    const expect = 20 // ponytail: 依常見捨牌數 20 張配置牌河尺寸，極端長局溢出時向外延伸
    const rowsTB = Math.ceil(expect / colsTB)
    const rowsLR = Math.ceil(expect / colsLR)
    const innerHalfH = boardH / 2 - (oppH + 14 * u)
    const innerHalfW = w / 2 - (oppH + 14 * u)
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

  /** 胡桃木框 + 酒紅絨布 + 黃銅鑲線（整張烘成一張貼圖，不隨狀態重繪） */
  private drawFelt(): void {
    const { width: w, height: h } = this.scale
    const u = this.dpr()
    if (this.textures.exists('felt')) this.textures.remove('felt')
    const tex = this.textures.createCanvas('felt', Math.max(1, w), Math.max(1, h))
    if (!tex) return
    const ctx = tex.getContext()

    const wood = ctx.createLinearGradient(0, 0, 0, h)
    wood.addColorStop(0, C.woodHi)
    wood.addColorStop(0.5, C.wood)
    wood.addColorStop(1, C.woodDeep)
    ctx.fillStyle = wood
    ctx.fillRect(0, 0, w, h)
    ctx.globalAlpha = 0.05
    ctx.fillStyle = '#000'
    for (let x = 0; x < w; x += 7 * u) ctx.fillRect(x, 0, 1.5 * u, h)
    ctx.globalAlpha = 1

    const m = Math.round((w < 700 * u ? 5 : 10) * u)
    const r = 22 * u
    const roundRect = (x: number, y: number, rw: number, rh: number, rr: number) => {
      ctx.beginPath()
      ctx.moveTo(x + rr, y)
      ctx.arcTo(x + rw, y, x + rw, y + rh, rr)
      ctx.arcTo(x + rw, y + rh, x, y + rh, rr)
      ctx.arcTo(x, y + rh, x, y, rr)
      ctx.arcTo(x, y, x + rw, y, rr)
      ctx.closePath()
    }

    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = 18 * u
    roundRect(m, m, w - 2 * m, h - 2 * m, r)
    const felt = ctx.createRadialGradient(w / 2, h * 0.44, 0, w / 2, h * 0.44, Math.hypot(w, h) * 0.58)
    felt.addColorStop(0, C.feltIn)
    felt.addColorStop(0.55, C.feltMid)
    felt.addColorStop(1, C.feltOut)
    ctx.fillStyle = felt
    ctx.fill()
    ctx.restore()

    // 絨布纖維雜訊
    ctx.save()
    roundRect(m, m, w - 2 * m, h - 2 * m, r)
    ctx.clip()
    const dots = Math.min(9000, Math.round((w * h) / (260 * u * u)))
    for (let i = 0; i < dots; i++) {
      ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.08)'
      ctx.fillRect(Math.random() * w, Math.random() * h, u, u)
    }
    ctx.restore()

    ctx.lineWidth = 1 * u
    ctx.strokeStyle = 'rgba(212,166,74,0.45)'
    roundRect(m + 0.5 * u, m + 0.5 * u, w - 2 * m - u, h - 2 * m - u, r)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(212,166,74,0.16)'
    const i2 = m + 7 * u
    roundRect(i2, i2, w - 2 * i2, h - 2 * i2, r - 6 * u)
    ctx.stroke()

    tex.refresh()
    if (this.bg) this.bg.destroy()
    this.bg = this.add.image(0, 0, 'felt').setOrigin(0).setDepth(-1)
  }

  private text(x: number, y: number, s: string, size: number, color = C.ivory, bold = true, family = FONT) {
    const t = this.add
      .text(x, y, s, {
        fontFamily: family,
        fontSize: `${Math.round(size)}px`,
        fontStyle: bold ? 'bold' : 'normal',
        color,
        resolution: 1,
      })
      .setOrigin(0.5)
    this.layer.add(t)
    return t
  }

  /** 牌面 + 落地陰影（陰影向「畫面下方」偏移，旋轉後仍保持同一光源） */
  private tile(x: number, y: number, key: string, w: number, angle = 0, shadow = true) {
    const h = Math.round(w * TILE_RATIO)
    if (shadow) {
      const u = this.dpr()
      const [sw, sh] = angle === 0 || angle === 180 ? [w, h] : [h, w]
      const s = this.add.graphics()
      s.fillStyle(0x000000, 0.32)
      s.fillRoundedRect(x - sw / 2 + 0.5 * u, y - sh / 2 + Math.max(1.5 * u, w * 0.06), sw, sh, Math.max(2 * u, w * 0.12))
      this.layer.add(s)
    }
    const img = this.add.image(x, y, key).setDisplaySize(w, h).setAngle(angle)
    this.layer.add(img)
    return img
  }

  private render(): void {
    if (!this.state || !this.ready) return
    this.tweens.killTweensOf(this.layer.list)
    this.layer.removeAll(true)
    const L = this.layout()

    const side = this.edgeInset(L) + L.oppH
    const layoutKey = `${L.handZoneH}|${L.portrait}|${L.u}|${side}`
    if (layoutKey !== this.lastLayoutKey) {
      this.lastLayoutKey = layoutKey
      this.callbacks?.onLayout?.(L.handZoneH / L.u, L.portrait, side / L.u)
    }

    this.drawRack(L)
    this.drawCompass(L)
    for (const seat of [0, 1, 2, 3] as const) {
      this.drawRiver(L, seat)
      if (this.rel(seat) === 0) this.drawSelfHand(L, seat)
      else this.drawOpponent(L, seat)
    }
  }

  /** 木框 + 內緣留白：他家手牌與名牌貼齊的邊界 */
  private edgeInset(L: Layout): number {
    return (L.w < 700 * L.u ? 5 : 10) * L.u + 8 * L.u
  }

  /** 本家牌架：手牌底下的暗色木條，讓手牌有「立著」的落點 */
  private drawRack(L: Layout): void {
    const { w, h, u, tileH } = L
    const g = this.add.graphics()
    const top = h - 10 * u - tileH * 0.42
    g.fillStyle(0x000000, 0.28)
    g.fillRoundedRect(8 * u, top, w - 16 * u, h - top - 4 * u, 10 * u)
    g.lineStyle(1 * u, C.brass, 0.22)
    g.lineBetween(18 * u, top, w - 18 * u, top)
    this.layer.add(g)
  }

  /** 中央漆盒電子台：圈風 / 餘牌 / 四家風位與分數；朝向當前行動者的一側亮起玉綠燈條 */
  private drawCompass(L: Layout): void {
    const s = this.state!
    const { cx, cy, cW, cH, u } = L
    const g = this.add.graphics()
    g.fillStyle(0x000000, 0.35)
    g.fillRoundedRect(cx - cW + 2 * u, cy - cH + 4 * u, cW * 2, cH * 2, 14 * u)
    g.fillStyle(C.lacquer, 0.94)
    g.fillRoundedRect(cx - cW, cy - cH, cW * 2, cH * 2, 14 * u)
    g.lineStyle(1.5 * u, C.brass, 0.75)
    g.strokeRoundedRect(cx - cW, cy - cH, cW * 2, cH * 2, 14 * u)
    g.lineStyle(1 * u, C.brass, 0.2)
    g.strokeRoundedRect(cx - cW + 5 * u, cy - cH + 5 * u, cW * 2 - 10 * u, cH * 2 - 10 * u, 10 * u)
    this.layer.add(g)

    const small = Math.max(11 * u, Math.min(13 * u, cW / 9))
    const big = Math.max(18 * u, Math.min(32 * u, cH / 3))
    this.text(
      cx,
      cy - big * 0.8,
      `${ROUND_WIND[s.roundWind] ?? ''}${s.dealerStreak > 0 ? ` · 連${s.dealerStreak}` : ''}`,
      small,
      C.muted,
      true,
      SERIF,
    )
    const low = s.remainingTiles <= 24
    this.text(cx, cy + small * 0.05, `${s.remainingTiles}`, big, low ? '#ff9c85' : '#f1d38a', true, SERIF)
    this.text(cx, cy + big * 0.72, '餘牌', Math.max(10 * u, small * 0.82), C.faint, false)

    const badge = Math.max(18 * u, Math.min(26 * u, cH / 3.4))
    for (const seat of [0, 1, 2, 3] as const) {
      const r = this.rel(seat)
      const p = s.seats[seat]
      const windIdx = (seat + 4 - s.dealerSeat) % 4
      const isTurn = s.currentSeat === seat && s.phase !== 'ROUND_SETTLEMENT'
      const horizontal = r === 0 || r === 2
      // 左右兩家分數置於徽章下方，以 5 位數寬度內縮，避免超出漆盒邊框
      const inset = (horizontal ? badge * 0.5 : Math.max(badge * 0.5, small * 1.7)) + 8 * u
      const bx = r === 1 ? cx + cW - inset : r === 3 ? cx - cW + inset : cx - badge * 0.95
      const by = r === 0 ? cy + cH - inset : r === 2 ? cy - cH + inset : cy - small * 0.6
      const [sx, sy] = horizontal ? [cx + badge * 0.6, by] : [bx, by + badge * 0.5 + small * 0.9]

      if (isTurn) {
        const bar = this.add.graphics()
        bar.fillStyle(C.jade, 1)
        const len = (horizontal ? cW : cH) * 1.2
        const th = 3 * u
        if (r === 0) bar.fillRoundedRect(cx - len / 2, cy + cH - th - 1 * u, len, th, th / 2)
        else if (r === 2) bar.fillRoundedRect(cx - len / 2, cy - cH + 1 * u, len, th, th / 2)
        else if (r === 1) bar.fillRoundedRect(cx + cW - th - 1 * u, cy - len / 2, th, len, th / 2)
        else bar.fillRoundedRect(cx - cW + 1 * u, cy - len / 2, th, len, th / 2)
        this.layer.add(bar)
        this.tweens.add({ targets: bar, alpha: 0.35, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      }

      const bg = this.add.graphics()
      bg.fillStyle(isTurn ? C.jade : windIdx === 0 ? C.cinnabar : C.lacquerHi, 1)
      bg.fillRoundedRect(bx - badge / 2, by - badge / 2, badge, badge, 6 * u)
      bg.lineStyle(1 * u, windIdx === 0 ? C.brassHi : C.brass, windIdx === 0 ? 0.9 : 0.4)
      bg.strokeRoundedRect(bx - badge / 2, by - badge / 2, badge, badge, 6 * u)
      this.layer.add(bg)
      this.text(bx, by, WIND[windIdx], badge * 0.6, isTurn || windIdx === 0 ? '#ffffff' : C.ivory, true, SERIF)
      this.text(sx, sy, `${p.score}`, small, isTurn ? '#a8f0cf' : C.muted)
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
      const out = row * (rh + gap) + rh / 2 + 6 * u
      let x = cx
      let y = cy
      let angle = 0
      if (r === 0) [x, y] = [cx + along, cy + cH + out]
      else if (r === 2) [x, y, angle] = [cx - along, cy - cH - out, 180]
      else if (r === 1) [x, y, angle] = [cx + cW + out, cy - along, -90]
      else [x, y, angle] = [cx - cW - out, cy + along, 90]

      const isLast =
        s.lastDiscard?.seat === seat && i === discards.length - 1 && !s.lastDiscard.isChankanTarget
      const img = this.tile(x, y, `tile_${kindOf(tid)}`, rw, angle, !isLast)
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
      ring.lineStyle(2.5 * u, C.cinnabar, 1)
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
    const baseY = h - 10 * u - tileH / 2

    const drawTile = (tid: TileId, idx: number, x: number, y: number) => {
      const selected = this.selectedTileId === tid
      const allowed = !this.migiSelectMode || this.migiAllowed.has(tid)
      const locked = p.isMigi && (!hasDraw || idx < n - 1)
      const lift = selected ? tileH * 0.22 : 0
      const img = this.tile(x, y - lift, `tile_${kindOf(tid)}`, tileW)
      if (!allowed || locked) img.setTint(0x8f8578)
      if (selected) {
        const glow = this.add.graphics()
        glow.lineStyle(3 * u, C.brassHi, 1)
        glow.strokeRoundedRect(x - tileW / 2 - 1.5 * u, y - lift - tileH / 2 - 1.5 * u, tileW + 3 * u, tileH + 3 * u, 6 * u)
        this.layer.add(glow)
      } else if (canAct && this.tenpaiDiscards.has(tid) && !p.isMigi) {
        // 打這張可聽牌：牌頂玉綠小三角
        const tri = this.add.triangle(x, y - tileH / 2 - 6 * u, 0, 0, 9 * u, 0, 4.5 * u, 6 * u, C.jade)
        this.layer.add(tri)
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
        x += 6 * u
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
      drawMelds(12 * u, meldY)
      drawFlowers(w - 12 * u - p.flowers.length * (flowerW + 1 * u), meldY + (meldH - flowerW * TILE_RATIO) / 2)
      return
    }

    const meldTotal = p.melds.reduce((a, m) => a + m.tiles.length * (meldW + 1 * u) + 6 * u, 0)
    const flowerTotal = p.flowers.length * (flowerW + 1 * u)
    const total =
      n * (tileW + gap) + (hasDraw ? drawGap : 0) + (meldTotal ? meldTotal + 14 * u : 0) + (flowerTotal ? flowerTotal + 10 * u : 0)
    let x = w / 2 - total / 2 + tileW / 2
    p.concealed.forEach((tid, i) => {
      if (hasDraw && i === n - 1) x += drawGap
      drawTile(tid, i, x, baseY)
      x += tileW + gap
    })
    let after = x - tileW / 2 + 14 * u
    if (meldTotal) after = drawMelds(after, baseY + (tileH - meldH) / 2) + 10 * u
    if (flowerTotal) drawFlowers(after, baseY + (tileH - flowerW * TILE_RATIO) / 2)
  }

  private plateSize(seat: SeatIndex, fs: number): { w: number; h: number } {
    const u = this.dpr()
    const t = this.add.text(0, 0, this.state!.seats[seat].name, { fontFamily: FONT, fontSize: `${Math.round(fs)}px`, fontStyle: 'bold' })
    const nameW = t.width
    t.destroy()
    const seal = fs * 1.55
    const tagW = this.state!.seats[seat].isMigi ? fs * 1.35 + 5 * u : 0
    return { w: 3 * u + seal + 6 * u + nameW + tagW + 9 * u, h: seal + 6 * u }
  }

  /** 他家名牌：風位印 + 名字（+ 聽），輪到時玉綠描邊 */
  private plate(
    x: number,
    y: number,
    align: 'left' | 'right' | 'center',
    seat: SeatIndex,
    fs: number,
  ): { w: number; h: number } {
    const s = this.state!
    const p = s.seats[seat]
    const u = this.dpr()
    const windIdx = (seat + 4 - s.dealerSeat) % 4
    const isTurn = s.currentSeat === seat && s.phase !== 'ROUND_SETTLEMENT'
    const seal = fs * 1.55
    const name = this.add
      .text(0, 0, p.name, { fontFamily: FONT, fontSize: `${Math.round(fs)}px`, fontStyle: 'bold', color: isTurn ? '#ffffff' : C.ivory })
      .setOrigin(0, 0.5)
    const tag = p.isMigi
      ? this.add
          .text(0, 0, '聽', { fontFamily: SERIF, fontSize: `${Math.round(fs * 0.9)}px`, fontStyle: 'bold', color: '#2a1a07' })
          .setOrigin(0.5)
      : null
    const tagW = tag ? fs * 1.35 : 0
    const padL = 3 * u
    const padR = 9 * u
    const pw = padL + seal + 6 * u + name.width + (tag ? 5 * u + tagW : 0) + padR
    const ph = seal + 6 * u
    const left = align === 'left' ? x : align === 'right' ? x - pw : x - pw / 2
    const top = y - ph / 2

    const g = this.add.graphics()
    g.fillStyle(C.lacquer, 0.82)
    g.fillRoundedRect(left, top, pw, ph, ph / 2)
    g.lineStyle(1.5 * u, isTurn ? C.jade : C.brass, isTurn ? 1 : 0.3)
    g.strokeRoundedRect(left, top, pw, ph, ph / 2)
    const sx = left + padL + seal / 2
    g.fillStyle(windIdx === 0 ? C.cinnabar : isTurn ? C.jade : C.lacquerHi, 1)
    g.fillCircle(sx, y, seal / 2)
    this.layer.add(g)
    if (isTurn) this.tweens.add({ targets: g, alpha: 0.7, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })

    this.text(sx, y, WIND[windIdx], seal * 0.58, '#ffffff', true, SERIF)
    name.setPosition(left + padL + seal + 6 * u, y)
    this.layer.add(name)
    if (tag) {
      const tx = name.x + name.width + 5 * u + tagW / 2
      const tg = this.add.graphics()
      tg.fillStyle(C.brass, 1)
      tg.fillRoundedRect(tx - tagW / 2, y - tagW / 2, tagW, tagW, 4 * u)
      this.layer.add(tg)
      tag.setPosition(tx, y)
      this.layer.add(tag)
    }
    return { w: pw, h: ph }
  }

  private drawOpponent(L: Layout, seat: SeatIndex): void {
    const s = this.state!
    const p = s.seats[seat]
    const r = this.rel(seat)
    const { w, cx, cy, y0, u, oppW, oppH, portrait } = L
    const reveal = s.phase === 'ROUND_SETTLEMENT'
    // 防作弊牌局在稽核完成前，他家暗牌仍是未知（負值佔位）
    const handKey = (tid: TileId) => (reveal && tid >= 0 ? `tile_${kindOf(tid)}` : 'tile_back')
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
    const fs = Math.max(11 * u, Math.min(14 * u, oppW * 0.62))
    const edge = this.edgeInset(L)

    if (r === 2) {
      const y = y0 + oppH / 2 + 4 * u
      let x = cx + len / 2 - step / 2
      for (const it of items) {
        x -= it.gapBefore
        this.tile(x, y, it.key, oppW, 180)
        x -= step
      }
      // 名牌放手牌左側；空間不足（直式）時放到手牌下方
      const leftEdge = cx - len / 2 - 10 * u
      const probe = this.plateSize(seat, fs)
      if (probe.w + edge <= leftEdge) this.plate(leftEdge, y, 'right', seat, fs)
      else this.plate(cx, y + oppH / 2 + probe.h / 2 + 4 * u, 'center', seat, fs)
      return
    }

    // 直列不得伸進頂部資訊列（約 54px）：矮橫式時改在資訊列與牌架之間置中，放不下就等比縮小
    const bandTop = 56 * u
    const bandBot = L.y1 - 6 * u
    let colCy = cy
    let k = 1
    if (cy - len / 2 < bandTop) {
      colCy = (bandTop + bandBot) / 2
      k = Math.min(1, (bandBot - bandTop) / len)
    }
    const colLen = len * k
    const x = r === 1 ? w - edge - oppH / 2 + 4 * u : edge + oppH / 2 - 4 * u
    const angle = r === 1 ? -90 : 90
    let y = r === 1 ? colCy + colLen / 2 - (step * k) / 2 : colCy - colLen / 2 + (step * k) / 2
    for (const it of items) {
      y += (r === 1 ? -it.gapBefore : it.gapBefore) * k
      this.tile(x, y, it.key, oppW * k, angle)
      y += (r === 1 ? -step : step) * k
    }
    // 名牌預設在直列上方；會撞到頂部資訊列時改貼在直列內側、資訊列下方
    const ph = this.plateSize(seat, fs).h
    const above = colCy - colLen / 2 - ph / 2 - (portrait ? 4 * u : 6 * u)
    if (above - ph / 2 >= 54 * u) {
      this.plate(r === 1 ? w - edge + 4 * u : edge - 4 * u, above, r === 1 ? 'right' : 'left', seat, fs)
    } else {
      const inner = edge + oppH + 2 * u
      const py = Math.max(56 * u + ph / 2, colCy - colLen / 2 + ph / 2)
      this.plate(r === 1 ? w - inner : inner, py, r === 1 ? 'right' : 'left', seat, fs)
    }
  }

  // ───────────────────────── VFX ─────────────────────────

  /** 吃/碰/槓/聽/胡/自摸 方印蓋章動畫：胡牌朱砂，其餘黑漆黃銅 */
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

    const size = (win ? 96 : 70) * u * Math.min(1, L.w / (720 * u) + 0.25)
    const box = this.add.container(pos[0], pos[1])
    const g = this.add.graphics()
    g.fillStyle(0x000000, 0.4)
    g.fillRoundedRect(-size / 2 + 3 * u, -size / 2 + 6 * u, size, size, 14 * u)
    g.fillStyle(win ? C.cinnabar : C.lacquer, 0.97)
    g.fillRoundedRect(-size / 2, -size / 2, size, size, 14 * u)
    g.lineStyle(3 * u, win ? 0xffe1d6 : C.brass, 1)
    g.strokeRoundedRect(-size / 2 + 5 * u, -size / 2 + 5 * u, size - 10 * u, size - 10 * u, 9 * u)
    const t = this.add
      .text(0, 0, label, {
        fontFamily: SERIF,
        fontSize: `${Math.round(size * (label.length > 1 ? 0.36 : 0.56))}px`,
        fontStyle: 'bold',
        color: win ? '#ffffff' : '#f1d38a',
      })
      .setOrigin(0.5)
    box.add([g, t]).setAngle(-8).setScale(2.4).setAlpha(0)
    this.fx.add(box)

    const ring = this.add.circle(pos[0], pos[1], size * 0.5).setStrokeStyle(3 * u, win ? C.cinnabar : C.brass).setAlpha(0)
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
