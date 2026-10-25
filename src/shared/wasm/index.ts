import {
  isFlowerKind,
  kindOf,
  type MeldGroup,
  type SeatIndex,
  type TaiItem,
  type TileId,
  type TileKind,
} from '@/shared/kernel/types'

export const TILE_LABELS: readonly string[] = [
  '一萬', '二萬', '三萬', '四萬', '五萬', '六萬', '七萬', '八萬', '九萬',
  '一筒', '二筒', '三筒', '四筒', '五筒', '六筒', '七筒', '八筒', '九筒',
  '一條', '二條', '三條', '四條', '五條', '六條', '七條', '八條', '九條',
  '東', '南', '西', '北',
  '中', '發', '白',
  '春', '夏', '秋', '冬',
  '梅', '蘭', '竹', '菊',
]

export function tileLabel(tileOrKind: number, isPhysicalId = true): string {
  const k = isPhysicalId ? kindOf(tileOrKind) : tileOrKind
  return TILE_LABELS[k] ?? `?${k}`
}

type WasmModule = {
  default?: () => Promise<unknown>
  wasm_sha256_hex?: (input: string) => string
  wasm_verify_tile_leaf?: (wallIndex: number, tileId: number, salt: string, expectedLeafHash: string) => boolean
  wasm_create_committed_wall_json?: (roundSeed: string, hostSecret: string) => string
  wasm_evaluate_win_json?: (winContextJson: string) => string
  wasm_waiting_tiles_json?: (handJson: string) => string
  wasm_bot_turn_decision_json?: (handJson: string, isMigi: boolean) => string
}

let wasmMod: WasmModule | null = null
let initPromise: Promise<void> | null = null

export async function initMahjongWasm(): Promise<void> {
  if (wasmMod) return
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      const pkgPath = './pkg/mahjong_core.js'
      const mod = (await import(/* @vite-ignore */ pkgPath)) as WasmModule
      if (typeof mod.default === 'function') {
        await mod.default()
      }
      wasmMod = mod
    } catch {
      // Fallback to synchronous TS parity implementation when running in Node/Vitest
      wasmMod = null
    }
  })()
  return initPromise
}

// --- FIPS 180-4 SHA-256 (與 crates/mahjong-core/src/wall.rs 完全位元級一致) ---
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

export function sha256Bytes(text: string): Uint8Array {
  const raw = new TextEncoder().encode(text)
  const bitLen = raw.length * 8
  const padLen = (raw.length + 9 + 63) & ~63
  const padded = new Uint8Array(padLen)
  padded.set(raw)
  padded[raw.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(padLen - 4, bitLen >>> 0, false)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, h[i], false)
  }
  return out
}

