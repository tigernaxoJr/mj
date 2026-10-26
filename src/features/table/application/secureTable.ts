/**
 * WP-5.5: 防作弊牌局的本機流程（兩位以上真人）
 *
 * 每台裝置（含房主）都只用「自己看得到的」資訊跑同一套規則引擎：
 * - 房主只負責排序轉送與執行電腦座位，不再是全知裁判。
 * - 引擎要摸未宣告的牌山位置時丟出 WallPending，交給 SecureDeck 取得金鑰分享與持有者宣告後再重跑。
 * - 動作以 SECURE_ACTION 廣播，附上需要公開的牌；各家自行驗證後套用。
 * - 結算時各家公開本局秘密：先稽核洗牌與換鑰，再以完整資訊重播整局、逐步比對公開投影。
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
import { publicProjection, replaySecureRound, type SecureStep } from '../domain/secureAudit'
import {
  applyPlayerAction,
  hiddenTileAt,
  rotateDealer,
  startSecureRound,
  WALL_UNKNOWN,
  WallPending,
  type TableState,
} from '../domain/tableState'
import { SecureDeck, type DeckFault, type RoundAudit } from './deckProtocol'
import { SecureChannel, type EvidenceLog, type InnerMessage } from './secureChannel'

const HOST_SEAT: SeatIndex = 0

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
  /** 每套用一步（開局配牌或一個動作）之後 */
  onStep: (actor: SeatIndex | null, action: PlayerActionCommand | null) => void
  onFault?: (fault: DeckFault) => void
  /** 測試用：固定每局秘密 */
  secretFor?: (round: number) => Uint8Array
}

