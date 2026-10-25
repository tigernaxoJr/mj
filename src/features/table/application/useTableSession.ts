import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import type {
  PlayerActionCommand,
  ProtocolMessage,
  RoomSeatSlot,
  RuleConfig,
  SeatIndex,
  TileId,
  TileKind,
} from '@/shared/kernel/types'
import { DEFAULT_RULE_CONFIG } from '@/shared/kernel/types'
import {
  createCommittedWall,
  getWaitingKinds,
  initMahjongWasm,
  sha256Hex,
  verifyTileLeaf,
} from '@/shared/wasm'
import { playSfx } from '@/features/audio'
import type { PeerTransportPort } from '@/features/lobby/infra/peerAdapter'
import {
  applyPlayerAction,
  createInitialTableState,
  decideBotActionForSeat,
  getSelfTurnOptions,
  prepareNextRound,
  startRound,
  type SeatClaimOption,
  type SelfTurnOptions,
  type TableState,
} from '../domain/tableState'

export interface TableSessionOptions {
  localSeat?: SeatIndex
  isHost?: boolean
  rules?: RuleConfig
  roomSeats?: readonly RoomSeatSlot[]
  transport?: PeerTransportPort | null
}

export function useTableSession(options: TableSessionOptions = {}) {
  const localSeat = ref<SeatIndex>(options.localSeat ?? 0)
  const isHost = ref<boolean>(options.isHost ?? true)
  const transport = options.transport ?? null

  const state = reactive<TableState>(
    createInitialTableState(options.rules ?? DEFAULT_RULE_CONFIG, options.roomSeats),
  )

  const migiSelectMode = ref(false)
  const selectedTileId = ref<TileId | null>(null)
  let botTimer: ReturnType<typeof setTimeout> | null = null

  // Co-Seeded Commit-Reveal 狀態
  const peerCommits = new Map<SeatIndex, string>()
  const peerSeeds = new Map<SeatIndex, string>()

  const localPlayer = computed(() => state.seats[localSeat.value])

  const selfTurnOptions = computed<SelfTurnOptions>(() =>
    getSelfTurnOptions(state, localSeat.value),
  )

  const localClaimEntry = computed<SeatClaimOption | null>(() => {
    if (state.phase !== 'CLAIM_WINDOW') return null
    const entry = state.claimWindow.find((c) => c.seat === localSeat.value && !c.responded)
    return entry ?? null
  })

  /** 本家當前聽牌提示（當手牌為 $3n+1$ 待摸狀態時直接計算，若為 $3n+2$ 待打狀態則取選中牌打出後的聽牌） */
  const waitingKinds = computed<TileKind[]>(() => {
    const p = localPlayer.value
    const expectedWaitLen = (5 - p.melds.length) * 3 + 1
    if (p.concealed.length === expectedWaitLen) {
      return getWaitingKinds(p.concealed, p.melds.length)
    }
    if (p.concealed.length === expectedWaitLen + 1) {
      const target = selectedTileId.value ?? p.concealed[p.concealed.length - 1]
      const idx = p.concealed.indexOf(target)
      if (idx >= 0) {
        const rem = [...p.concealed.slice(0, idx), ...p.concealed.slice(idx + 1)]
        return getWaitingKinds(rem, p.melds.length)
      }
    }
    return []
  })

  function clearBotTimer(): void {
    if (botTimer !== null) {
      clearTimeout(botTimer)
      botTimer = null
    }
  }

  function playCalloutSfx(label: string | undefined): void {
    switch (label) {
      case '吃':
        playSfx('chii')
        break
      case '碰':
        playSfx('pon')
        break
      case '槓':
        playSfx('kan')
        break
      case '聽':
        playSfx('migi')
        break
      case '胡':
        playSfx('ron')
        break
      case '自摸':
        playSfx('tsumo')
        break
      case '補花':
        playSfx('flower')
        break
    }
  }

  watch(
    () => state.calloutSeq,
    () => {
      if (state.lastCallout) {
        playCalloutSfx(state.lastCallout.label)
      }
    },
  )

  function scheduleBotStepIfNeeded(): void {
    clearBotTimer()
    if (!isHost.value) return
    if (state.phase !== 'TURN_ACTION_OR_DISCARD' && state.phase !== 'CLAIM_WINDOW') return

    // 1. 若處於 CLAIM_WINDOW，先讓所有未回應的 Bot 自動送出回應
    if (state.phase === 'CLAIM_WINDOW') {
      const pendingBot = state.claimWindow.find(
        (c) => !c.responded && state.seats[c.seat].isBot,
      )
      if (pendingBot) {
        botTimer = setTimeout(() => {
          const cmd = decideBotActionForSeat(state, pendingBot.seat)
          if (cmd) {
            dispatchAction(pendingBot.seat, cmd)
          }
        }, 320)
      }
      return
    }

    // 2. 若處於 TURN_ACTION_OR_DISCARD，且當前行動者是 Bot（或已宣告 MIGI 聽牌且無自摸之真人自動摸切）
    const activeSeat = state.currentSeat
    const activePlayer = state.seats[activeSeat]
    if (activePlayer.isBot) {
      botTimer = setTimeout(() => {
        const cmd = decideBotActionForSeat(state, activeSeat)
        if (cmd) {
          dispatchAction(activeSeat, cmd)
        }
      }, 420)
      return
    }

    // 真人已宣告 MIGI 聽牌：若不能自摸，自動在短暫延遲後摸切最後一張牌
    if (activePlayer.isMigi && activeSeat === localSeat.value) {
      const opts = getSelfTurnOptions(state, activeSeat)
      if (!opts.canTsumo && activePlayer.concealed.length > 0) {
        const drawnTile =
          state.lastDrawnTile?.tileId ??
          activePlayer.concealed[activePlayer.concealed.length - 1]
        botTimer = setTimeout(() => {
          if (state.phase === 'TURN_ACTION_OR_DISCARD' && state.currentSeat === activeSeat) {
            dispatchAction(activeSeat, { type: 'DISCARD', tileId: drawnTile })
          }
        }, 550)
      }
    }
  }

  function dispatchAction(seat: SeatIndex, action: PlayerActionCommand): boolean {
    if (!isHost.value && transport) {
      transport.sendToHost({ type: 'PLAYER_ACTION', seat, action })
    }

    const prevHead = state.headCursor
    const ok = applyPlayerAction(state, seat, action)
    if (!ok) return false

    if (action.type === 'DISCARD' || action.type === 'DECLARE_MIGI') {
      playSfx('discard')
      migiSelectMode.value = false
      selectedTileId.value = null
    } else if (state.headCursor !== prevHead) {
      playSfx('draw')
    }

    if (isHost.value && transport) {
      transport.broadcast({ type: 'PLAYER_ACTION', seat, action })
      if (state.phase === 'ROUND_SETTLEMENT') {
        transport.broadcast({
          type: 'ROUND_AUDIT',
          hostSecret: state.hostSecret,
          fullWall: state.wallTiles,
          salts: state.wallSalts,
        })
      }
    }

    scheduleBotStepIfNeeded()
    return true
  }

  /** P2P 訊息接收與 Commit-Reveal 驗證 */
  function handleProtocolMessage(msg: ProtocolMessage): void {
    switch (msg.type) {
      case 'SEED_COMMIT':
        peerCommits.set(msg.seat, msg.commitHash)
        break
      case 'SEED_REVEAL':
        if (peerCommits.get(msg.seat) === sha256Hex(msg.seedHex)) {
          peerSeeds.set(msg.seat, msg.seedHex)
        }
        break
      case 'WALL_LOCKED':
        state.roundSeed = msg.roundSeed
        state.wallLeafHashes = msg.leafHashes
        break
      case 'TILE_DRAWN_PRIVATE': {
        const expected = state.wallLeafHashes[msg.wallIndex]
        if (expected && !verifyTileLeaf(msg.wallIndex, msg.tileId, msg.salt, expected)) {
          state.auditVerified = false
        }
        break
      }
      case 'PLAYER_ACTION':
        applyPlayerAction(state, msg.seat, msg.action)
        scheduleBotStepIfNeeded()
        break
      case 'ROUND_AUDIT': {
        const recomputed = createCommittedWall(state.roundSeed, msg.hostSecret)
        const matches =
          recomputed.tiles.length === msg.fullWall.length &&
          recomputed.tiles.every((t, i) => t === msg.fullWall[i]) &&
          recomputed.leafHashes.every((h, i) => h === state.wallLeafHashes[i])
        state.auditVerified = matches
        break
      }
    }
  }

  async function initAndStartRound(customSeed?: string): Promise<void> {
    await initMahjongWasm()
    const seed = customSeed ?? `twmj-seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const secret = `host-secret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    playSfx('shuffle')
    startRound(state, seed, secret)
    if (isHost.value && transport) {
      transport.broadcast({
        type: 'WALL_LOCKED',
        roundSeed: state.roundSeed,
        leafHashes: state.wallLeafHashes,
      })
    }
    scheduleBotStepIfNeeded()
  }

  function startNextRound(): void {
    const seed = `twmj-seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const secret = `host-secret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    playSfx('shuffle')
    prepareNextRound(state, seed, secret)
    if (isHost.value && transport) {
      transport.broadcast({
        type: 'WALL_LOCKED',
        roundSeed: state.roundSeed,
        leafHashes: state.wallLeafHashes,
      })
    }
    scheduleBotStepIfNeeded()
  }

  /** 將斷線玩家座位轉為電腦玩家立即接手 */
  function convertSeatToBot(seat: SeatIndex): void {
    state.seats[seat].isBot = true
    state.seats[seat].name = `${state.seats[seat].name} (電腦代打)`
    scheduleBotStepIfNeeded()
  }

  onUnmounted(() => {
    clearBotTimer()
  })

  return {
    state,
    localSeat,
    localPlayer,
    selfTurnOptions,
    localClaimEntry,
    waitingKinds,
    migiSelectMode,
    selectedTileId,
    initAndStartRound,
    startNextRound,
    dispatchAction,
    handleProtocolMessage,
    convertSeatToBot,
  }
}