export function sha256Hex(input: string): string {
  if (wasmMod?.wasm_sha256_hex) {
    return wasmMod.wasm_sha256_hex(input)
  }
  const bytes = sha256Bytes(input)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function computeTileLeafHash(wallIndex: number, tileId: TileId, salt: string): string {
  return sha256Hex(`${wallIndex}|${tileId}|${salt}`)
}

export function verifyTileLeaf(
  wallIndex: number,
  tileId: TileId,
  salt: string,
  expectedLeafHash: string,
): boolean {
  if (wasmMod?.wasm_verify_tile_leaf) {
    return wasmMod.wasm_verify_tile_leaf(wallIndex, tileId, salt, expectedLeafHash)
  }
  return computeTileLeafHash(wallIndex, tileId, salt) === expectedLeafHash
}

export interface CommittedWallBundle {
  tiles: TileId[]
  salts: string[]
  leafHashes: string[]
}

export function createCommittedWall(roundSeed: string, hostSecret: string): CommittedWallBundle {
  if (wasmMod?.wasm_create_committed_wall_json) {
    const raw = wasmMod.wasm_create_committed_wall_json(roundSeed, hostSecret)
    return JSON.parse(raw) as CommittedWallBundle
  }
  const combinedSeed = sha256Hex(`${roundSeed}|${hostSecret}`)
  const digest = sha256Bytes(combinedSeed)
  const view = new DataView(digest.buffer)
  let state = view.getBigUint64(0, false)
  const mask64 = 0xffffffffffffffffn

  const nextU64 = (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & mask64
    let z = state
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask64
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask64
    return (z ^ (z >> 31n)) & mask64
  }

  const tiles = Array.from({ length: 144 }, (_, i) => i)
  for (let i = 143; i >= 1; i--) {
    const j = Number(nextU64() % BigInt(i + 1))
    const tmp = tiles[i]
    tiles[i] = tiles[j]
    tiles[j] = tmp
  }

  const salts: string[] = []
  const leafHashes: string[] = []
  for (let idx = 0; idx < 144; idx++) {
    const salt = sha256Hex(`${combinedSeed}|salt|${idx}`).slice(0, 32)
    salts.push(salt)
    leafHashes.push(computeTileLeafHash(idx, tiles[idx], salt))
  }
  return { tiles, salts, leafHashes }
}

// --- 胡牌、聽牌、向聽數與台數計算同步介面 ---

export function countKinds(concealed: readonly TileId[]): number[] {
  const counts = new Array<number>(34).fill(0)
  for (const id of concealed) {
    const k = kindOf(id)
    if (k < 34) counts[k]++
  }
  return counts
}

function canExtractSets(counts: number[], remaining: number): boolean {
  if (remaining === 0) return true
  let first = -1
  for (let i = 0; i < 34; i++) {
    if (counts[i] > 0) {
      first = i
      break
    }
  }
  if (first < 0) return false
  if (counts[first] >= 3) {
    counts[first] -= 3
    if (canExtractSets(counts, remaining - 1)) {
      counts[first] += 3
      return true
    }
    counts[first] += 3
  }
  if (first < 27 && first % 9 <= 6 && counts[first + 1] > 0 && counts[first + 2] > 0) {
    counts[first]--
    counts[first + 1]--
    counts[first + 2]--
    if (canExtractSets(counts, remaining - 1)) {
      counts[first]++
      counts[first + 1]++
      counts[first + 2]++
      return true
    }
    counts[first]++
    counts[first + 1]++
    counts[first + 2]++
  }
  return false
}

export function canFormStandardWin(counts: readonly number[], requiredSets: number): boolean {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total !== requiredSets * 3 + 2) return false
  const work = [...counts]
  for (let i = 0; i < 34; i++) {
    if (work[i] >= 2) {
      work[i] -= 2
      if (canExtractSets(work, requiredSets)) return true
      work[i] += 2
    }
  }
  return false
}

export function isLikulikuCounts(counts: readonly number[], meldsLen: number): boolean {
  if (meldsLen !== 0) return false
  const total = counts.reduce((a, b) => a + b, 0)
  if (total !== 17) return false
  for (let k = 0; k < 34; k++) {
    if (counts[k] >= 3) {
      let ok = true
      for (let j = 0; j < 34; j++) {
        const c = j === k ? counts[j] - 3 : counts[j]
        if (c % 2 !== 0) {
          ok = false
          break
        }
      }
      if (ok) return true
    }
  }
  return false
}

export function canWinWithHand(
  concealed: readonly TileId[],
  meldsLen: number,
  extraTile?: TileId,
): boolean {
  if (meldsLen > 5) return false
  const counts = countKinds(concealed)
  if (extraTile !== undefined) {
    const k = kindOf(extraTile)
    if (k < 34) counts[k]++
  }
  const requiredSets = 5 - meldsLen
  return canFormStandardWin(counts, requiredSets) || isLikulikuCounts(counts, meldsLen)
}

export function getWaitingKinds(concealed: readonly TileId[], meldsLen: number): TileKind[] {
  const requiredSets = 5 - meldsLen
  if (concealed.length !== requiredSets * 3 + 1) return []
  const counts = countKinds(concealed)
  const waits: TileKind[] = []
  for (let k = 0; k < 34; k++) {
    if (counts[k] < 4) {
      counts[k]++
      if (canFormStandardWin(counts, requiredSets) || isLikulikuCounts(counts, meldsLen)) {
        waits.push(k)
      }
      counts[k]--
    }
  }
  return waits
}