type Step = { kind: 'start' } | { kind: 'action'; seat: SeatIndex; action: PlayerActionCommand }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export class SecureTable {
  readonly channel: SecureChannel
  round = -1
  deck: SecureDeck | null = null
  fault: DeckFault | null = null
  /** 本局已完成結算稽核 */
  audited = false
  private wall: TileId[] = []
  private base: TableState | null = null
  private steps: SecureStep[] = []
  private projections: string[] = []
  private pending: Step | null = null
  private queue: { seat: SeatIndex; action: PlayerActionCommand; reveals: TileRevealProof[] }[] = []
  private readonly layers: SeatIndex[]

  constructor(private readonly opts: SecureTableOptions) {
    this.layers = opts.security.members.map((m) => m.seat).sort((a, b) => a - b)
    this.channel = new SecureChannel({
      transport: opts.transport,
      seeds: opts.security.seeds,
      roomCode: opts.security.roomCode,
      localSeat: opts.localSeat,
      isHost: opts.isHost,
      members: opts.security.members,
      seatOfPeer: (peer: PlayerId) => opts.roomSeats.find((s) => s.playerId === peer && s.occupant === 'human')?.seat,
      onMessage: (msg, signer) => this.onMessage(msg, signer),
    })
  }

  get state(): TableState {
    return this.opts.state
  }

  receive(raw: ProtocolMessage, fromPeer?: PlayerId): boolean {
    return this.channel.receive(raw, fromPeer)
  }

  exportEvidence(): EvidenceLog {
    return this.channel.exportEvidence()
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
    return !this.layers.includes(seat)
  }

  /** 本機（或房主代電腦座位）送出動作，連同需要公開的牌 */
  submit(seat: SeatIndex, action: PlayerActionCommand): boolean {
    const mine = seat === this.opts.localSeat || (this.opts.isHost && this.isBotSeat(seat))
    if (!mine || !this.deck || this.fault) return false
    const proofs: TileRevealProof[] = []
    for (const tile of this.tilesToReveal(seat, action)) {
      // 找本機握有全部金鑰的那個位置（牌山若被動過手腳，同一張牌可能出現兩次）
      let proof: TileRevealProof | null = null
      for (let i = 0; i < this.wall.length && !proof; i++) {
        if (this.wall[i] === tile) proof = this.deck.proofFor(i)
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
    if (!this.audited) this.revealOnce()
  }

  private secretRevealed = false

  private revealOnce(): void {
    if (this.secretRevealed || !this.deck) return
    this.secretRevealed = true
    this.deck.revealSecret()
  }

  /** 這一家此刻是否該行動（輪到他，或回應窗中還沒回應） */
  private hasDuty(seat: SeatIndex): boolean {
    const s = this.state
    if (s.phase === 'TURN_ACTION_OR_DISCARD') return s.currentSeat === seat
    if (s.phase === 'CLAIM_WINDOW') return s.claimWindow.some((c) => c.seat === seat && !c.responded)
    return false
  }

  private onMessage(msg: InnerMessage, signer: SeatIndex): void {
    const deck = this.deck
    switch (msg.type) {
      case 'ROUND_START':
        if (signer === HOST_SEAT && msg.round === this.round + 1) this.beginRound(msg.round)
        return
      case 'DECK_SHUFFLED':
        if (deck && msg.round === this.round) deck.onShuffled(msg.seat, msg.deck, signer)
        return
      case 'DECK_REKEYED':
        if (deck && msg.round === this.round) deck.onRekeyed(msg.seat, msg.deck, msg.keyCommits, signer)
        return
      case 'KEY_SHARE':
        if (deck && msg.round === this.round) deck.onKeyShare(msg, signer)
        return
      case 'TILE_RESOLVE':
        if (deck && msg.round === this.round) deck.onTileResolve(msg, signer)
        return
      case 'SECURE_ACTION': {
        if (msg.round !== this.round) return
        const allowed = this.isBotSeat(msg.seat) ? signer === HOST_SEAT : signer === msg.seat
        if (!allowed) return this.raise({ seat: signer, reason: '替別人的座位出牌' })
        this.queue.push({ seat: msg.seat, action: msg.action, reveals: msg.reveals ?? [] })
        this.processQueue()
        return
      }
      case 'ROUND_REVEAL': {
        if (!deck || msg.round !== this.round || this.audited) return
        // 牌局中途收到秘密 = 有人宣告本局作廢，跟著公開好讓大家一起稽核
        if (this.state.phase !== 'ROUND_SETTLEMENT') this.revealOnce()
        const res = deck.onRoundReveal(msg.seat, msg.secret, signer)
        if (res) this.finishAudit(res)
        return
      }
    }
  }

  private beginRound(round: number): void {
    if (round > 0) rotateDealer(this.state)
    this.round = round
    this.audited = false
    this.fault = null
    this.secretRevealed = false
    this.state.auditVerified = true
    this.base = clone(this.state)
    this.steps = []
    this.projections = []
    this.pending = null
    this.queue = []
    this.wall = new Array<TileId>(144).fill(WALL_UNKNOWN)
    this.deck = new SecureDeck({
      round,
      localSeat: this.opts.localSeat,
      layers: this.layers,
      members: this.opts.security.members,
      seeds: this.opts.security.seeds,
      secret: this.opts.secretFor?.(round),
      send: (m) => this.channel.send(m),
      onReady: () => this.run({ kind: 'start' }),
      onResolved: (list) => {
        for (const { wallIndex, tile } of list) this.wall[wallIndex] = tile ?? hiddenTileAt(wallIndex)
        this.retryPending()
      },
      onFault: (f) => this.raise(f),
    })
    this.deck.start()
  }

  private retryPending(): void {
    const step = this.pending
    if (!step) return
    this.pending = null
    this.run(step)
  }

  private processQueue(): void {
    while (!this.pending && !this.fault && this.queue.length > 0) {
      const item = this.queue.shift()!
      if (!this.applyReveals(item.seat, item.reveals)) return
      this.run({ kind: 'action', seat: item.seat, action: item.action })
    }
  }

  /** 把公開的牌換進該座位的手牌（本機原本只看得到佔位） */
  private applyReveals(seat: SeatIndex, reveals: readonly TileRevealProof[]): boolean {
    const p = this.state.seats[seat]
    for (const proof of reveals) {
      const tile = this.deck?.verifyProof(proof) ?? null
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
    if (this.fault) return
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
      this.deck?.request(err.positions)
      return
    }
    Object.assign(this.state, next)
    if (step.kind === 'action') this.steps.push({ actor: step.seat, action: step.action })
    this.projections.push(publicProjection(this.state))
    this.opts.onStep(step.kind === 'action' ? step.seat : null, step.kind === 'action' ? step.action : null)
    if (this.state.phase === 'ROUND_SETTLEMENT') this.revealOnce()
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
