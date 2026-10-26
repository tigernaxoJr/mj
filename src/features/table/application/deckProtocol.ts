/**
 * WP-5.4: Mental Poker 牌山協定（設計見 docs/04-host-anticheat-mental-poker.md §4.4～§4.7）
 *
 * 一局一個 SecureDeck。層 = 真人座位（由小到大），每層：
 *   洗牌輪 DECK_SHUFFLED → 換鑰輪 DECK_REKEYED（附 144 筆逐張鎖承諾）
 * 之後要摸哪個位置由公開的規則引擎決定（WallPending），每台裝置都算得出同一組位置：
 *   - 每位層持有者把該位置的逐張鎖以 crypto_box 封給「持有者」（真人本人；電腦座位則封給房主）
 *   - 持有者收齊後開鎖，送出 TILE_RESOLVE：花牌附全部金鑰公開，其餘只宣告「不是花」
 * 結算時各家公開本局秘密（ROUND_REVEAL），以 mpAuditRound 重算洗牌、換鑰與承諾並指出作弊層。
 *
 * 本類別不碰牌桌狀態，只負責密碼學與訊息；結果經 callbacks 交給 useTableSession。
 */
import type { SeatIndex, TileId, TileRevealProof } from '@/shared/kernel/types'
import { isFlowerKind, kindOf, type RoomMemberKeys } from '@/shared/kernel/types'
import {
  base64ToBytes,
  bytesToBase64,
  mpAuditRound,
  mpCardCommits,
  mpCardKey,
  mpCommitCardKey,
  mpDeckCipher,
  mpInitialDeck,
  mpOpenShare,
  mpRekeyPass,
  mpSealShare,
  mpShufflePass,
  mpUnlock,
  randomBytes32,
  type MpDeck,
  type MpIdentitySeeds,
} from '@/shared/wasm'
import type { InnerMessage } from './secureChannel'

const HOST_SEAT: SeatIndex = 0

export interface DeckFault {
  /** 責任座位；紀錄本身不完整時為 null */
  seat: SeatIndex | null
  reason: string
}

export interface SecureDeckOptions {
  round: number
  localSeat: SeatIndex
  /** 真人座位（層），由小到大 */
  layers: readonly SeatIndex[]
  members: readonly RoomMemberKeys[]
  seeds: MpIdentitySeeds
  send: (msg: InnerMessage) => void
  /** 洗牌、換鑰都完成，可以開始配牌 */
  onReady: () => void
  /** 某些位置已由持有者宣告：`tiles` 為本機可見的牌（花牌、自己的牌），其餘為 null（非花、看不到） */
  onResolved: (resolved: { wallIndex: number; tile: TileId | null }[]) => void
  onFault: (fault: DeckFault) => void
  /** 測試用：固定本局秘密 */
  secret?: Uint8Array
}

export type RoundAudit = { ok: true; wall: TileId[] } | { ok: false; fault: DeckFault }

/** 牌桌取得牌山位置的介面：Mental Poker 牌山，或斷線降級後的房主發牌 */
export interface WallDealer {
  readonly known: Map<number, TileId>
  request(positions: readonly { wallIndex: number; seat: SeatIndex }[]): void
  proofFor(wallIndex: number): TileRevealProof | null
  verifyProof(proof: TileRevealProof): TileId | null
  onTileResolve(msg: { seat: SeatIndex; wallIndices: number[]; flowers: TileRevealProof[] }, signer: SeatIndex): void
}

export class SecureDeck implements WallDealer {
  readonly secret: Uint8Array
  private readonly myLayer: number
  private shuffled: MpDeck[] = []
  private rekeyed: MpDeck[] = []
  private commits: Uint8Array[] = []
  /** 本機收到的逐張鎖：位置 → 層 → 金鑰 */
  private keys = new Map<number, Map<number, Uint8Array>>()
  /** 本機已知的牌（自己的、電腦座位的（房主）、公開的） */
  readonly known = new Map<number, TileId>()
  /** 已送出金鑰分享的位置（避免引擎重跑時重送） */
  private shared = new Set<number>()
  /** 由本機負責宣告、尚未宣告的位置：持有座位 → 位置 */
  private toResolve = new Map<SeatIndex, Set<number>>()
  private resolved = new Set<number>()
  private reveals = new Map<SeatIndex, Uint8Array>()
  private faulted = false

