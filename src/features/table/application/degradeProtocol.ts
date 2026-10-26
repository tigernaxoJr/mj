/**
 * WP-5.6: 斷線降級（設計見 docs/04-host-anticheat-mental-poker.md §4.8）
 *
 * 有真人中途離開時，他那層鎖打不開，未摸的牌山與他的手牌都無法解密。為了讓休閒玩家打完這一局：
 *   1. 留下的真人把自己的暗牌證明「加密給房主」（DEGRADE_HAND，其他人看不到）。
 *   2. 房主算出未知牌池 = 144 − 公開的牌 − 已知的手牌，以 Co-Seeded Commit-Reveal 重洗：
 *      房主先承諾秘密（DEGRADE_COMMIT），再收客機種子（DEGRADE_SEED），
 *      依 createCommittedWall(種子, 秘密) 的排列決定牌池順序，公開每個位置的承諾索引（DEGRADE_WALL）。
 *   3. 之後由房主發牌（DEGRADE_DEAL 加密給持有者），公開的牌以承諾葉節點證明，各家即時驗證。
 *   4. 結算時房主公開秘密（DEGRADE_REVEAL），各家驗證承諾、自己的種子、葉節點與牌池排序規則。
 *
 * 從此刻起房主知道所有人的牌（回到房主可信的模型），結算標示「本局曾降級，未完整驗證」。
 */
import type { SeatIndex, TileId, TileRevealProof } from '@/shared/kernel/types'
import { isFlowerKind, kindOf, type RoomMemberKeys } from '@/shared/kernel/types'
import {
  base64ToBytes,
  bytesToBase64,
  createCommittedWall,
  mpOpenBytes,
  mpSealBytes,
  sha256Hex,
  verifyTileLeaf,
  type MpIdentitySeeds,
} from '@/shared/wasm'
import { hiddenTileAt } from '../domain/tableState'
import type { DeckFault, SecureDeck, WallDealer } from './deckProtocol'
import type { InnerMessage } from './secureChannel'

const HOST_SEAT: SeatIndex = 0
/** crypto_box 情境的位置欄位：與金鑰分享（0..143）不重疊 */
const HAND_CTX = 0xfff0
const DEAL_CTX = 0x8000
/** 代打座位的新手牌放在虛擬位置 144 起 */
export const VIRTUAL_BASE = 144

const enc = new TextEncoder()
const dec = new TextDecoder()

function randomHex(bytes = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
}

interface DealtTile {
  tile: TileId
  salt: string
}

/** 降級後的發牌者：重發的位置由房主承諾，其餘（降級前已摸的牌）仍以 Mental Poker 金鑰證明 */
export class HostDeck implements WallDealer {
  readonly known: Map<number, TileId>
  private salts = new Map<number, string>()
  private resolved = new Set<number>()
  private dealt = new Set<number>()
  private toResolve = new Map<SeatIndex, Set<number>>()

  constructor(
    private readonly opts: {
      round: number
      localSeat: SeatIndex
      isHost: boolean
      /** 仍在場的真人 */
      humans: readonly SeatIndex[]
      members: readonly RoomMemberKeys[]
      seeds: MpIdentitySeeds
      inner: SecureDeck
      /** 位置 → 承諾索引 */
      slots: Map<number, number>
      leafHashes: string[]
      /** 房主：每個位置的牌與鹽 */
      tiles?: Map<number, DealtTile>
      send: (msg: InnerMessage) => void
      onResolved: (resolved: { wallIndex: number; tile: TileId | null }[]) => void
      onFault: (fault: DeckFault) => void
    },
  ) {
    this.known = new Map(opts.inner.known)
    // 重發的位置以房主新發的牌為準（降級前可能已私下知道舊牌）
    for (const pos of opts.slots.keys()) this.known.delete(pos)
    for (const [pos, t] of opts.tiles ?? []) {
      this.known.set(pos, t.tile)
      this.salts.set(pos, t.salt)
    }
  }

  private recipientOf(owner: SeatIndex): SeatIndex {
    return this.opts.humans.includes(owner) ? owner : HOST_SEAT
  }

