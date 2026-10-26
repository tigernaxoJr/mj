/**
 * WP-5.5 / 5.6: 防作弊牌局的本機流程（兩位以上真人）
 *
 * 每台裝置（含房主）都只用「自己看得到的」資訊跑同一套規則引擎：
 * - 房主只負責排序轉送與執行電腦座位，不再是全知裁判。
 * - 引擎要摸未宣告的牌山位置時丟出 WallPending，交給發牌者（WallDealer）取得持有者宣告後再重跑。
 * - 動作以 SECURE_ACTION 廣播，附上需要公開的牌；各家自行驗證後套用。
 * - 結算時各家公開本局秘密：先稽核洗牌與換鑰，再以完整資訊重播整局、逐步比對公開投影。
 * - 有真人中途離開或逾時：降級為房主發牌（degradeProtocol.ts），或依房間設定直接作廢。
 */
import type {
  PlayerActionCommand,
  PlayerId,
  ProtocolMessage,
  RoomMemberKeys,
  RoomSeatSlot,
  SeatIndex,
  TileId,
  TileRevealProof,
} from '@/shared/kernel/types'
import { kindOf } from '@/shared/kernel/types'
import type { MpIdentitySeeds } from '@/shared/wasm'
import type { PeerTransportPort } from '@/features/lobby/infra/peerAdapter'
import { publicProjection, replaySecureRound, seatHasDuty, type SecureStep } from '../domain/secureAudit'
import {
  applyPlayerAction,
  hiddenTileAt,
  rotateDealer,
  startSecureRound,
  WALL_UNKNOWN,
  WallPending,
  type TableState,
} from '../domain/tableState'
import { SecureDeck, type DeckFault, type RoundAudit, type WallDealer } from './deckProtocol'
import { DegradeSession, degradedHand, HostDeck, VIRTUAL_BASE, type DegradeWall } from './degradeProtocol'
import { SecureChannel, type EvidenceLog, type InnerMessage } from './secureChannel'

const HOST_SEAT: SeatIndex = 0
/** 協定步驟（洗牌、金鑰分享、宣告、公開秘密）多久沒進展就判定逾時 */
export const PROTOCOL_TIMEOUT_MS = 15_000
/** 輪到真人出牌或回應卻毫無動靜多久，視同斷線（給思考留足時間） */
export const ACTION_TIMEOUT_MS = 60_000

export interface SecureTableSecurity {
  roomCode: string
  seeds: MpIdentitySeeds
  members: RoomMemberKeys[]
}

export interface SecureTableOptions {
  state: TableState
  localSeat: SeatIndex
  isHost: boolean
  roomSeats: readonly RoomSeatSlot[]
  transport: PeerTransportPort
  security: SecureTableSecurity
  /** 每套用一步（開局配牌或一個動作）之後，以及狀態提示改變時 */
  onStep: (actor: SeatIndex | null, action: PlayerActionCommand | null) => void
  onFault?: (fault: DeckFault) => void
  /** 測試用：固定每局秘密、時鐘 */
  secretFor?: (round: number) => Uint8Array
  now?: () => number
}

/** 牌局中的事件紀錄（斷線、逾時、降級、作廢），結算畫面與證據檔都會列出 */
export interface TableIncident {
  round: number
  seat: SeatIndex
  reason: string
  outcome: 'degraded' | 'void' | 'left'
}