  constructor(private readonly opts: SecureDeckOptions) {
    this.secret = opts.secret ?? randomBytes32()
    this.myLayer = opts.layers.indexOf(opts.localSeat)
  }

  get isReady(): boolean {
    return this.rekeyed.length === this.opts.layers.length
  }

  /** 洗牌／換鑰輪下一個該動作的座位；都完成時為 null */
  get nextShuffler(): SeatIndex | null {
    const L = this.opts.layers.length
    const t = this.shuffled.length + this.rekeyed.length
    return t >= 2 * L ? null : this.opts.layers[t % L]
  }

  /** 已收到秘密的座位（逾時判定用） */
  get revealedSeats(): SeatIndex[] {
    return [...this.reveals.keys()]
  }

  private get finalDeck(): MpDeck {
    return this.rekeyed[this.rekeyed.length - 1]
  }

  private fault(seat: SeatIndex | null, reason: string): void {
    if (this.faulted) return
    this.faulted = true
    this.opts.onFault({ seat, reason })
  }

  /** 洗牌輪與換鑰輪共 2L 步，第 t 步由 layers[t % L] 執行 */
  start(): void {
    this.maybeTakeTurn()
  }

  private maybeTakeTurn(): void {
    const L = this.opts.layers.length
    const t = this.shuffled.length + this.rekeyed.length
    if (t >= 2 * L || t % L !== this.myLayer) return
    const { round, localSeat, layers } = this.opts
    const input = t === 0 ? mpInitialDeck() : t <= L ? this.shuffled[t - 1] : this.rekeyed[t - L - 1]
    let out: MpDeck
    try {
      out = t < L ? mpShufflePass(input, this.secret) : mpRekeyPass(input, this.secret)
    } catch {
      // 上一層送來的不是 144 個合法的點
      return this.fault(layers[(t - 1) % L], '牌山格式錯誤')
    }
    if (t < L) {
      this.opts.send({ type: 'DECK_SHUFFLED', round, seat: localSeat, deck: bytesToBase64(out) })
    } else {
      this.opts.send({
        type: 'DECK_REKEYED',
        round,
        seat: localSeat,
        deck: bytesToBase64(out),
        keyCommits: bytesToBase64(mpCardCommits(this.secret)),
      })
    }
  }

  private expectStep(seat: SeatIndex, signer: SeatIndex, rekey: boolean): boolean {
    const L = this.opts.layers.length
    const t = this.shuffled.length + this.rekeyed.length
    if (signer !== seat || this.opts.layers[t % L] !== seat || (t >= L) !== rekey || t >= 2 * L) {
      this.fault(signer, '不按順序的洗牌／換鑰訊息')
      return false
    }
    return true
  }

  onShuffled(seat: SeatIndex, deckB64: string, signer: SeatIndex): void {
    if (!this.expectStep(seat, signer, false)) return
    const deck = base64ToBytes(deckB64)
    // 點是否合法由下一層處理時檢查；是否為合法排列留到結算稽核
    if (deck.length !== 144 * 32) return this.fault(seat, '洗牌輸出格式錯誤')
    this.shuffled.push(deck)
    this.maybeTakeTurn()
  }

  onRekeyed(seat: SeatIndex, deckB64: string, commitsB64: string, signer: SeatIndex): void {
    if (!this.expectStep(seat, signer, true)) return
    const deck = base64ToBytes(deckB64)
    const commits = base64ToBytes(commitsB64)
    if (deck.length !== 144 * 32 || commits.length !== 144 * 32) return this.fault(seat, '換鑰輸出格式錯誤')
    this.rekeyed.push(deck)
    this.commits.push(commits)
    if (this.isReady) this.opts.onReady()
    else this.maybeTakeTurn()
  }

  /** 位置 i 的牌給誰看：真人本人；電腦座位由房主代管 */
  private recipientOf(owner: SeatIndex): SeatIndex {
    return this.opts.layers.includes(owner) ? owner : HOST_SEAT
  }