export function findChiiOptions(
  concealed: readonly TileId[],
  discardTile: TileId,
  isNextSeat: boolean,
): [TileId, TileId][] {
  if (!isNextSeat) return []
  const k = kindOf(discardTile)
  if (k >= 27) return []
  const rankIdx = k % 9
  const deltas: [number, number][] = [
    [-2, -1],
    [-1, 1],
    [1, 2],
  ]
  const res: [TileId, TileId][] = []
  for (const [d1, d2] of deltas) {
    const r1 = rankIdx + d1
    const r2 = rankIdx + d2
    if (r1 >= 0 && r1 <= 8 && r2 >= 0 && r2 <= 8) {
      const t1 = concealed.find((id) => kindOf(id) === k + d1)
      const t2 = concealed.find((id) => kindOf(id) === k + d2)
      if (t1 !== undefined && t2 !== undefined) {
        res.push([t1, t2])
      }
    }
  }
  return res
}

export function findPonTiles(concealed: readonly TileId[], discardTile: TileId): [TileId, TileId] | null {
  const k = kindOf(discardTile)
  if (k >= 34) return null
  const matches = concealed.filter((id) => kindOf(id) === k)
  return matches.length >= 2 ? [matches[0], matches[1]] : null
}

export function findMinkanTiles(
  concealed: readonly TileId[],
  discardTile: TileId,
): [TileId, TileId, TileId] | null {
  const k = kindOf(discardTile)
  if (k >= 34) return null
  const matches = concealed.filter((id) => kindOf(id) === k)
  return matches.length >= 3 ? [matches[0], matches[1], matches[2]] : null
}

export function findAnkanKinds(concealed: readonly TileId[]): { kind: TileKind; tiles: [TileId, TileId, TileId, TileId] }[] {
  const counts = countKinds(concealed)
  const out: { kind: TileKind; tiles: [TileId, TileId, TileId, TileId] }[] = []
  for (let k = 0; k < 34; k++) {
    if (counts[k] === 4) {
      const m = concealed.filter((id) => kindOf(id) === k)
      if (m.length === 4) {
        out.push({ kind: k, tiles: [m[0], m[1], m[2], m[3]] })
      }
    }
  }
  return out
}

export function findKakanOptions(
  concealed: readonly TileId[],
  melds: readonly MeldGroup[],
): { meldIndex: number; kind: TileKind; tileId: TileId }[] {
  const out: { meldIndex: number; kind: TileKind; tileId: TileId }[] = []
  melds.forEach((m, meldIndex) => {
    if (m.type === 'pon' && m.tiles.length >= 3) {
      const k = kindOf(m.tiles[0])
      const t = concealed.find((id) => kindOf(id) === k)
      if (t !== undefined) {
        out.push({ meldIndex, kind: k, tileId: t })
      }
    }
  })
  return out
}

export interface EvaluateWinInput {
  concealed: TileId[]
  melds: MeldGroup[]
  flowers: TileId[]
  winningTile: TileId
  isTsumo: boolean
  roundWind: SeatIndex
  seatWind: SeatIndex
  involvesDealer: boolean
  dealerStreak: number
  isMigi: boolean
  isTenhouMigi: boolean
  isTenhou: boolean
  isChiihou: boolean
  isRenhou: boolean
  isLastTile: boolean
  isRinshan: boolean
  isChankan: boolean
  isSevenRobOne: boolean
  basePoints: number
  taiPoints: number
}

