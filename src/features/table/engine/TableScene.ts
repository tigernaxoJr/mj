import Phaser from 'phaser'
import { kindOf, type SeatIndex, type TileId } from '@/shared/kernel/types'
import type { TableState } from '../domain/tableState'

export interface TableSceneCallbacks {
  onSelectTile: (tileId: TileId | null) => void
  onDiscardTile: (tileId: TileId) => void
}

const WIND_CHARS: Record<SeatIndex, string> = { 0: '東', 1: '南', 2: '西', 3: '北' }
const ROUND_WIND_LABELS: Record<string, string> = {
  east: '東風圈',
  south: '南風圈',
  west: '西風圈',
  north: '北風圈',
}

export class TableScene extends Phaser.Scene {
  private callbacks: TableSceneCallbacks | null = null
  private currentState: TableState | null = null
  private localSeat: SeatIndex = 0
  private selectedTileId: TileId | null = null
  private migiSelectMode = false
  private migiAllowedTiles: Set<TileId> = new Set()
  private isReady = false
  private lastCalloutId = 0

  private boardLayer!: Phaser.GameObjects.Container
  private dynamicLayer!: Phaser.GameObjects.Container
  private fxLayer!: Phaser.GameObjects.Container

  constructor() {
    super('TableScene')
  }

  public bindCallbacks(cb: TableSceneCallbacks): void {
    this.callbacks = cb
  }

  preload(): void {
    for (let k = 0; k < 42; k++) {
      this.load.image(`tile_${k}`, `assets/tiles/tile_${k}.png`)
    }
    this.load.image('tile_back', 'assets/tiles/tile_back.png')
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#042f2e')
    this.boardLayer = this.add.container(0, 0)
    this.dynamicLayer = this.add.container(0, 0)
    this.fxLayer = this.add.container(0, 0)
    this.isReady = true

    this.drawStaticTable()
    if (this.currentState) {
      this.renderTableState()
    }

    this.scale.on('resize', () => {
      if (!this.isReady) return
      this.drawStaticTable()
      this.renderTableState()
    })
  }

  public syncState(
    state: TableState,
    localSeat: SeatIndex,
    selectedTileId: TileId | null,
    migiSelectMode: boolean,
    migiAllowedTiles: readonly TileId[],
  ): void {
    this.currentState = state
    this.localSeat = localSeat
    this.selectedTileId = selectedTileId
    this.migiSelectMode = migiSelectMode
    this.migiAllowedTiles = new Set(migiAllowedTiles)

    if (!this.isReady) return

    if (state.lastCallout && state.lastCallout.id !== this.lastCalloutId) {
      this.lastCalloutId = state.lastCallout.id
      this.playCalloutVfx(state.lastCallout.seat, state.lastCallout.label)
    }

    this.renderTableState()
  }

  /** 將絕對座位 `0..3` 轉為相對於本家的畫面方位：`0=下(本家), 1=右(下家), 2=上(對家), 3=左(上家)` */
  private relativePos(seat: SeatIndex): 0 | 1 | 2 | 3 {
    return ((seat + 4 - this.localSeat) % 4) as 0 | 1 | 2 | 3
  }

  private drawStaticTable(): void {
    this.boardLayer.removeAll(true)
    const w = this.scale.width
    const h = this.scale.height
    const g = this.add.graphics()

    // 外框木紋邊界与祖母綠絨布桌面
    g.fillStyle(0x27170c, 1)
    g.fillRect(0, 0, w, h)

    g.fillStyle(0x064e3b, 1)
    g.fillRoundedRect(10, 10, w - 20, h - 20, 18)

    g.lineStyle(2, 0xd97706, 0.35)
    g.strokeRoundedRect(16, 16, w - 32, h - 32, 14)

    // 中央桌面暗紋圓環
    const cx = w / 2
    const cy = h / 2 - 12
    g.lineStyle(1, 0x10b981, 0.14)
    g.strokeCircle(cx, cy, Math.min(w, h) * 0.28)
    g.strokeCircle(cx, cy, Math.min(w, h) * 0.21)

    this.boardLayer.add(g)
  }

  private renderTableState(): void {
    if (!this.currentState) return
    this.dynamicLayer.removeAll(true)

    const w = this.scale.width
    const h = this.scale.height
    const cx = w / 2
    const cy = h / 2 - 14

    this.renderCenterCompass(cx, cy)

    for (const seat of [0, 1, 2, 3] as const) {
      this.renderSeatRiver(seat, cx, cy)
      this.renderSeatHandAndMelds(seat, w, h, cx, cy)
    }
  }