type Step = { kind: 'start' } | { kind: 'action'; seat: SeatIndex; action: PlayerActionCommand }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export class SecureTable {
  readonly channel: SecureChannel
  round = -1
  deck: SecureDeck | null = null
  fault: DeckFault | null = null
  /** 本局已完成結算稽核（或已確定無法完整稽核） */
  audited = false
  /** 本局曾降級或作廢的說明；null 表示完整驗證 */
  degradedNote: string | null = null
  readonly incidents: TableIncident[] = []
  /** 本機被判定離開（逾時），只能旁觀 */
  spectator = false
  /** 客機：與房主斷線 */
  hostLost = false
  private dealer: WallDealer | null = null
  private degrade: DegradeSession | null = null
  private departed = new Set<SeatIndex>()
  private wall: TileId[] = []
  private base: TableState | null = null
  private steps: SecureStep[] = []
  private projections: string[] = []
  private pending: Step | null = null
  private queue: { seat: SeatIndex; action: PlayerActionCommand; reveals: TileRevealProof[] }[] = []
  private secretRevealed = false
  /** 逾時判定：最後一次收到訊息的時間、目前在等的位置、已看到的金鑰分享與宣告 */
  private lastProgress = 0
  private awaiting: { wallIndex: number; seat: SeatIndex }[] = []
  private sharesSeen = new Map<number, Set<SeatIndex>>()
  private resolvedSeen = new Set<number>()

  constructor(private readonly opts: SecureTableOptions) {
    this.channel = new SecureChannel({
      transport: opts.transport,
      seeds: opts.security.seeds,
      roomCode: opts.security.roomCode,
      localSeat: opts.localSeat,
      isHost: opts.isHost,
      members: opts.security.members,
      seatOfPeer: (peer: PlayerId) => this.seatOfPeer(peer),
      onMessage: (msg, signer) => {
        this.lastProgress = this.now()
        this.onMessage(msg, signer)
      },
    })
    this.lastProgress = this.now()
  }

  get state(): TableState {
    return this.opts.state
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private seatOfPeer(peer: PlayerId): SeatIndex | undefined {
    return this.opts.roomSeats.find((s) => s.playerId === peer && s.occupant === 'human')?.seat
  }

  /** 仍在場的真人座位（層），由小到大 */
  activeHumans(): SeatIndex[] {
    return this.opts.security.members
      .map((m) => m.seat)
      .filter((s) => !this.departed.has(s))
      .sort((a, b) => a - b)
  }

  receive(raw: ProtocolMessage, fromPeer?: PlayerId): boolean {
    return this.channel.receive(raw, fromPeer)
  }

  exportEvidence(): EvidenceLog {
    return { ...this.channel.exportEvidence(), rules: { ...this.state.rules }, incidents: [...this.incidents] }
  }

  /** 本局重播稽核的輸入：開局前狀態、依序套用的動作、每步之後的公開投影 */
  auditTranscript(): { base: TableState; steps: SecureStep[]; projections: string[] } | null {
    return this.base ? { base: clone(this.base), steps: [...this.steps], projections: [...this.projections] } : null
  }

  /** 房主：開新的一局（上一局必須已完成稽核） */
  startRound(): boolean {
    if (!this.opts.isHost || (this.round >= 0 && !this.audited)) return false
    this.channel.send({ type: 'ROUND_START', round: this.round + 1 })
    return true
  }

  isBotSeat(seat: SeatIndex): boolean {
    return !this.activeHumans().includes(seat)
  }

  /** 本機（或房主代電腦座位）送出動作，連同需要公開的牌 */
  submit(seat: SeatIndex, action: PlayerActionCommand): boolean {
    const mine = (seat === this.opts.localSeat && !this.spectator) || (this.opts.isHost && this.isBotSeat(seat))
    if (!mine || !this.dealer || this.fault || this.hostLost) return false
    const proofs: TileRevealProof[] = []
    for (const tile of this.tilesToReveal(seat, action)) {
      // 找本機握有證明的那個位置（牌山若被動過手腳，同一張牌可能出現兩次）
      let proof: TileRevealProof | null = null
      for (let i = 0; i < this.wall.length && !proof; i++) {
        if (this.wall[i] === tile) proof = this.dealer.proofFor(i)
      }
      if (!proof) return false
      proofs.push(proof)
    }
    this.channel.send({ type: 'SECURE_ACTION', round: this.round, seat, action, reveals: proofs })
    return true
  }

  private tilesToReveal(seat: SeatIndex, action: PlayerActionCommand): TileId[] {
    const p = this.state.seats[seat]
    const entry = this.state.claimWindow.find((c) => c.seat === seat)
    switch (action.type) {
      case 'DISCARD':
        return [action.tileId]
      case 'DECLARE_MIGI':
        return [action.discardTileId]
      case 'TSUMO':
      case 'CLAIM_RON':
        return [...p.concealed]
      case 'ANKAN':
      case 'KAKAN':
        return p.concealed.filter((t) => kindOf(t) === action.kind)
      case 'CLAIM_PON':
        return entry?.ponTiles ? [...entry.ponTiles] : []
      case 'CLAIM_MINKAN':
        return entry?.minkanTiles ? [...entry.minkanTiles] : []
      case 'CLAIM_CHII':
        return [...action.meldTiles]
      case 'CLAIM_PASS':
        return []
    }
  }

  // ---- 斷線、逾時 ----

  /** 房主：transport 回報某客機離線 */
  onPeerLeft(peer: PlayerId): void {
    const seat = this.seatOfPeer(peer)
    if (this.opts.isHost && seat !== undefined && !this.departed.has(seat)) this.announceLeave(seat, '斷線')
  }

  /** 客機：與房主斷線，整個房間結束 */
  onHostLost(): void {
    this.hostLost = true
    this.opts.onStep(null, null)
  }

  private announceLeave(seat: SeatIndex, reason: string): void {
    const inRound = this.round >= 0 && !this.audited && this.state.phase !== 'ROUND_SETTLEMENT'
    const type = inRound && this.state.rules.voidOnDisconnect ? 'ROUND_VOID' : 'DEGRADE'
    this.channel.send({ type, round: this.round, seat, reason })
  }

  /** 房主定時呼叫：協定步驟卡住太久時，找出該負責的座位，比照斷線處理 */
  tick(): void {
    if (!this.opts.isHost || this.hostLost) return
    const elapsed = this.now() - this.lastProgress
    if (elapsed < PROTOCOL_TIMEOUT_MS) return
    const culprit = this.stalledSeat() ?? (elapsed >= ACTION_TIMEOUT_MS ? this.idleHuman() : null)
    if (culprit === null) return
    this.lastProgress = this.now()
    if (this.degrade && !this.degrade.wall) {
      // 降級交接中又有人不回應：直接作廢
      this.channel.send({ type: 'ROUND_VOID', round: this.round, seat: culprit, reason: '降級交接逾時' })
    } else {
      this.announceLeave(culprit, '逾時')
    }
  }

  private stalledSeat(): SeatIndex | null {
    if (this.round < 0 || this.audited || !this.deck) return null
    const humans = this.activeHumans().filter((s) => s !== HOST_SEAT)
    if (this.degrade && !this.degrade.wall) return this.degrade.waitingFor()[0] ?? null
    if (this.state.phase === 'ROUND_SETTLEMENT') {
      if (this.degrade) return null
      return humans.find((s) => !this.deck!.revealedSeats.includes(s)) ?? null
    }
    if (!this.deck.isReady) {
      const next = this.deck.nextShuffler
      return next !== null && next !== HOST_SEAT ? next : null
    }
    if (!this.pending) return null
    for (const { wallIndex, seat } of this.awaiting) {
      if (this.resolvedSeen.has(wallIndex)) continue
      const recipient = this.activeHumans().includes(seat) ? seat : HOST_SEAT
      if (!this.degrade) {
        const seen = this.sharesSeen.get(wallIndex) ?? new Set()
        const missing = humans.find((s) => s !== recipient && !seen.has(s))
        if (missing !== undefined) return missing
      }
      if (recipient !== HOST_SEAT) return recipient
    }
    return null
  }

  /** 輪到他出牌或回應、卻一直沒送出動作的真人客機 */
  private idleHuman(): SeatIndex | null {
    if (this.round < 0 || this.audited || this.pending || this.paused) return null
    const humans = this.activeHumans().filter((s) => s !== HOST_SEAT)
    return humans.find((s) => this.hasDuty(s)) ?? null
  }

  private markDeparted(seat: SeatIndex, reason: string, outcome: TableIncident['outcome']): void {
    if (!this.departed.has(seat)) {
      this.departed.add(seat)
      const p = this.state.seats[seat]
      p.isBot = true
      if (!p.name.endsWith('（電腦代打）')) p.name = `${p.name}（電腦代打）`
    }
    if (seat === this.opts.localSeat) this.spectator = true
    this.incidents.push({ round: this.round, seat, reason, outcome })
  }

  private onDegrade(seat: SeatIndex, reason: string): void {
    const inRound = this.round >= 0 && !this.audited && this.deck
    const settled = this.state.phase === 'ROUND_SETTLEMENT'
    this.markDeparted(seat, reason, inRound && !settled ? 'degraded' : 'left')
    if (!inRound) return this.opts.onStep(null, null)
    if (settled) {
      // 已經結算、只差公開秘密：分數照算，但牌山無法完整稽核
      this.audited = true
      this.degradedNote = `${this.state.seats[seat].name}在稽核前離開，本局未完整驗證`
      return this.opts.onStep(null, null)
    }
    this.degradedNote = `${this.state.seats[seat].name}${reason}，本局防作弊已失效，改由房主發牌`
    const head = this.state.headCursor
    const tail = this.state.tailCursor
    // 未摸的位置（含已宣告但還沒摸進手牌的）一律回到未知，等重洗後重發
    for (let i = head; i < tail; i++) this.wall[i] = WALL_UNKNOWN
    const deck = this.deck!
    this.degrade = new DegradeSession({
      round: this.round,
      localSeat: this.opts.localSeat,
      isHost: this.opts.isHost,
      leaver: seat,
      humans: this.activeHumans(),
      members: this.opts.security.members,
      seeds: this.opts.security.seeds,
      inner: deck,
      myHand: () =>
        this.state.seats[this.opts.localSeat].concealed.map((tile) => ({ wallIndex: this.wall.indexOf(tile), tile })),
      hostView: () => ({
        concealed: this.state.seats.map((s) => s.concealed),
        publicTiles: this.state.seats.flatMap((s) => [...s.discards, ...s.flowers, ...s.melds.flatMap((m) => m.tiles)]),
        head,
        tail,
      }),
      send: (m) => this.channel.send(m),
      onWall: (w) => this.installDegradedWall(seat, w),
      onFault: (f) => this.raise(f),
    })
    this.opts.onStep(null, null)
    this.degrade.start()
  }

  /** 重洗完成：代打座位換上新手牌，改由房主發牌，繼續剛才卡住的那一步 */
  private installDegradedWall(leaver: SeatIndex, w: DegradeWall): void {
    const deck = this.deck!
    const p = this.state.seats[leaver]
    const oldLast = p.concealed[p.concealed.length - 1]
    p.concealed = degradedHand(w, p.concealed.length)
    if (this.state.lastDrawnTile?.seat === leaver && this.state.lastDrawnTile.tileId === oldLast) {
      this.state.lastDrawnTile.tileId = p.concealed[p.concealed.length - 1]
    }
    p.concealed.forEach((t, k) => (this.wall[VIRTUAL_BASE + k] = t))
    this.dealer = new HostDeck({
      round: this.round,
      localSeat: this.opts.localSeat,
      isHost: this.opts.isHost,
      humans: this.activeHumans(),
      members: this.opts.security.members,
      seeds: this.opts.security.seeds,
      inner: deck,
      slots: w.slots,
      leafHashes: w.leafHashes,
      tiles: w.tiles,
      send: (m) => this.channel.send(m),
      onResolved: (list) => this.onResolved(list),
      onFault: (f) => this.raise(f),
    })
    this.opts.onStep(null, null)
    if (this.pending) this.retryPending()
    // 洗牌階段就降級：還沒配牌，直接由房主發牌開局
    else if (this.projections.length === 0) this.run({ kind: 'start' })
    else this.processQueue()
  }

  private onVoid(seat: SeatIndex, reason: string): void {
    this.markDeparted(seat, reason, 'void')
    if (this.round < 0 || this.audited) return this.opts.onStep(null, null)
    this.pending = null
    this.queue = []
    this.audited = true
    this.degradedNote = `${this.state.seats[seat].name}${reason}，本局作廢（不計分）`
    this.state.phase = 'ROUND_SETTLEMENT'
    this.state.claimWindow = []
    this.state.settlement = {
      winnerSeats: [],
      loserSeat: null,
      isTsumo: false,
      isExhaustiveDraw: true,
      winningTile: null,
      taiItems: [{ name: '玩家離開，本局作廢', tai: 0 }],
      totalTai: 0,
      scoreDeltas: [0, 0, 0, 0],
    }
    this.opts.onStep(null, null)
  }

  // ---- 違規 ----

  /**
   * 發現違規：本局作廢並立刻公開本局秘密。別家收到秘密也會跟著公開，
   * 大家一起稽核洗牌與換鑰，找出根本原因（例如洗牌時複製了牌）。
   * `override`：牌山稽核的結論優先於先前看到的表面症狀。
   */
  private raise(fault: DeckFault, override = false): void {
    if (this.fault && !override) return
    this.fault = fault
    this.state.auditVerified = false
    this.opts.onFault?.(fault)
    if (!this.audited && !this.degrade) this.revealOnce()
  }

  private revealOnce(): void {
    if (this.secretRevealed || !this.deck) return
    this.secretRevealed = true
    this.deck.revealSecret()
  }

  private hasDuty(seat: SeatIndex): boolean {
    return seatHasDuty(this.state, seat)
  }

  private onMessage(msg: InnerMessage, signer: SeatIndex): void {
    const deck = this.deck
    const current = 'round' in msg && msg.round === this.round
    switch (msg.type) {
      case 'ROUND_START':
        if (signer === HOST_SEAT && msg.round === this.round + 1) this.beginRound(msg.round)
        return
      case 'DEGRADE':
        if (signer === HOST_SEAT && msg.round === this.round) this.onDegrade(msg.seat, msg.reason)
        return
      case 'ROUND_VOID':
        if (signer === HOST_SEAT && msg.round === this.round) this.onVoid(msg.seat, msg.reason)
        return
    }
    if (!current || !deck) return
    switch (msg.type) {
      case 'DECK_SHUFFLED':
        return deck.onShuffled(msg.seat, msg.deck, signer)
      case 'DECK_REKEYED':
        return deck.onRekeyed(msg.seat, msg.deck, msg.keyCommits, signer)
      case 'KEY_SHARE':
        if (!this.sharesSeen.has(msg.wallIndices[0])) for (const i of msg.wallIndices) this.sharesSeen.set(i, new Set())
        for (const i of msg.wallIndices) this.sharesSeen.get(i)?.add(msg.from)
        if (!this.degrade) deck.onKeyShare(msg, signer)
        return
      case 'TILE_RESOLVE':
        for (const i of msg.wallIndices) this.resolvedSeen.add(i)
        return this.dealer?.onTileResolve(msg, signer)
      case 'SECURE_ACTION': {
        const allowed = this.isBotSeat(msg.seat) ? signer === HOST_SEAT : signer === msg.seat
        if (!allowed) return this.raise({ seat: signer, reason: '替別人的座位出牌' })
        this.queue.push({ seat: msg.seat, action: msg.action, reveals: msg.reveals ?? [] })
        return this.processQueue()
      }
      case 'ROUND_REVEAL': {
        if (this.audited || this.degrade) return
        // 牌局中途收到秘密 = 有人宣告本局作廢，跟著公開好讓大家一起稽核
        if (this.state.phase !== 'ROUND_SETTLEMENT') this.revealOnce()
        const res = deck.onRoundReveal(msg.seat, msg.secret, signer)
        if (res) this.finishAudit(res)
        return
      }
      case 'DEGRADE_HAND':
        return this.degrade?.onHand(msg, signer)
      case 'DEGRADE_COMMIT':
        return this.degrade?.onCommit(msg.commit, signer)
      case 'DEGRADE_SEED':
        return this.degrade?.onSeed(msg.seat, msg.seed, signer)
      case 'DEGRADE_WALL':
        return this.degrade?.onWall(msg, signer)
      case 'DEGRADE_DEAL':
        if (this.dealer instanceof HostDeck) this.dealer.onDeal(msg, signer)
        return
      case 'DEGRADE_REVEAL': {
        if (signer !== HOST_SEAT || !this.degrade || this.audited || this.state.phase !== 'ROUND_SETTLEMENT') return
        this.audited = true
        const err = this.degrade.verifyReveal(msg.secret)
        if (err) this.raise({ seat: HOST_SEAT, reason: err }, true)
        this.opts.onStep(null, null)
        return
      }
    }
  }

  private beginRound(round: number): void {
    if (round > 0) rotateDealer(this.state)
    this.round = round
    this.audited = false
    this.fault = null
    this.degradedNote = null
    this.degrade = null
    this.secretRevealed = false
    this.state.auditVerified = true
    this.base = clone(this.state)
    this.steps = []
    this.projections = []
    this.pending = null
    this.queue = []
    this.awaiting = []
    this.sharesSeen.clear()
    this.resolvedSeen.clear()
    this.wall = new Array<TileId>(144).fill(WALL_UNKNOWN)
    this.deck = new SecureDeck({
      round,
      localSeat: this.opts.localSeat,
      layers: this.activeHumans(),
      members: this.opts.security.members,
      seeds: this.opts.security.seeds,
      secret: this.opts.secretFor?.(round),
      send: (m) => this.channel.send(m),
      onReady: () => {
        if (!this.degrade) this.run({ kind: 'start' })
      },
      onResolved: (list) => this.onResolved(list),
      onFault: (f) => this.raise(f),
    })
    this.dealer = this.deck
    this.deck.start()
  }

  private onResolved(list: { wallIndex: number; tile: TileId | null }[]): void {
    for (const { wallIndex, tile } of list) this.wall[wallIndex] = tile ?? hiddenTileAt(wallIndex)
    this.retryPending()
  }

  private retryPending(): void {
    const step = this.pending
    if (!step) return
    this.pending = null
    this.run(step)
  }

  /** 降級交接進行中：先別動牌局 */
  private get paused(): boolean {
    return this.degrade !== null && this.degrade.wall === null
  }

  private processQueue(): void {
    while (!this.pending && !this.fault && !this.paused && this.queue.length > 0) {
      const item = this.queue.shift()!
      if (!this.applyReveals(item.seat, item.reveals)) return
      this.run({ kind: 'action', seat: item.seat, action: item.action })
    }
  }

  /** 把公開的牌換進該座位的手牌（本機原本只看得到佔位） */
  private applyReveals(seat: SeatIndex, reveals: readonly TileRevealProof[]): boolean {
    const p = this.state.seats[seat]
    for (const proof of reveals) {
      const tile = this.dealer?.verifyProof(proof) ?? null
      if (tile === null) return this.raise({ seat, reason: `公開的牌無效（位置 ${proof.wallIndex}）` }), false
      const hidden = hiddenTileAt(proof.wallIndex)
      const at = p.concealed.indexOf(hidden)
      if (at >= 0) p.concealed[at] = tile
      else if (!p.concealed.includes(tile)) return this.raise({ seat, reason: `公開的牌不在手上（位置 ${proof.wallIndex}）` }), false
      if (this.state.lastDrawnTile?.tileId === hidden) this.state.lastDrawnTile.tileId = tile
      this.wall[proof.wallIndex] = tile
    }
    return true
  }

  private run(step: Step): void {
    if (this.fault || this.audited) return
    if (this.paused) {
      this.pending = step
      return
    }
    const next = clone(this.state)
    try {
      if (step.kind === 'start') {
        startSecureRound(next, this.wall)
      } else {
        next.wallTiles = [...this.wall]
        if (!applyPlayerAction(next, step.seat, step.action)) {
          // 不該他行動時（例如連點兩次）直接忽略；輪到他卻送出不合法的動作就是違規
          if (this.hasDuty(step.seat)) return this.raise({ seat: step.seat, reason: '不合法的動作' })
          return this.processQueue()
        }
      }
    } catch (err) {
      if (!(err instanceof WallPending)) throw err
      this.pending = step
      this.awaiting = err.positions
      this.dealer?.request(err.positions)
      return
    }
    Object.assign(this.state, next)
    if (step.kind === 'action') this.steps.push({ actor: step.seat, action: step.action })
    this.projections.push(publicProjection(this.state))
    this.opts.onStep(step.kind === 'action' ? step.seat : null, step.kind === 'action' ? step.action : null)
    if (this.state.phase === 'ROUND_SETTLEMENT') {
      if (this.degrade) this.degrade.revealSecret()
      else this.revealOnce()
    }
    this.processQueue()
  }

  private finishAudit(res: RoundAudit): void {
    // 稽核失敗或中途作廢也算本局結束（結果標示為未通過），房主仍可開下一局
    this.audited = true
    // 牌山稽核能指出座位時，以它為準
    if (!res.ok) return this.raise(res.fault, res.fault.seat !== null)
    if (!this.base || this.fault || this.state.phase !== 'ROUND_SETTLEMENT') return
    const replay = replaySecureRound(this.base, res.wall, this.steps, this.projections)
    if (!replay.ok) {
      return this.raise({ seat: replay.seat, reason: `第 ${replay.step} 步${replay.reason}` })
    }
    // 稽核通過：換成完整資訊的狀態（結算畫面可看到四家手牌）
    Object.assign(this.state, replay.final, { auditVerified: !this.fault })
    this.opts.onStep(null, null)
  }
}