export function evaluateTaiwanWin(input: EvaluateWinInput): {
  items: TaiItem[]
  totalTai: number
  totalPoints: number
} {
  if (wasmMod?.wasm_evaluate_win_json) {
    const rustMelds = input.melds.map((m) => {
      if (m.type === 'ankan') {
        return { type: 'ankan', tiles: m.tiles.slice(0, 4) }
      }
      if (m.type === 'minkan' || m.type === 'kakan') {
        return {
          type: m.type,
          tiles: m.tiles.slice(0, 4),
          called: m.calledTile ?? m.tiles[0],
          from_seat: m.fromSeat ?? 0,
        }
      }
      return {
        type: m.type,
        tiles: m.tiles.slice(0, 3),
        called: m.calledTile ?? m.tiles[0],
        from_seat: m.fromSeat ?? 0,
      }
    })
    const payload = JSON.stringify({
      hand: {
        concealed: input.concealed,
        melds: rustMelds,
        flowers: input.flowers,
      },
      winning_tile: input.winningTile,
      is_tsumo: input.isTsumo,
      round_wind: input.roundWind,
      seat_wind: input.seatWind,
      involves_dealer: input.involvesDealer,
      dealer_streak: input.dealerStreak,
      is_migi: input.isMigi,
      is_tenhou_migi: input.isTenhouMigi,
      is_tenhou: input.isTenhou,
      is_chiihou: input.isChiihou,
      is_renhou: input.isRenhou,
      is_last_tile: input.isLastTile,
      is_rinshan: input.isRinshan,
      is_chankan: input.isChankan,
      is_seven_rob_one: input.isSevenRobOne,
      base_points: input.basePoints,
      tai_points: input.taiPoints,
    })
    const raw = wasmMod.wasm_evaluate_win_json(payload)
    const parsed = JSON.parse(raw) as {
      items?: TaiItem[]
      total_tai?: number
      total_points?: number
    }
    if (parsed.items) {
      return {
        items: parsed.items,
        totalTai: parsed.total_tai ?? 0,
        totalPoints: parsed.total_points ?? input.basePoints,
      }
    }
  }

  // 同步 TS 台數計算（確保 Node 測試與尚未載入 Wasm 時 100% 可用）
  const items: TaiItem[] = []
  if (input.involvesDealer) {
    items.push({ name: '莊家', tai: 1 })
    if (input.dealerStreak > 0) {
      items.push({ name: `連${input.dealerStreak}拉${input.dealerStreak}`, tai: input.dealerStreak * 2 })
    }
  }

  if (input.flowers.length === 8) {
    items.push({ name: '八仙過海', tai: 8 })
    const totalTai = items.reduce((s, i) => s + i.tai, 0)
    return { items, totalTai, totalPoints: input.basePoints + totalTai * input.taiPoints }
  }
  if (input.isSevenRobOne) {
    items.push({ name: '七搶一', tai: 8 })
    const totalTai = items.reduce((s, i) => s + i.tai, 0)
    return { items, totalTai, totalPoints: input.basePoints + totalTai * input.taiPoints }
  }

  const isMenzen = input.melds.every((m) => m.type === 'ankan')
  if (input.isTenhou) items.push({ name: '天胡', tai: 16 })
  else if (input.isChiihou) items.push({ name: '地胡', tai: 16 })
  else if (input.isRenhou) items.push({ name: '人胡', tai: 8 })

  if (input.isTenhouMigi) items.push({ name: '天聽', tai: 8 })
  else if (input.isMigi) items.push({ name: '聽牌（MIGI）', tai: 2 })

  if (isMenzen && input.isTsumo) {
    items.push({ name: '門清一摸三', tai: 3 })
  } else {
    if (isMenzen) items.push({ name: '門清', tai: 1 })
    if (input.isTsumo) items.push({ name: '自摸', tai: 1 })
  }

  if (input.isRinshan && input.isTsumo) items.push({ name: '槓上開花', tai: 1 })
  if (input.isChankan && !input.isTsumo) items.push({ name: '搶槓', tai: 1 })
  if (input.isLastTile) items.push({ name: input.isTsumo ? '海底撈月' : '河底撈魚', tai: 1 })

  // 花牌：四季 (34..37) 與四君子 (38..41)
  const seasons = [false, false, false, false]
  const plants = [false, false, false, false]
  for (const f of input.flowers) {
    const k = kindOf(f)
    if (k >= 34 && k <= 37) seasons[k - 34] = true
    if (k >= 38 && k <= 41) plants[k - 38] = true
  }
  if (seasons.every(Boolean)) items.push({ name: '花槓（四季）', tai: 2 })
  else if (seasons[input.seatWind]) items.push({ name: `正花（${input.seatWind + 1}花）`, tai: 1 })

  if (plants.every(Boolean)) items.push({ name: '花槓（四君子）', tai: 2 })
  else if (plants[input.seatWind]) items.push({ name: `正花（${input.seatWind + 1}花）`, tai: 1 })

  const allConcealed = [...input.concealed, input.winningTile]
  const counts = countKinds(allConcealed)
  if (isLikulikuCounts(counts, input.melds.length)) {
    items.push({ name: '嚦咕嚦咕', tai: 8 })
  }

  // 檢查字牌刻子（圈風、門風、三元）
  const allTiles = [...allConcealed, ...input.melds.flatMap((m) => m.tiles)]
  const totalCounts = countKinds(allTiles)
  const roundWindKind = 27 + input.roundWind
  const seatWindKind = 27 + input.seatWind
  if (totalCounts[roundWindKind] >= 3) items.push({ name: '圈風刻', tai: 1 })
  if (totalCounts[seatWindKind] >= 3) items.push({ name: '門風刻', tai: 1 })
  if (totalCounts[31] >= 3) items.push({ name: '紅中', tai: 1 })
  if (totalCounts[32] >= 3) items.push({ name: '青發', tai: 1 })
  if (totalCounts[33] >= 3) items.push({ name: '白板', tai: 1 })

  // 清一色 / 混一色 / 字一色
  const suits = [false, false, false]
  let hasHonor = false
  for (let k = 0; k < 34; k++) {
    if (totalCounts[k] > 0) {
      if (k < 9) suits[0] = true
      else if (k < 18) suits[1] = true
      else if (k < 27) suits[2] = true
      else hasHonor = true
    }
  }
  const suitCount = suits.filter(Boolean).length
  if (suitCount === 0 && hasHonor) items.push({ name: '字一色', tai: 16 })
  else if (suitCount === 1 && !hasHonor) items.push({ name: '清一色', tai: 8 })
  else if (suitCount === 1 && hasHonor) items.push({ name: '混一色', tai: 4 })

  const totalTai = items.reduce((s, i) => s + i.tai, 0)
  return {
    items,
    totalTai,
    totalPoints: input.basePoints + totalTai * input.taiPoints,
  }
}