  private renderCenterCompass(cx: number, cy: number): void {
    const state = this.currentState!
    const boxSize = 116
    const g = this.add.graphics()

    g.fillStyle(0x022c22, 0.94)
    g.fillRoundedRect(cx - boxSize / 2, cy - boxSize / 2, boxSize, boxSize, 16)
    g.lineStyle(2, 0xf59e0b, 0.65)
    g.strokeRoundedRect(cx - boxSize / 2, cy - boxSize / 2, boxSize, boxSize, 16)

    this.dynamicLayer.add(g)

    const windText = ROUND_WIND_LABELS[state.roundWind] ?? '東風圈'
    const streakLabel = state.dealerStreak > 0 ? ` · 連${state.dealerStreak}` : ''
    const title = this.add
      .text(cx, cy - 16, `${windText}${streakLabel}`, {
        fontFamily: '"Noto Sans TC", sans-serif',
        fontSize: '14px',
        fontStyle: 'bold',
        color: '#fcd34d',
      })
      .setOrigin(0.5)

    const remText = this.add
      .text(cx, cy + 8, `餘 ${state.remainingTiles} 張`, {
        fontFamily: '"Noto Sans TC", monospace',
        fontSize: '15px',
        fontStyle: 'bold',
        color: '#ecfdf5',
      })
      .setOrigin(0.5)

    this.dynamicLayer.add([title, remText])

    // 四方門風指示燈
    const offsets: Record<0 | 1 | 2 | 3, { x: number; y: number }> = {
      0: { x: 0, y: 40 },
      1: { x: 42, y: 0 },
      2: { x: 0, y: -40 },
      3: { x: -42, y: 0 },
    }

    for (const seat of [0, 1, 2, 3] as const) {
      const rel = this.relativePos(seat)
      const seatWind = ((seat + 4 - state.dealerSeat) % 4) as SeatIndex
      const isTurn = state.currentSeat === seat && state.phase !== 'ROUND_SETTLEMENT'
      const isDealer = seat === state.dealerSeat
      const pos = offsets[rel]

      const label = `${WIND_CHARS[seatWind]}${isDealer ? '莊' : ''}`
      const badge = this.add
        .text(cx + pos.x, cy + pos.y, label, {
          fontFamily: '"Noto Sans TC", sans-serif',
          fontSize: '12px',
          fontStyle: 'bold',
          color: isTurn ? '#022c22' : '#a7f3d0',
          backgroundColor: isTurn ? '#fbbf24' : '#065f46',
          padding: { x: 5, y: 2 },
        })
        .setOrigin(0.5)

      this.dynamicLayer.add(badge)
    }
  }

  private renderSeatRiver(seat: SeatIndex, cx: number, cy: number): void {
    const state = this.currentState!
    const discards = state.seats[seat].discards
    const rel = this.relativePos(seat)
    const tileW = 28
    const tileH = 38
    const cols = 6

    discards.forEach((tileId, idx) => {
      const row = Math.floor(idx / cols)
      const col = idx % cols
      const offsetCol = (col - (cols - 1) / 2) * (tileW + 2)
      const dist = 78 + row * (tileH + 3)

      let x = cx
      let y = cy
      let angle = 0

      if (rel === 0) {
        x = cx + offsetCol
        y = cy + dist
      } else if (rel === 2) {
        x = cx - offsetCol
        y = cy - dist
        angle = 180
      } else if (rel === 1) {
        x = cx + dist
        y = cy - offsetCol
        angle = -90
      } else {
        x = cx - dist
        y = cy + offsetCol
        angle = 90
      }

      const kind = kindOf(tileId)
      const sprite = this.add
        .image(x, y, `tile_${kind}`)
        .setDisplaySize(tileW, tileH)
        .setAngle(angle)
      this.dynamicLayer.add(sprite)

      // 高亮最後打出的捨牌
      const isLastDiscard =
        state.lastDiscard &&
        state.lastDiscard.seat === seat &&
        idx === discards.length - 1 &&
        !state.lastDiscard.isChankanTarget

      if (isLastDiscard) {
        const hl = this.add.graphics()
        hl.lineStyle(2.5, 0xfbbf24, 1)
        hl.strokeRoundedRect(x - tileW / 2 - 2, y - tileH / 2 - 2, tileW + 4, tileH + 4, 4)
        this.dynamicLayer.add(hl)
      }
    })
  }