  private boxPubOf(seat: SeatIndex): Uint8Array {
    const m = this.opts.members.find((x) => x.seat === seat)
    if (!m) throw new Error(`座位 ${seat} 沒有公鑰`)
    return base64ToBytes(m.boxPub)
  }

  /** 引擎需要這些位置：送出金鑰分享，並記下自己要宣告的位置 */
  request(positions: readonly { wallIndex: number; seat: SeatIndex }[]): void {
    const { round, localSeat, seeds } = this.opts
    const outgoing = new Map<SeatIndex, { wallIndices: number[]; sealed: string[] }>()
    for (const { wallIndex, seat } of positions) {
      if (this.resolved.has(wallIndex)) continue
      const to = this.recipientOf(seat)
      if (to === localSeat) {
        if (!this.toResolve.has(seat)) this.toResolve.set(seat, new Set())
        this.toResolve.get(seat)!.add(wallIndex)
        this.storeKey(wallIndex, this.myLayer, mpCardKey(this.secret, wallIndex))
      } else if (this.myLayer >= 0 && !this.shared.has(wallIndex)) {
        this.shared.add(wallIndex)
        const batch = outgoing.get(to) ?? { wallIndices: [], sealed: [] }
        const ctx = { round, wallIndex, fromSeat: localSeat, toSeat: to }
        batch.wallIndices.push(wallIndex)
        batch.sealed.push(bytesToBase64(mpSealShare(seeds, this.boxPubOf(to), ctx, mpCardKey(this.secret, wallIndex))))
        outgoing.set(to, batch)
      }
    }
    for (const [to, batch] of outgoing) {
      this.opts.send({ type: 'KEY_SHARE', round, from: localSeat, to, ...batch })
    }
    this.flushResolves()
  }

  onKeyShare(msg: { from: SeatIndex; to: SeatIndex; wallIndices: number[]; sealed: string[] }, signer: SeatIndex): void {
    const { round, localSeat, seeds } = this.opts
    if (msg.to !== localSeat) return
    const layer = this.opts.layers.indexOf(msg.from)
    if (signer !== msg.from || layer < 0 || !this.isReady) return this.fault(signer, '來源不明的金鑰分享')
    msg.wallIndices.forEach((wallIndex, i) => {
      const ctx = { round, wallIndex, fromSeat: msg.from, toSeat: localSeat }
      const key = mpOpenShare(seeds, this.boxPubOf(msg.from), ctx, base64ToBytes(msg.sealed[i] ?? ''))
      // 解不開或與承諾不符：送錯金鑰的人當場現形
      if (!key || !this.matchesCommit(layer, wallIndex, key)) return this.fault(msg.from, `位置 ${wallIndex} 的金鑰分享不符承諾`)
      this.storeKey(wallIndex, layer, key)
    })
    this.flushResolves()
  }

  private matchesCommit(layer: number, wallIndex: number, key: Uint8Array): boolean {
    const want = this.commits[layer]?.subarray(wallIndex * 32, wallIndex * 32 + 32)
    if (!want) return false
    const got = mpCommitCardKey(key)
    return got.every((b, i) => b === want[i])
  }

  private storeKey(wallIndex: number, layer: number, key: Uint8Array): void {
    if (!this.keys.has(wallIndex)) this.keys.set(wallIndex, new Map())
    this.keys.get(wallIndex)!.set(layer, key)
  }

  private allKeys(wallIndex: number): Uint8Array[] | null {
    const got = this.keys.get(wallIndex)
    if (!got || got.size !== this.opts.layers.length) return null
    return this.opts.layers.map((_, layer) => got.get(layer)!)
  }