  private boxPubOf(seat: SeatIndex): Uint8Array {
    return base64ToBytes(this.opts.members.find((m) => m.seat === seat)!.boxPub)
  }

  request(positions: readonly { wallIndex: number; seat: SeatIndex }[]): void {
    const { localSeat, isHost, round, seeds } = this.opts
    const outgoing = new Map<SeatIndex, number[]>()
    for (const { wallIndex, seat } of positions) {
      if (this.resolved.has(wallIndex) || !this.opts.slots.has(wallIndex)) continue
      const to = this.recipientOf(seat)
      if (to === localSeat) {
        if (!this.toResolve.has(seat)) this.toResolve.set(seat, new Set())
        this.toResolve.get(seat)!.add(wallIndex)
      } else if (isHost && !this.dealt.has(wallIndex)) {
        this.dealt.add(wallIndex)
        outgoing.set(to, [...(outgoing.get(to) ?? []), wallIndex])
      }
    }
    for (const [to, wallIndices] of outgoing) {
      const body = wallIndices.map((i) => ({ tile: this.known.get(i)!, salt: this.salts.get(i)! }))
      const ctx = { round, wallIndex: DEAL_CTX | wallIndices[0], fromSeat: localSeat, toSeat: to }
      const sealed = mpSealBytes(seeds, this.boxPubOf(to), ctx, enc.encode(JSON.stringify(body)))
      this.opts.send({ type: 'DEGRADE_DEAL', round, to, wallIndices, sealed: bytesToBase64(sealed) })
    }
    this.flushResolves()
  }

  /** 客機：收到房主私下發的牌，逐張以承諾葉節點驗證 */
  onDeal(msg: { to: SeatIndex; wallIndices: number[]; sealed: string }, signer: SeatIndex): void {
    const { localSeat, round, seeds } = this.opts
    if (msg.to !== localSeat) return
    if (signer !== HOST_SEAT) return this.opts.onFault({ seat: signer, reason: '非房主發牌' })
    const ctx = { round, wallIndex: DEAL_CTX | msg.wallIndices[0], fromSeat: HOST_SEAT, toSeat: localSeat }
    const plain = mpOpenBytes(seeds, this.boxPubOf(HOST_SEAT), ctx, base64ToBytes(msg.sealed))
    let body: DealtTile[] = []
    try {
      body = plain ? (JSON.parse(dec.decode(plain)) as DealtTile[]) : []
    } catch {
      body = []
    }
    for (let k = 0; k < msg.wallIndices.length; k++) {
      const wallIndex = msg.wallIndices[k]
      const t = body[k]
      if (!t || this.verifyProof({ wallIndex, keys: [], tile: t.tile, salt: t.salt }) === null) {
        return this.opts.onFault({ seat: HOST_SEAT, reason: `重發的牌與承諾不符（位置 ${wallIndex}）` })
      }
      this.salts.set(wallIndex, t.salt)
    }
    this.flushResolves()
  }

  private flushResolves(): void {
    for (const [owner, set] of this.toResolve) {
      const indices = [...set]
      if (indices.some((i) => !this.known.has(i))) continue
      this.toResolve.delete(owner)
      const flowers = indices
        .filter((i) => isFlowerKind(kindOf(this.known.get(i)!)))
        .map((i) => this.proofFor(i)!)
      this.opts.send({ type: 'TILE_RESOLVE', round: this.opts.round, seat: owner, wallIndices: indices, flowers })
    }
  }

  proofFor(wallIndex: number): TileRevealProof | null {
    if (!this.opts.slots.has(wallIndex)) return this.opts.inner.proofFor(wallIndex)
    const tile = this.known.get(wallIndex)
    const salt = this.salts.get(wallIndex)
    return tile === undefined || salt === undefined ? null : { wallIndex, keys: [], tile, salt }
  }

  verifyProof(proof: TileRevealProof): TileId | null {
    const slot = this.opts.slots.get(proof.wallIndex)
    if (slot === undefined) return this.opts.inner.verifyProof(proof)
    if (typeof proof.tile !== 'number' || typeof proof.salt !== 'string') return null
    if (!verifyTileLeaf(slot, proof.tile, proof.salt, this.opts.leafHashes[slot] ?? '')) return null
    this.known.set(proof.wallIndex, proof.tile)
    return proof.tile
  }