  private renderSeatHandAndMelds(
    seat: SeatIndex,
    w: number,
    h: number,
    cx: number,
    cy: number,
  ): void {
    const state = this.currentState!
    const player = state.seats[seat]
    const rel = this.relativePos(seat)
    const showFaceUp = rel === 0 || state.phase === 'ROUND_SETTLEMENT'

    if (rel === 0) {
      // 本家（底部）：大尺寸可互動手牌 + 右側副露 + 左上方花牌列
      const maxHandWidth = w - 36
      const totalSlots = player.concealed.length + player.melds.length * 3.2 + 1
      const tileW = Math.max(34, Math.min(52, Math.floor(maxHandWidth / Math.max(18, totalSlots))))
      const tileH = Math.round(tileW * 1.38)
      const baseY = h - tileH / 2 - 18

      // 繪製花牌列與聽牌狀態（手牌左上方）
      this.renderFlowersAndStatus(seat, 24, baseY - tileH / 2 - 26, true)

      const hasSeparatedDraw =
        state.lastDrawnTile?.seat === seat &&
        state.phase === 'TURN_ACTION_OR_DISCARD' &&
        player.concealed.length % 3 === 2

      const handCount = player.concealed.length
      const meldBlockW = player.melds.reduce(
        (acc, m) => acc + m.tiles.length * (tileW * 0.78) + 10,
        0,
      )
      const totalHandW =
        handCount * (tileW + 2) + (hasSeparatedDraw ? 14 : 0) + (meldBlockW > 0 ? meldBlockW + 16 : 0)
      let cursorX = cx - totalHandW / 2 + tileW / 2

      const canInteract =
        state.phase === 'TURN_ACTION_OR_DISCARD' && state.currentSeat === seat && !player.isBot

      player.concealed.forEach((tileId, i) => {
        if (hasSeparatedDraw && i === handCount - 1) {
          cursorX += 14
        }
        const kind = kindOf(tileId)
        const isSelected = this.selectedTileId === tileId
        const isMigiAllowed = !this.migiSelectMode || this.migiAllowedTiles.has(tileId)
        const isMigiLocked = player.isMigi && (!hasSeparatedDraw || i < handCount - 1)

        const yOffset = isSelected ? -14 : 0
        const sprite = this.add
          .image(cursorX, baseY + yOffset, `tile_${kind}`)
          .setDisplaySize(tileW, tileH)

        if (!isMigiAllowed || isMigiLocked) {
          sprite.setTint(0x9ca3af)
        } else if (this.migiSelectMode && isMigiAllowed) {
          sprite.setTint(0xfde68a)
        }

        if (canInteract && isMigiAllowed && !isMigiLocked) {
          sprite.setInteractive({ useHandCursor: true })
          sprite.on('pointerdown', () => {
            if (this.selectedTileId === tileId) {
              this.callbacks?.onDiscardTile(tileId)
            } else {
              this.callbacks?.onSelectTile(tileId)
            }
          })
        }

        this.dynamicLayer.add(sprite)

        if (isSelected) {
          const ring = this.add.graphics()
          ring.lineStyle(2.5, 0xfbbf24, 1)
          ring.strokeRoundedRect(
            cursorX - tileW / 2 - 2,
            baseY + yOffset - tileH / 2 - 2,
            tileW + 4,
            tileH + 4,
            5,
          )
          this.dynamicLayer.add(ring)
        }

        cursorX += tileW + 2
      })

      // 本家副露區（靠右）
      cursorX += 14
      const meldW = Math.round(tileW * 0.78)
      const meldH = Math.round(tileH * 0.78)
      for (const meld of player.melds) {
        meld.tiles.forEach((tId, idx) => {
          const isFaceDownAnkan = meld.type === 'ankan' && (idx === 0 || idx === 3)
          const key = isFaceDownAnkan ? 'tile_back' : `tile_${kindOf(tId)}`
          const img = this.add
            .image(cursorX, baseY + (tileH - meldH) / 2, key)
            .setDisplaySize(meldW, meldH)
          this.dynamicLayer.add(img)
          cursorX += meldW + 1
        })
        cursorX += 8
      }
      return
    }

    // 對家 (rel=2) 與左右家 (rel=1, 3)
    const smallW = 26
    const smallH = 36
    const totalItems = player.concealed.length + player.melds.length * 3

    if (rel === 2) {
      // 對家（頂部）
      const topY = 58
      let startX = cx + (totalItems * (smallW + 1)) / 2
      player.concealed.forEach((tId) => {
        const key = showFaceUp ? `tile_${kindOf(tId)}` : 'tile_back'
        const img = this.add.image(startX, topY, key).setDisplaySize(smallW, smallH)
        this.dynamicLayer.add(img)
        startX -= smallW + 1
      })
      startX -= 8
      for (const meld of player.melds) {
        for (const tId of meld.tiles) {
          const img = this.add
            .image(startX, topY, `tile_${kindOf(tId)}`)
            .setDisplaySize(smallW, smallH)
          this.dynamicLayer.add(img)
          startX -= smallW + 1
        }
        startX -= 4
      }
      this.renderFlowersAndStatus(seat, cx - 160, topY + 26, false)
    } else {
      // 右家 (rel=1) 或 左家 (rel=3)
      const sideX = rel === 1 ? w - 42 : 42
      const stepY = 20
      let curY = cy - (totalItems * stepY) / 2
      player.concealed.forEach((tId) => {
        const key = showFaceUp ? `tile_${kindOf(tId)}` : 'tile_back'
        const img = this.add
          .image(sideX, curY, key)
          .setDisplaySize(smallW, smallH)
          .setAngle(rel === 1 ? -90 : 90)
        this.dynamicLayer.add(img)
        curY += stepY
      })
      curY += 8
      for (const meld of player.melds) {
        for (const tId of meld.tiles) {
          const img = this.add
            .image(sideX, curY, `tile_${kindOf(tId)}`)
            .setDisplaySize(smallW, smallH)
            .setAngle(rel === 1 ? -90 : 90)
          this.dynamicLayer.add(img)
          curY += stepY
        }
        curY += 6
      }
      const flowerX = rel === 1 ? w - 92 : 76
      this.renderFlowersAndStatus(seat, flowerX, cy - 110, false)
    }
  }