/** 電腦玩家選擇最佳捨牌 */
export function chooseBotDiscard(concealed: readonly TileId[], isMigi: boolean): TileId {
  if (concealed.length === 0) return 0
  if (isMigi) return concealed[concealed.length - 1]
  if (wasmMod?.wasm_bot_turn_decision_json) {
    const raw = wasmMod.wasm_bot_turn_decision_json(
      JSON.stringify({ concealed, melds: [], flowers: [] }),
      isMigi,
    )
    try {
      const parsed = JSON.parse(raw) as { type?: string; tile_id?: number }
      if (typeof parsed.tile_id === 'number' && concealed.includes(parsed.tile_id)) {
        return parsed.tile_id
      }
    } catch {
      // Fallback below
    }
  }

  // 啟發式：優先丟出單張字牌 -> 孤立么九邊張 -> 孤立中張
  const counts = countKinds(concealed)
  let bestTile = concealed[0]
  let bestPriority = -9999

  for (const tileId of concealed) {
    const k = kindOf(tileId)
    if (k >= 34) return tileId
    const c = counts[k]
    let priority = 0
    if (k >= 27) {
      priority = c === 1 ? 100 : c === 2 ? -40 : -100
    } else {
      const rank = (k % 9) + 1
      const centerDist = Math.abs(rank - 5)
      let support = 0
      if (rank > 1 && counts[k - 1] > 0) support += 25
      if (rank < 9 && counts[k + 1] > 0) support += 25
      if (rank > 2 && counts[k - 2] > 0) support += 10
      if (rank < 8 && counts[k + 2] > 0) support += 10
      const pairKeep = c >= 2 ? 45 : 0
      priority = centerDist * 8 - support - pairKeep
    }
    if (priority > bestPriority) {
      bestPriority = priority
      bestTile = tileId
    }
  }
  return bestTile
}

export interface MahjongCorePort {
  kindOf(tileId: TileId): TileKind
  isFlower(kind: TileKind): boolean
}

export const mahjongCore: MahjongCorePort = {
  kindOf,
  isFlower: isFlowerKind,
}