  onTileResolve(msg: { seat: SeatIndex; wallIndices: number[]; flowers: TileRevealProof[] }, signer: SeatIndex): void {
    if (signer !== this.recipientOf(msg.seat)) return this.opts.onFault({ seat: signer, reason: '代替別人宣告牌' })
    const flowerAt = new Map<number, TileId>()
    for (const proof of msg.flowers) {
      const tile = this.verifyProof(proof)
      if (tile === null || !isFlowerKind(kindOf(tile)) || !msg.wallIndices.includes(proof.wallIndex)) {
        return this.opts.onFault({ seat: msg.seat, reason: `位置 ${proof.wallIndex} 的花牌證明無效` })
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
}

export interface DegradeWall {
  roundSeed: string
  leafHashes: string[]
  /** 位置 → 承諾索引；虛擬位置 VIRTUAL_BASE + k 為代打座位的第 k 張新手牌 */
  slots: Map<number, number>
  /** 房主：每個位置的牌與鹽 */
  tiles?: Map<number, DealtTile>
}

/**
 * 依重洗結果分配牌池：牌池依承諾排列的順序排好，代打座位拿前 n 張「非花牌」（新手牌不能有花），
 * 其餘依序放回未摸的牌山位置。各家在結算時用公開的秘密重算，確認房主沒有挑牌。
 */
export function layoutDegradedWall(
  pool: readonly TileId[],
  handCount: number,
  wallPositions: readonly number[],
  roundSeed: string,
  secret: string,
): DegradeWall {
  const committed = createCommittedWall(roundSeed, secret)
  const slotOfTile = new Map(committed.tiles.map((t, i) => [t, i]))
  const ordered = [...pool].sort((a, b) => slotOfTile.get(a)! - slotOfTile.get(b)!)
  const hand: TileId[] = []
  const rest: TileId[] = []
  for (const t of ordered) {
    if (hand.length < handCount && !isFlowerKind(kindOf(t))) hand.push(t)
    else rest.push(t)
  }
  const slots = new Map<number, number>()
  const tiles = new Map<number, DealtTile>()
  const place = (pos: number, t: TileId) => {
    const slot = slotOfTile.get(t)!
    slots.set(pos, slot)
    tiles.set(pos, { tile: t, salt: committed.salts[slot] })
  }
  hand.forEach((t, k) => place(VIRTUAL_BASE + k, t))
  wallPositions.forEach((pos, k) => place(pos, rest[k]))
  return { roundSeed, leafHashes: committed.leafHashes, slots, tiles }
}

/** 結算時檢查房主沒有挑牌：承諾、自己的種子、葉節點、牌池排序規則 */
export function verifyDegradedWall(
  wall: DegradeWall,
  commit: string,
  secret: string,
  mySeedEntry: string | null,
): string | null {
  if (sha256Hex(secret) !== commit) return '房主公開的秘密與承諾不符'
  if (mySeedEntry && !wall.roundSeed.split('|').includes(mySeedEntry)) return '房主沒有採用你的種子'
  const committed = createCommittedWall(wall.roundSeed, secret)
  if (committed.leafHashes.some((h, i) => h !== wall.leafHashes[i])) return '重洗的承諾與秘密不符'
  const entries = [...wall.slots.entries()]
  const handSlots = entries.filter(([pos]) => pos >= VIRTUAL_BASE).sort(([a], [b]) => a - b).map(([, s]) => s)
  const wallSlots = entries.filter(([pos]) => pos < VIRTUAL_BASE).sort(([a], [b]) => a - b).map(([, s]) => s)
  const ordered = [...handSlots, ...wallSlots].sort((a, b) => a - b)
  const hand: number[] = []
  const rest: number[] = []
  for (const s of ordered) {
    if (hand.length < handSlots.length && !isFlowerKind(kindOf(committed.tiles[s]))) hand.push(s)
    else rest.push(s)
  }
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])
  return same(hand, handSlots) && same(rest, wallSlots) ? null : '房主沒有依重洗順序發牌'
}

/** 降級交接的雙方狀態機（每局至多一次） */
export class DegradeSession {
  private hands = new Map<SeatIndex, TileId[]>()
  private seeds = new Map<SeatIndex, string>()
  private secret = ''
  private commit = ''
  private mySeed = ''
  wall: DegradeWall | null = null