  private renderFlowersAndStatus(
    seat: SeatIndex,
    x: number,
    y: number,
    horizontal: boolean,
  ): void {
    const state = this.currentState!
    const player = state.seats[seat]
    const fw = 22
    const fh = 30

    player.flowers.forEach((fId, idx) => {
      const fx = horizontal ? x + idx * (fw + 2) : x
      const fy = horizontal ? y : y + idx * (fh - 6)
      const img = this.add.image(fx, fy, `tile_${kindOf(fId)}`).setDisplaySize(fw, fh)
      this.dynamicLayer.add(img)
    })

    if (player.isMigi) {
      const badgeX = horizontal ? x + player.flowers.length * (fw + 2) + 28 : x
      const badgeY = horizontal ? y : y - 22
      const migiTag = this.add
        .text(badgeX, badgeY, '聽牌', {
          fontFamily: '"Noto Sans TC", sans-serif',
          fontSize: '11px',
          fontStyle: 'bold',
          color: '#fef08a',
          backgroundColor: '#b91c1c',
          padding: { x: 5, y: 2 },
        })
        .setOrigin(0.5)
      this.dynamicLayer.add(migiTag)
    }
  }

  /** WP-4.2: 吃/碰/槓/聽/胡/自摸 書法印章動畫與鏡頭微震動特效 */
  private playCalloutVfx(seat: SeatIndex, label: string): void {
    const w = this.scale.width
    const h = this.scale.height
    const rel = this.relativePos(seat)

    const positions: Record<0 | 1 | 2 | 3, { x: number; y: number }> = {
      0: { x: w / 2, y: h - 155 },
      1: { x: w - 140, y: h / 2 },
      2: { x: w / 2, y: 120 },
      3: { x: 140, y: h / 2 },
    }
    const pos = positions[rel]

    if (label === '胡' || label === '自摸' || label === '槓') {
      this.cameras.main.shake(180, 0.004)
    }

    const container = this.add.container(pos.x, pos.y)
    const circle = this.add.graphics()
    const isWin = label === '胡' || label === '自摸'
    circle.fillStyle(isWin ? 0xb91c1c : 0x065f46, 0.92)
    circle.fillCircle(0, 0, isWin ? 44 : 34)
    circle.lineStyle(3, 0xfbbf24, 1)
    circle.strokeCircle(0, 0, isWin ? 44 : 34)

    const text = this.add
      .text(0, 0, label, {
        fontFamily: '"Noto Serif TC", "Noto Sans TC", serif',
        fontSize: isWin ? '30px' : '24px',
        fontStyle: 'bold',
        color: '#fef3c7',
      })
      .setOrigin(0.5)

    container.add([circle, text])
    container.setScale(1.8)
    container.setAlpha(0)
    this.fxLayer.add(container)

    this.tweens.add({
      targets: container,
      scale: 1,
      alpha: 1,
      duration: 180,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: container,
          alpha: 0,
          y: pos.y - 18,
          delay: 650,
          duration: 280,
          onComplete: () => container.destroy(),
        })
      },
    })
  }
}