  /** 收齊金鑰的位置開鎖；某持有者要宣告的位置全部開完才送出（配牌時一次 16 張） */
  private flushResolves(): void {
    if (this.faulted) return
    for (const [owner, set] of this.toResolve) {
      const indices = [...set]
      if (indices.some((i) => !this.allKeys(i))) continue
      const flowers: TileRevealProof[] = []
      for (const wallIndex of indices) {
        const tile = mpUnlock(mpDeckCipher(this.finalDeck, wallIndex), this.allKeys(wallIndex)!)
        if (tile === null) return this.fault(owner, `位置 ${wallIndex} 開鎖失敗`)
        this.known.set(wallIndex, tile)
        if (isFlowerKind(kindOf(tile))) flowers.push(this.proofFor(wallIndex)!)
      }
      this.toResolve.delete(owner)
      this.opts.send({ type: 'TILE_RESOLVE', round: this.opts.round, seat: owner, wallIndices: indices, flowers })
    }
  }

  /** 公開本機持有的某張牌：附上全部層的逐張鎖 */
  proofFor(wallIndex: number): TileRevealProof | null {
    const keys = this.allKeys(wallIndex)
    return keys ? { wallIndex, keys: keys.map(bytesToBase64) } : null
  }

  /** 驗證別人公開的牌：每把金鑰都要對上承諾，且全部一起能開鎖 */
  verifyProof(proof: TileRevealProof): TileId | null {
    if (!this.isReady || !Number.isInteger(proof.wallIndex) || proof.wallIndex < 0 || proof.wallIndex >= 144) return null
    if (!Array.isArray(proof.keys) || proof.keys.length !== this.opts.layers.length) return null
    const keys = proof.keys.map(base64ToBytes)
    if (keys.some((k, layer) => k.length !== 32 || !this.matchesCommit(layer, proof.wallIndex, k))) return null
    const tile = mpUnlock(mpDeckCipher(this.finalDeck, proof.wallIndex), keys)
    if (tile !== null) this.known.set(proof.wallIndex, tile)
    return tile
  }

  onTileResolve(
    msg: { seat: SeatIndex; wallIndices: number[]; flowers: TileRevealProof[] },
    signer: SeatIndex,
  ): void {
    if (signer !== this.recipientOf(msg.seat)) return this.fault(signer, '代替別人宣告牌')
    const flowerAt = new Map<number, TileId>()
    for (const proof of msg.flowers) {
      const tile = this.verifyProof(proof)
      if (tile === null || !isFlowerKind(kindOf(tile)) || !msg.wallIndices.includes(proof.wallIndex)) {
        return this.fault(msg.seat, `位置 ${proof.wallIndex} 的花牌證明無效`)
      }
      flowerAt.set(proof.wallIndex, tile)
    }
    const out = msg.wallIndices
      .filter((i) => !this.resolved.has(i))
      .map((wallIndex) => {
        this.resolved.add(wallIndex)
        return { wallIndex, tile: flowerAt.get(wallIndex) ?? this.known.get(wallIndex) ?? null }
      })
    this.opts.onResolved(out)
  }

  // ---- 結算：公開秘密與稽核 ----

  revealSecret(): void {
    this.opts.send({
      type: 'ROUND_REVEAL',
      round: this.opts.round,
      seat: this.opts.localSeat,
      secret: bytesToBase64(this.secret),
    })
  }

  /** 收齊所有層的秘密時回傳稽核結果，否則回傳 null */
  onRoundReveal(seat: SeatIndex, secretB64: string, signer: SeatIndex): RoundAudit | null {
    if (signer !== seat || !this.opts.layers.includes(seat)) return null
    this.reveals.set(seat, base64ToBytes(secretB64))
    if (this.reveals.size < this.opts.layers.length) return null
    const res = mpAuditRound({
      shuffled: this.shuffled,
      rekeyed: this.rekeyed,
      commits: this.commits,
      secrets: this.opts.layers.map((s) => this.reveals.get(s)!),
    })
    if (res.ok) return { ok: true, wall: res.wall }
    const layerSeat = res.layer !== undefined ? this.opts.layers[res.layer] : null
    const what = res.fault === 'shuffle' ? '洗牌' : res.fault === 'rekey' ? '換鑰' : res.fault === 'commit' ? '承諾' : '紀錄'
    return {
      ok: false,
      fault: { seat: layerSeat, reason: `${what}不符${res.wallIndex !== undefined ? `（位置 ${res.wallIndex}）` : ''}` },
    }
  }
}