  constructor(
    private readonly opts: {
      round: number
      localSeat: SeatIndex
      isHost: boolean
      leaver: SeatIndex
      /** 留下的真人（含房主） */
      humans: readonly SeatIndex[]
      members: readonly RoomMemberKeys[]
      seeds: MpIdentitySeeds
      inner: SecureDeck
      /** 本機手牌對應的牌山位置與牌（客機交出暗牌用） */
      myHand: () => { wallIndex: number; tile: TileId }[]
      /** 房主：各座位目前的暗牌（佔位以負值表示）與公開的牌 */
      hostView: () => { concealed: TileId[][]; publicTiles: TileId[]; head: number; tail: number }
      send: (msg: InnerMessage) => void
      onWall: (wall: DegradeWall) => void
      onFault: (fault: DeckFault) => void
    },
  ) {}

  private get guests(): SeatIndex[] {
    return this.opts.humans.filter((s) => s !== HOST_SEAT)
  }

  /** 還在等誰（逾時判定用） */
  waitingFor(): SeatIndex[] {
    if (this.wall) return []
    if (!this.commit) return this.guests.filter((s) => !this.hands.has(s))
    return this.guests.filter((s) => !this.seeds.has(s))
  }

  start(): void {
    const { isHost, localSeat, round, seeds } = this.opts
    if (isHost) return this.maybeCommit()
    if (!this.opts.humans.includes(localSeat)) return
    const proofs = this.opts.myHand().map(({ wallIndex }) => this.opts.inner.proofFor(wallIndex))
    if (proofs.some((p) => !p)) return this.opts.onFault({ seat: localSeat, reason: '無法證明自己的手牌' })
    const ctx = { round, wallIndex: HAND_CTX, fromSeat: localSeat, toSeat: HOST_SEAT }
    const hostBox = base64ToBytes(this.opts.members.find((m) => m.seat === HOST_SEAT)!.boxPub)
    const sealed = mpSealBytes(seeds, hostBox, ctx, enc.encode(JSON.stringify(proofs)))
    this.opts.send({ type: 'DEGRADE_HAND', round, seat: localSeat, sealed: bytesToBase64(sealed) })
  }

  /** 房主：驗證客機交出的暗牌，必須剛好是他手上那幾個位置 */
  onHand(msg: { seat: SeatIndex; sealed: string }, signer: SeatIndex): void {
    const { isHost, round, seeds } = this.opts
    if (!isHost || this.commit || signer !== msg.seat || !this.guests.includes(msg.seat)) return
    const ctx = { round, wallIndex: HAND_CTX, fromSeat: msg.seat, toSeat: HOST_SEAT }
    const senderBox = base64ToBytes(this.opts.members.find((m) => m.seat === msg.seat)!.boxPub)
    const plain = mpOpenBytes(seeds, senderBox, ctx, base64ToBytes(msg.sealed))
    let proofs: TileRevealProof[] = []
    try {
      proofs = plain ? (JSON.parse(dec.decode(plain)) as TileRevealProof[]) : []
    } catch {
      proofs = []
    }
    // 手上每一張都要有證明：本機看到的佔位，或已公開但還沒打出的牌（例如打牌的那一步還在等摸牌）
    const remaining = [...this.opts.hostView().concealed[msg.seat]]
    const tiles: TileId[] = []
    for (const p of proofs) {
      const tile = this.opts.inner.verifyProof(p)
      const at = tile === null ? -1 : remaining.findIndex((t) => t === tile || t === hiddenTileAt(p.wallIndex))
      if (at < 0) return this.opts.onFault({ seat: msg.seat, reason: '交出的暗牌證明無效' })
      remaining.splice(at, 1)
      tiles.push(tile!)
    }
    if (remaining.length > 0) return this.opts.onFault({ seat: msg.seat, reason: '交出的暗牌不完整' })
    this.hands.set(msg.seat, tiles)
    this.maybeCommit()
  }

