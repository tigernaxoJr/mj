import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import type {
  PlayerActionCommand,
  PlayerId,
  ProtocolMessage,
  RoomSeatSlot,
  RuleConfig,
  SeatIndex,
  TileId,
  TileKind,
} from '@/shared/kernel/types'
import { DEFAULT_RULE_CONFIG, kindOf } from '@/shared/kernel/types'
import { createCommittedWall, getWaitingKinds, initMahjongWasm, sha256Hex } from '@/shared/wasm'
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
import { canonicalJson, maskStateFor } from '../domain/stateView'
import type { DeckFault } from './deckProtocol'
import { SecureTable, type SecureTableSecurity } from './secureTable'

export interface TableSessionOptions {
  localSeat?: SeatIndex
  isHost?: boolean
  rules?: RuleConfig
  roomSeats?: readonly RoomSeatSlot[]
  transport?: PeerTransportPort | null
  /** 客機：大廳收到、牌桌掛載前已被消耗的首則訊息（房主的開局承諾） */
  initialMessage?: ProtocolMessage
  /** 兩位以上真人且已完成身分握手：改用 Mental Poker 防作弊牌局 */
  security?: SecureTableSecurity
}

export type AuditStatus = 'pending' | 'ok' | 'fail'

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

  /** 客機每套用一次房主視角就加一，供畫面重繪 */
  const viewSeq = ref(0)

  const localPlayer = computed(() => state.seats[localSeat.value])

  const selfTurnOptions = computed<SelfTurnOptions>(() =>
    getSelfTurnOptions(state, localSeat.value),
  )

  const localClaimEntry = computed<SeatClaimOption | null>(() => {
    if (state.phase !== 'CLAIM_WINDOW') return null
    const entry = state.claimWindow.find((c) => c.seat === localSeat.value && !c.responded)
    // 防作弊牌局每次都會進回應窗；沒得吃碰胡時自動「過」，不顯示操作鈕
    return entry && hasClaimOption(entry) ? entry : null
  })

  // ---- 防作弊牌局（兩位以上真人）----
  const securityFault = ref<DeckFault | null>(null)
  const secureAudited = ref(false)
  let secure: SecureTable | null = null

  const auditStatus = computed<AuditStatus>(() => {
    if (securityFault.value || !state.auditVerified) return 'fail'
    if (secure && !secureAudited.value) return 'pending'
    return 'ok'
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

  /** 輪到本家出牌時：打出後仍可聽牌的手牌集合（UI 於牌上標示提示點） */
  const tenpaiDiscards = computed<Set<TileId>>(() => {
    const p = localPlayer.value
    const out = new Set<TileId>()
    if (state.phase !== 'TURN_ACTION_OR_DISCARD' || state.currentSeat !== localSeat.value) return out
    if (p.concealed.length !== (5 - p.melds.length) * 3 + 2) return out
    const triedKinds = new Map<TileKind, boolean>()
    p.concealed.forEach((t, i) => {
      const k = kindOf(t)
      if (!triedKinds.has(k)) {
        const rem = [...p.concealed.slice(0, i), ...p.concealed.slice(i + 1)]
        triedKinds.set(k, getWaitingKinds(rem, p.melds.length).length > 0)
      }
      if (triedKinds.get(k)) out.add(t)
    })
    return out
  })

  /** 本家視角已現身的某種牌張數（自己手牌 + 全體捨牌/副露/花），用於計算聽牌剩餘張數 */
  function visibleCount(kind: TileKind): number {
    let n = localPlayer.value.concealed.filter((t) => kindOf(t) === kind).length
    for (const s of state.seats) {
      n += s.discards.filter((t) => kindOf(t) === kind).length
      for (const m of s.melds) n += m.tiles.filter((t) => kindOf(t) === kind).length
    }
    return n
  }

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

  function hasClaimOption(c: SeatClaimOption): boolean {
    return c.canRon || c.ponTiles !== null || c.minkanTiles !== null || c.chiiOptions.length > 0
  }

  /** 防作弊牌局：本機替自己的座位自動「過」與聽牌後摸切；房主另外代電腦座位出牌 */
  function scheduleSecureAuto(): void {
    if (!secure || secure.fault) return
    const mine = (seat: SeatIndex) =>
      seat === localSeat.value || (isHost.value && secure!.isBotSeat(seat))
    if (state.phase === 'CLAIM_WINDOW') {
      const entry = state.claimWindow.find(
        (c) => !c.responded && mine(c.seat) && (state.seats[c.seat].isBot || !hasClaimOption(c)),
      )
      if (!entry) return
      botTimer = setTimeout(() => {
        const cmd = state.seats[entry.seat].isBot
          ? decideBotActionForSeat(state, entry.seat)
          : ({ type: 'CLAIM_PASS' } as const)
        if (cmd) dispatchAction(entry.seat, cmd)
      }, state.seats[entry.seat].isBot ? 320 : 0)
      return
    }
    if (state.phase !== 'TURN_ACTION_OR_DISCARD' || !mine(state.currentSeat)) return
    const seat = state.currentSeat
    const player = state.seats[seat]
    if (player.isBot) {
      botTimer = setTimeout(() => {
        const cmd = decideBotActionForSeat(state, seat)
        if (cmd) dispatchAction(seat, cmd)
      }, 420)
    } else if (player.isMigi && !getSelfTurnOptions(state, seat).canTsumo) {
      const drawn = state.lastDrawnTile?.seat === seat ? state.lastDrawnTile.tileId : null
      if (drawn !== null) botTimer = setTimeout(() => dispatchAction(seat, { type: 'DISCARD', tileId: drawn }), 550)
    }
  }

  function scheduleBotStepIfNeeded(): void {
    clearBotTimer()
    if (secure) return scheduleSecureAuto()
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

    // 真人（含遠端客機）已宣告 MIGI 聽牌：由房主代為在短暫延遲後摸切，客機不會自己送出
    if (activePlayer.isMigi) {
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

  function playActionSfx(action: PlayerActionCommand | null, prevHead: number): void {
    if (action && (action.type === 'DISCARD' || action.type === 'DECLARE_MIGI')) {
      playSfx('discard')
    } else if (state.headCursor !== prevHead) {
      playSfx('draw')
    }
  }

  // ---- 房主：每個動作之後，把各客機視角的牌桌送出 ----
  let syncSeq = 0

  function guestSlots(): RoomSeatSlot[] {
    return (options.roomSeats ?? []).filter(
      (s) => s.occupant === 'human' && s.playerId !== null && s.seat !== localSeat.value,
    )
  }

  function afterStateChange(actor: SeatIndex | null, action: PlayerActionCommand | null): void {
    if (!isHost.value || !transport) return
    for (const slot of guestSlots()) {
      transport.sendToPeer(slot.playerId!, {
        type: 'STATE_SYNC',
        seq: syncSeq,
        actor,
        action,
        view: maskStateFor(state, slot.seat),
      })
    }
    syncSeq++
    if (state.phase === 'ROUND_SETTLEMENT') {
      transport.broadcast({
        type: 'ROUND_AUDIT',
        hostSecret: state.hostSecret,
        fullWall: state.wallTiles,
        salts: state.wallSalts,
      })
    }
  }

  function dispatchAction(seat: SeatIndex, action: PlayerActionCommand): boolean {
    // 防作弊牌局：簽章廣播，等房主排序回送後各家同時套用
    if (secure) {
      const ok = secure.submit(seat, action)
      if (ok && (action.type === 'DISCARD' || action.type === 'DECLARE_MIGI')) {
        migiSelectMode.value = false
        selectedTileId.value = null
      }
      return ok
    }
    // 客機只送出意圖，由房主驗證後套用；結果以 STATE_SYNC 回傳
    if (!isHost.value && transport) {
      transport.sendToHost({ type: 'PLAYER_ACTION', seat, action })
      if (action.type === 'DISCARD' || action.type === 'DECLARE_MIGI') {
        migiSelectMode.value = false
        selectedTileId.value = null
      }
      return true
    }

    const prevHead = state.headCursor
    const ok = applyPlayerAction(state, seat, action)
    if (!ok) return false

    playActionSfx(action, prevHead)
    if (action.type === 'DISCARD' || action.type === 'DECLARE_MIGI') {
      migiSelectMode.value = false
      selectedTileId.value = null
    }

    afterStateChange(seat, action)
    scheduleBotStepIfNeeded()
    return true
  }

  // ---- 客機：接收視角、記錄、局末稽核 ----
  interface LoggedStep {
    actor: SeatIndex | null
    action: PlayerActionCommand | null
    canon: string
  }
  let myRoundSeed = ''
  let hostCommit = ''
  let wallLock: { roundSeed: string; hostCommit: string; leafHashes: string[] } | null = null
  let stepLog: LoggedStep[] = []
  let roundOk = true
  /** 已通過稽核、推進到上一局結算的完整狀態，供下一局重播的起點 */
  let shadow: TableState = createInitialTableState(
    options.rules ?? DEFAULT_RULE_CONFIG,
    options.roomSeats,
  )

  function randomHex(bytes = 16): string {
    const buf = new Uint8Array(bytes)
    crypto.getRandomValues(buf)
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
  }

  function onHostCommit(commit: string): void {
    hostCommit = commit
    myRoundSeed = randomHex()
    wallLock = null
    stepLog = []
    roundOk = true
    transport?.sendToHost({ type: 'SEED_REVEAL', seat: localSeat.value, seedHex: myRoundSeed })
  }

  function onWallLocked(msg: Extract<ProtocolMessage, { type: 'WALL_LOCKED' }>): void {
    wallLock = { roundSeed: msg.roundSeed, hostCommit: msg.hostCommit, leafHashes: msg.leafHashes }
    // 房主承諾必須是開局前公布的那個，且我的種子確實被納入牌山
    if (
      msg.hostCommit !== hostCommit ||
      !msg.roundSeed.split('|').includes(`${localSeat.value}:${myRoundSeed}`)
    ) {
      roundOk = false
    }
  }

  function onStateSync(msg: Extract<ProtocolMessage, { type: 'STATE_SYNC' }>): void {
    if (msg.seq === 0) stepLog = []
    if (msg.seq !== stepLog.length) {
      roundOk = false
      return
    }
    const prevHead = state.headCursor
    const view = msg.view as TableState
    stepLog.push({ actor: msg.actor, action: msg.action, canon: canonicalJson(view) })
    Object.assign(state, view)
    state.auditVerified = roundOk
    playActionSfx(msg.action, prevHead)
    viewSeq.value++
  }

  /** 用房主揭露的密鑰還原牌山，逐步重播並與收到的每個視角比對 */
  function auditRound(msg: Extract<ProtocolMessage, { type: 'ROUND_AUDIT' }>): void {
    let ok = roundOk && wallLock !== null && stepLog.length > 0
    if (ok && wallLock) {
      ok = sha256Hex(msg.hostSecret) === wallLock.hostCommit
      const wall = createCommittedWall(wallLock.roundSeed, msg.hostSecret)
      ok =
        ok &&
        wall.leafHashes.length === wallLock.leafHashes.length &&
        wall.leafHashes.every((h, i) => h === wallLock!.leafHashes[i])
      if (ok) {
        const replay = JSON.parse(JSON.stringify(shadow)) as TableState
        if (replay.phase === 'IDLE') startRound(replay, wallLock.roundSeed, msg.hostSecret)
        else prepareNextRound(replay, wallLock.roundSeed, msg.hostSecret)
        const mine = localSeat.value
        ok = canonicalJson(maskStateFor(replay, mine)) === stepLog[0].canon
        for (let i = 1; ok && i < stepLog.length; i++) {
          const step = stepLog[i]
          ok =
            step.actor !== null &&
            step.action !== null &&
            applyPlayerAction(replay, step.actor, step.action) &&
            canonicalJson(maskStateFor(replay, mine)) === step.canon
        }
        if (ok) shadow = replay
      }
    }
    roundOk = ok
    state.auditVerified = ok
  }

  /** P2P 訊息接收 */
  function handleProtocolMessage(msg: ProtocolMessage, fromPeer?: PlayerId): void {
    if (secure) {
      secure.receive(msg, fromPeer)
      return
    }
    switch (msg.type) {
      // 房主：收集各客機的種子
      case 'SEED_REVEAL': {
        if (!isHost.value || !pendingSeeds) break
        const slot = options.roomSeats?.find((s) => s.seat === msg.seat)
        if (fromPeer && slot?.playerId === fromPeer && typeof msg.seedHex === 'string') {
          pendingSeeds.set(msg.seat, msg.seedHex.slice(0, 64))
          if (guestSlots().every((g) => pendingSeeds!.has(g.seat))) seedsReady?.()
        }
        break
      }
      case 'SEED_COMMIT':
        if (!isHost.value) onHostCommit(msg.commitHash)
        break
      case 'WALL_LOCKED':
        if (!isHost.value) onWallLocked(msg)
        break
      case 'STATE_SYNC':
        if (!isHost.value) onStateSync(msg)
        break
      case 'ROUND_AUDIT':
        if (!isHost.value) auditRound(msg)
        break
      case 'PLAYER_ACTION': {
        // 房主：只接受該客機自己座位的意圖，驗證後經 dispatchAction 套用並同步
        if (!isHost.value) break
        const slot = options.roomSeats?.find((s) => s.seat === msg.seat)
        if (fromPeer && slot?.occupant === 'human' && slot.playerId === fromPeer) {
          dispatchAction(msg.seat, msg.action)
        }
        break
      }
    }
  }

  // ---- 房主：開局（先公布密鑰承諾，再收客機種子，才洗牌）----
  let pendingSeeds: Map<SeatIndex, string> | null = null
  let seedsReady: (() => void) | null = null
  const SEED_WAIT_MS = 8000

  async function beginRound(first: boolean, customSeed?: string): Promise<void> {
    const rand = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const secret = `host-secret-${rand()}${randomHex(8)}`
    let roundSeed = customSeed ?? `twmj-seed-${rand()}`

    const guests = guestSlots()
    if (transport && guests.length > 0) {
      // 房主在看到任何客機種子「之前」就鎖定密鑰，之後無法依牌序調整
      pendingSeeds = new Map()
      const gathered = new Promise<void>((resolve) => {
        seedsReady = resolve
        setTimeout(resolve, SEED_WAIT_MS)
      })
      transport.broadcast({
        type: 'SEED_COMMIT',
        seat: localSeat.value,
        commitHash: sha256Hex(secret),
      })
      await gathered
      roundSeed = [...pendingSeeds.entries()]
        .sort(([a], [b]) => a - b)
        .map(([seat, seed]) => `${seat}:${seed}`)
        .join('|')
      pendingSeeds = null
      seedsReady = null
    }

    playSfx('shuffle')
    if (first) startRound(state, roundSeed, secret)
    else prepareNextRound(state, roundSeed, secret)
    syncSeq = 0
    if (transport && guests.length > 0) {
      transport.broadcast({
        type: 'WALL_LOCKED',
        roundSeed: state.roundSeed,
        hostCommit: sha256Hex(secret),
        leafHashes: state.wallLeafHashes,
      })
    }
    afterStateChange(null, null)
    scheduleBotStepIfNeeded()
  }

  function createSecureTable(): void {
    if (!transport || !options.security || options.security.members.length < 2) return
    let lastHead = state.headCursor
    secure = new SecureTable({
      state,
      localSeat: localSeat.value,
      isHost: isHost.value,
      roomSeats: options.roomSeats ?? [],
      transport,
      security: options.security,
      onStep: (_actor, action) => {
        playActionSfx(action, lastHead)
        lastHead = state.headCursor
        secureAudited.value = secure?.audited ?? false
        if (action === null && state.phase === 'TURN_ACTION_OR_DISCARD') playSfx('shuffle')
        if (action && (action.type === 'DISCARD' || action.type === 'DECLARE_MIGI')) {
          migiSelectMode.value = false
          selectedTileId.value = null
        }
        viewSeq.value++
        scheduleBotStepIfNeeded()
      },
      onFault: (f) => {
        securityFault.value = f
        secureAudited.value = secure?.audited ?? false
        clearBotTimer()
        viewSeq.value++
      },
    })
  }

  async function initAndStartRound(customSeed?: string): Promise<void> {
    await initMahjongWasm()
    createSecureTable()
    if (secure) {
      // 客機：先處理觸發開局的那則（序號最小），再接管大廳暫存的後續訊息，順序才不會亂
      if (!isHost.value && options.initialMessage) handleProtocolMessage(options.initialMessage)
      transport?.setMessageSink(handleProtocolMessage)
      if (isHost.value) secure.startRound()
      return
    }
    // 牌桌就緒才接管連線訊息，之前的訊息由 transport 暫存
    transport?.setMessageSink(handleProtocolMessage)
    if (isHost.value) {
      await beginRound(true, customSeed)
    } else if (options.initialMessage) {
      handleProtocolMessage(options.initialMessage)
    }
  }

  async function startNextRound(): Promise<void> {
    if (!isHost.value || state.phase !== 'ROUND_SETTLEMENT') return
    if (secure) {
      securityFault.value = null
      secureAudited.value = false
      secure.startRound()
      return
    }
    await beginRound(false)
  }

  /** 下載用：本機收到的全部簽章訊息（第三方可自行驗簽與稽核） */
  function exportEvidence() {
    return secure?.exportEvidence() ?? null
  }

  /** 將斷線玩家座位轉為電腦玩家立即接手 */
  function convertSeatToBot(seat: SeatIndex): void {
    state.seats[seat].isBot = true
    state.seats[seat].name = `${state.seats[seat].name} (電腦代打)`
    scheduleBotStepIfNeeded()
  }

  onUnmounted(() => {
    clearBotTimer()
    transport?.setMessageSink(null)
  })

  return {
    state,
    localSeat,
    localPlayer,
    selfTurnOptions,
    localClaimEntry,
    waitingKinds,
    tenpaiDiscards,
    visibleCount,
    migiSelectMode,
    selectedTileId,
    viewSeq,
    initAndStartRound,
    startNextRound,
    dispatchAction,
    handleProtocolMessage,
    convertSeatToBot,
    auditStatus,
    securityFault,
    exportEvidence,
  }
}
