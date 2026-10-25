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

  /** 依據螢幕寬高計算牌桌中心點與縮放比例（同時支援手機直向雙排手牌與手機橫向緊湊版面） */
  private getLayoutMetrics() {
    const w = this.scale.width
    const h = this.scale.height
    const isPortraitMobile = w < 620 && h > w
    const isCompactLandscape = h < 500
    const boardScale = Math.max(0.55, Math.min(1, Math.min(w / 720, h / 640)))
    const cx = w / 2
    // 手機直向時將牌桌中心上移，預留底部雙排大尺寸手牌空間；手機橫向時略微上移避開底部單排手牌
    const cy = isPortraitMobile ? h * 0.37 : isCompactLandscape ? h * 0.43 : h * 0.46
    return { w, h, cx, cy, isPortraitMobile, isCompactLandscape, boardScale }
  }

  private drawStaticTable(): void {
    this.boardLayer.removeAll(true)
    const { w, h, cx, cy, boardScale } = this.getLayoutMetrics()
    const g = this.add.graphics()

    const pad = Math.max(4, Math.round(10 * boardScale))
    g.fillStyle(0x27170c, 1)
    g.fillRect(0, 0, w, h)

    g.fillStyle(0x064e3b, 1)
    g.fillRoundedRect(pad, pad, w - pad * 2, h - pad * 2, 14)

    g.lineStyle(1.5, 0xd97706, 0.35)
    g.strokeRoundedRect(pad + 4, pad + 4, w - (pad + 4) * 2, h - (pad + 4) * 2, 12)

    g.lineStyle(1, 0x10b981, 0.14)
    const rBase = Math.min(w, h) * 0.25
    g.strokeCircle(cx, cy, rBase)
    g.strokeCircle(cx, cy, rBase * 0.74)

    this.boardLayer.add(g)
  }

  private renderTableState(): void {
    if (!this.currentState) return
    this.dynamicLayer.removeAll(true)

    const { w, h, cx, cy, boardScale } = this.getLayoutMetrics()

    this.renderCenterCompass(cx, cy, boardScale)

    for (const seat of [0, 1, 2, 3] as const) {
      this.renderSeatRiver(seat, cx, cy, boardScale)
      this.renderSeatHandAndMelds(seat, w, h, cx, cy, boardScale)
    }
  }

  private renderCenterCompass(cx: number, cy: number, boardScale: number): void {
    const state = this.currentState!
    const boxSize = Math.max(74, Math.round(112 * boardScale))
    const g = this.add.graphics()

    g.fillStyle(0x022c22, 0.94)
    g.fillRoundedRect(cx - boxSize / 2, cy - boxSize / 2, boxSize, boxSize, 12)
    g.lineStyle(2, 0xf59e0b, 0.65)
    g.strokeRoundedRect(cx - boxSize / 2, cy - boxSize / 2, boxSize, boxSize, 12)

    this.dynamicLayer.add(g)

    const windText = ROUND_WIND_LABELS[state.roundWind] ?? '東風圈'
    const streakLabel = state.dealerStreak > 0 ? `·連${state.dealerStreak}` : ''
    const titleFontPx = Math.max(10, Math.round(13 * boardScale))
    const remFontPx = Math.max(11, Math.round(14 * boardScale))

    const title = this.add
      .text(cx, cy - boxSize * 0.14, `${windText}${streakLabel}`, {
        fontFamily: '"Noto Sans TC", sans-serif',
        fontSize: `${titleFontPx}px`,
        fontStyle: 'bold',
        color: '#fcd34d',
      })
      .setOrigin(0.5)

    const remText = this.add
      .text(cx, cy + boxSize * 0.08, `餘 ${state.remainingTiles} 張`, {
        fontFamily: '"Noto Sans TC", monospace',
        fontSize: `${remFontPx}px`,
        fontStyle: 'bold',
        color: '#ecfdf5',
      })
      .setOrigin(0.5)

    this.dynamicLayer.add([title, remText])

    const offsetDist = boxSize * 0.35
    const offsets: Record<0 | 1 | 2 | 3, { x: number; y: number }> = {
      0: { x: 0, y: offsetDist },
      1: { x: offsetDist, y: 0 },
      2: { x: 0, y: -offsetDist },
      3: { x: -offsetDist, y: 0 },
    }

    const badgeFontPx = Math.max(9, Math.round(11 * boardScale))
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
          fontSize: `${badgeFontPx}px`,
          fontStyle: 'bold',
          color: isTurn ? '#022c22' : '#a7f3d0',
          backgroundColor: isTurn ? '#fbbf24' : '#065f46',
          padding: { x: 4, y: 1 },
        })
        .setOrigin(0.5)

      this.dynamicLayer.add(badge)
    }
  }

  private renderSeatRiver(
    seat: SeatIndex,
    cx: number,
    cy: number,
    boardScale: number,
  ): void {
    const state = this.currentState!
    const discards = state.seats[seat].discards
    const rel = this.relativePos(seat)
    const tileW = Math.max(17, Math.round(27 * boardScale))
    const tileH = Math.round(tileW * 1.36)
    const cols = 6
    const startDist = Math.max(48, Math.round(74 * boardScale))

    discards.forEach((tileId, idx) => {
      const row = Math.floor(idx / cols)
      const col = idx % cols
      const offsetCol = (col - (cols - 1) / 2) * (tileW + 1.5)
      const dist = startDist + row * (tileH + 2)

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

      const isLastDiscard =
        state.lastDiscard &&
        state.lastDiscard.seat === seat &&
        idx === discards.length - 1 &&
        !state.lastDiscard.isChankanTarget

      if (isLastDiscard) {
        const hl = this.add.graphics()
        hl.lineStyle(2, 0xfbbf24, 1)
        hl.strokeRoundedRect(x - tileW / 2 - 2, y - tileH / 2 - 2, tileW + 4, tileH + 4, 3)
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
    boardScale: number,
  ): void {
    const state = this.currentState!
    const player = state.seats[seat]
    const rel = this.relativePos(seat)
    const showFaceUp = rel === 0 || state.phase === 'ROUND_SETTLEMENT'
    const { isPortraitMobile, isCompactLandscape } = this.getLayoutMetrics()

    if (rel === 0) {
      const hasSeparatedDraw =
        state.lastDrawnTile?.seat === seat &&
        state.phase === 'TURN_ACTION_OR_DISCARD' &&
        player.concealed.length % 3 === 2

      const canInteract =
        state.phase === 'TURN_ACTION_OR_DISCARD' && state.currentSeat === seat && !player.isBot

      // 手機直向 (w < 620) 且暗牌超過 10 張時：自動採用「雙排大尺寸手牌 + 上方副露列」，徹底解決 17 張麻將在手機直向擠爆螢幕的問題
      const useTwoRowHand = isPortraitMobile && player.concealed.length > 9

      if (useTwoRowHand) {
        const maxCols = 9
        const tileW = Math.max(32, Math.min(44, Math.floor((w - 28) / (maxCols + 0.6))))
        const tileH = Math.round(tileW * 1.36)
        const bottomRowY = h - tileH / 2 - 28
        const topRowY = bottomRowY - tileH - 6

        const handCount = player.concealed.length
        const splitIdx = Math.max(0, handCount - maxCols)
        const topRowTiles = player.concealed.slice(0, splitIdx)
        const bottomRowTiles = player.concealed.slice(splitIdx)

        const renderInteractiveTile = (
          tileId: TileId,
          globalIdx: number,
          tx: number,
          ty: number,
        ) => {
          const kind = kindOf(tileId)
          const isSelected = this.selectedTileId === tileId
          const isMigiAllowed = !this.migiSelectMode || this.migiAllowedTiles.has(tileId)
          const isMigiLocked = player.isMigi && (!hasSeparatedDraw || globalIdx < handCount - 1)
          const yOffset = isSelected ? -8 : 0

          const sprite = this.add
            .image(tx, ty + yOffset, `tile_${kind}`)
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
              tx - tileW / 2 - 2,
              ty + yOffset - tileH / 2 - 2,
              tileW + 4,
              tileH + 4,
              4,
            )
            this.dynamicLayer.add(ring)
          }
        }

        // 上排手牌
        const topTotalW = topRowTiles.length * (tileW + 2)
        let topX = cx - topTotalW / 2 + tileW / 2
        topRowTiles.forEach((tId, idx) => {
          renderInteractiveTile(tId, idx, topX, topRowY)
          topX += tileW + 2
        })

        // 下排手牌（含最新摸牌間距）
        const bottomTotalW =
          bottomRowTiles.length * (tileW + 2) + (hasSeparatedDraw ? 10 : 0)
        let botX = cx - bottomTotalW / 2 + tileW / 2
        bottomRowTiles.forEach((tId, idx) => {
          const globalIdx = splitIdx + idx
          if (hasSeparatedDraw && globalIdx === handCount - 1) {
            botX += 10
          }
          renderInteractiveTile(tId, globalIdx, botX, bottomRowY)
          botX += tileW + 2
        })

        // 副露與花牌列（顯示於雙排手牌上方兩側）
        const infoY = topRowY - tileH / 2 - 18
        this.renderFlowersAndStatus(seat, 16, infoY, true, boardScale)

        if (player.melds.length > 0) {
          const meldW = Math.round(tileW * 0.62)
          const meldH = Math.round(tileH * 0.62)
          let mx = w - 16 - meldW / 2
          for (let m = player.melds.length - 1; m >= 0; m--) {
            const meld = player.melds[m]
            for (let t = meld.tiles.length - 1; t >= 0; t--) {
              const tId = meld.tiles[t]
              const isFaceDownAnkan = meld.type === 'ankan' && (t === 0 || t === 3)
              const key = isFaceDownAnkan ? 'tile_back' : `tile_${kindOf(tId)}`
              const img = this.add.image(mx, infoY, key).setDisplaySize(meldW, meldH)
              this.dynamicLayer.add(img)
              mx -= meldW + 1
            }
            mx -= 5
          }
        }
        return
      }

      // 桌面與手機橫向：單排自适应寬度（動態計算 tileW 確保 17 張 + 副露永不超出螢幕）
      const maxHandWidth = w - 24
      const totalSlots = player.concealed.length + player.melds.length * 3.1 + 1.2
      const tileW = Math.max(
        22,
        Math.min(52, Math.floor(maxHandWidth / Math.max(17.5, totalSlots))),
      )
      const tileH = Math.round(tileW * 1.38)
      const bottomMargin = isCompactLandscape ? 8 : 22
      const baseY = h - tileH / 2 - bottomMargin

      this.renderFlowersAndStatus(
        seat,
        18,
        baseY - tileH / 2 - Math.max(14, Math.round(22 * boardScale)),
        true,
        boardScale,
      )

      const handCount = player.concealed.length
      const meldW = Math.round(tileW * 0.76)
      const meldH = Math.round(tileH * 0.76)
      const meldBlockW = player.melds.reduce(
        (acc, m) => acc + m.tiles.length * (meldW + 1) + 6,
        0,
      )
      const sepGap = hasSeparatedDraw ? Math.max(8, Math.round(tileW * 0.28)) : 0
      const totalHandW =
        handCount * (tileW + 1.5) + sepGap + (meldBlockW > 0 ? meldBlockW + 10 : 0)
      let cursorX = cx - totalHandW / 2 + tileW / 2

      player.concealed.forEach((tileId, i) => {
        if (hasSeparatedDraw && i === handCount - 1) {
          cursorX += sepGap
        }
        const kind = kindOf(tileId)
        const isSelected = this.selectedTileId === tileId
        const isMigiAllowed = !this.migiSelectMode || this.migiAllowedTiles.has(tileId)
        const isMigiLocked = player.isMigi && (!hasSeparatedDraw || i < handCount - 1)

        const yOffset = isSelected ? -Math.max(8, Math.round(tileH * 0.2)) : 0
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
          ring.lineStyle(2, 0xfbbf24, 1)
          ring.strokeRoundedRect(
            cursorX - tileW / 2 - 2,
            baseY + yOffset - tileH / 2 - 2,
            tileW + 4,
            tileH + 4,
            4,
          )
          this.dynamicLayer.add(ring)
        }

        cursorX += tileW + 1.5
      })

      cursorX += 10
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
        cursorX += 6
      }
      return
    }

    // 對家 (rel=2) 與左右家 (rel=1, 3) 依 boardScale 動態縮放
    const smallW = Math.max(15, Math.round(25 * boardScale))
    const smallH = Math.round(smallW * 1.38)
    const totalItems = player.concealed.length + player.melds.length * 3

    if (rel === 2) {
      const topY = Math.max(36, Math.round(52 * boardScale))
      let startX = cx + (totalItems * (smallW + 1)) / 2
      player.concealed.forEach((tId) => {
        const key = showFaceUp ? `tile_${kindOf(tId)}` : 'tile_back'
        const img = this.add.image(startX, topY, key).setDisplaySize(smallW, smallH)
        this.dynamicLayer.add(img)
        startX -= smallW + 1
      })
      startX -= 6
      for (const meld of player.melds) {
        for (const tId of meld.tiles) {
          const img = this.add
            .image(startX, topY, `tile_${kindOf(tId)}`)
            .setDisplaySize(smallW, smallH)
          this.dynamicLayer.add(img)
          startX -= smallW + 1
        }
        startX -= 3
      }
      this.renderFlowersAndStatus(
        seat,
        cx - Math.min(w * 0.3, 140),
        topY + smallH * 0.75,
        true,
        boardScale,
      )
    } else {
      const sideMargin = Math.max(18, Math.round(38 * boardScale))
      const sideX = rel === 1 ? w - sideMargin : sideMargin
      const stepY = Math.max(11, Math.round(19 * boardScale))
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
      curY += 6
      for (const meld of player.melds) {
        for (const tId of meld.tiles) {
          const img = this.add
            .image(sideX, curY, `tile_${kindOf(tId)}`)
            .setDisplaySize(smallW, smallH)
            .setAngle(rel === 1 ? -90 : 90)
          this.dynamicLayer.add(img)
          curY += stepY
        }
        curY += 4
      }
      const flowerX = rel === 1 ? sideX - smallH : sideX + smallH
      this.renderFlowersAndStatus(seat, flowerX, cy - 70 * boardScale, false, boardScale)
    }
  }

  private renderFlowersAndStatus(
    seat: SeatIndex,
    x: number,
    y: number,
    horizontal: boolean,
    boardScale: number,
  ): void {
    const state = this.currentState!
    const player = state.seats[seat]
    const fw = Math.max(15, Math.round(22 * boardScale))
    const fh = Math.round(fw * 1.36)

    player.flowers.forEach((fId, idx) => {
      const fx = horizontal ? x + idx * (fw + 2) : x
      const fy = horizontal ? y : y + idx * (fh - 4)
      const img = this.add.image(fx, fy, `tile_${kindOf(fId)}`).setDisplaySize(fw, fh)
      this.dynamicLayer.add(img)
    })

    if (player.isMigi) {
      const badgeX = horizontal ? x + player.flowers.length * (fw + 2) + 22 : x
      const badgeY = horizontal ? y : y - 16
      const migiTag = this.add
        .text(badgeX, badgeY, '聽牌', {
          fontFamily: '"Noto Sans TC", sans-serif',
          fontSize: `${Math.max(9, Math.round(11 * boardScale))}px`,
          fontStyle: 'bold',
          color: '#fef08a',
          backgroundColor: '#b91c1c',
          padding: { x: 4, y: 1 },
        })
        .setOrigin(0.5)
      this.dynamicLayer.add(migiTag)
    }
  }

  /** WP-4.2: 吃/碰/槓/聽/胡/自摸 書法印章動畫與鏡頭微震動特效 */
  private playCalloutVfx(seat: SeatIndex, label: string): void {
    const { w, h, cy, boardScale } = this.getLayoutMetrics()
    const rel = this.relativePos(seat)

    const positions: Record<0 | 1 | 2 | 3, { x: number; y: number }> = {
      0: { x: w / 2, y: h - Math.max(110, Math.round(150 * boardScale)) },
      1: { x: w - Math.max(80, Math.round(135 * boardScale)), y: cy },
      2: { x: w / 2, y: Math.max(70, Math.round(110 * boardScale)) },
      3: { x: Math.max(80, Math.round(135 * boardScale)), y: cy },
    }
    const pos = positions[rel]

    if (label === '胡' || label === '自摸' || label === '槓') {
      this.cameras.main.shake(180, 0.004)
    }

    const container = this.add.container(pos.x, pos.y)
    const circle = this.add.graphics()
    const isWin = label === '胡' || label === '自摸'
    const radius = Math.round((isWin ? 42 : 32) * Math.max(0.75, boardScale))
    circle.fillStyle(isWin ? 0xb91c1c : 0x065f46, 0.92)
    circle.fillCircle(0, 0, radius)
    circle.lineStyle(3, 0xfbbf24, 1)
    circle.strokeCircle(0, 0, radius)

    const text = this.add
      .text(0, 0, label, {
        fontFamily: '"Noto Serif TC", "Noto Sans TC", serif',
        fontSize: `${Math.round((isWin ? 28 : 22) * Math.max(0.75, boardScale))}px`,
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