  private maybeCommit(): void {
    if (this.commit || this.guests.some((s) => !this.hands.has(s))) return
    this.secret = `degrade-${randomHex()}`
    this.commit = sha256Hex(this.secret)
    this.opts.send({ type: 'DEGRADE_COMMIT', round: this.opts.round, commit: this.commit })
    this.maybeLayout()
  }

  onCommit(commit: string, signer: SeatIndex): void {
    if (signer !== HOST_SEAT) return
    this.commit = commit
    if (this.opts.isHost || !this.opts.humans.includes(this.opts.localSeat)) return
    this.mySeed = randomHex()
    this.opts.send({ type: 'DEGRADE_SEED', round: this.opts.round, seat: this.opts.localSeat, seed: this.mySeed })
  }

  onSeed(seat: SeatIndex, seed: string, signer: SeatIndex): void {
    if (!this.opts.isHost || signer !== seat || !this.guests.includes(seat) || typeof seed !== 'string') return
    this.seeds.set(seat, seed.slice(0, 64))
    this.maybeLayout()
  }

  /** 房主：算出未知牌池並依重洗順序重發 */
  private maybeLayout(): void {
    if (!this.opts.isHost || !this.commit || this.wall || this.guests.some((s) => !this.seeds.has(s))) return
    const view = this.opts.hostView()
    const known = new Set<TileId>(view.publicTiles)
    view.concealed.forEach((hand, seat) => {
      if (seat === this.opts.leaver) return
      for (const t of this.hands.get(seat as SeatIndex) ?? hand) if (t >= 0) known.add(t)
    })
    const pool = Array.from({ length: 144 }, (_, t) => t).filter((t) => !known.has(t))
    const handCount = view.concealed[this.opts.leaver].length
    const positions = Array.from({ length: view.tail - view.head }, (_, k) => view.head + k)
    if (pool.length !== handCount + positions.length) {
      return this.opts.onFault({ seat: HOST_SEAT, reason: '未知牌池張數不符' })
    }
    const roundSeed = [...this.seeds.entries()]
      .sort(([a], [b]) => a - b)
      .map(([seat, seed]) => `${seat}:${seed}`)
      .join('|')
    const wall = layoutDegradedWall(pool, handCount, positions, roundSeed, this.secret)
    this.opts.send({
      type: 'DEGRADE_WALL',
      round: this.opts.round,
      roundSeed,
      leafHashes: wall.leafHashes,
      slots: [...wall.slots.entries()],
    })
    this.wall = wall
    this.opts.onWall(wall)
  }

  onWall(msg: { roundSeed: string; leafHashes: string[]; slots: [number, number][] }, signer: SeatIndex): void {
    if (signer !== HOST_SEAT || this.opts.isHost || this.wall) return
    this.wall = { roundSeed: msg.roundSeed, leafHashes: msg.leafHashes, slots: new Map(msg.slots) }
    this.opts.onWall(this.wall)
  }

  revealSecret(): void {
    if (this.opts.isHost && this.secret) {
      this.opts.send({ type: 'DEGRADE_REVEAL', round: this.opts.round, secret: this.secret })
    }
  }

  /** 結算：驗證房主的重洗；回傳錯誤訊息或 null */
  verifyReveal(secret: string): string | null {
    if (!this.wall) return '沒有重洗紀錄'
    const mine = this.mySeed ? `${this.opts.localSeat}:${this.mySeed}` : null
    return verifyDegradedWall(this.wall, this.commit, secret, mine)
  }
}

/** 代打座位的新手牌：本機看得到的（房主）用真牌，其餘以虛擬位置佔位 */
export function degradedHand(wall: DegradeWall, handCount: number): TileId[] {
  return Array.from({ length: handCount }, (_, k) => wall.tiles?.get(VIRTUAL_BASE + k)?.tile ?? hiddenTileAt(VIRTUAL_BASE + k))
}
