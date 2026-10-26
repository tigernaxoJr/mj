import {
  isFlowerKind,
  kindOf,
  type MeldGroup,
  type SeatIndex,
  type TaiItem,
  type TileId,
  type TileKind,
} from '@/shared/kernel/types'
import initWasm, * as wasm from './pkg/mahjong_core.js'

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

let ready = false
let initPromise: Promise<void> | null = null

/** 載入 Rust/Wasm 規則核心；牌山、雜湊、台數與 Bot 決策都只由它計算（無 TS 備援） */
export async function initMahjongWasm(): Promise<void> {
  if (ready) return
  initPromise ??= initWasm().then(() => {
    ready = true
  })
  return initPromise
}

export function isMahjongWasmReady(): boolean {
  return ready
}

function core(): typeof wasm {
  if (!ready) throw new Error('mahjong-core Wasm 尚未載入，請先 await initMahjongWasm()')
  return wasm
}

export function sha256Hex(input: string): string {
  return core().wasm_sha256_hex(input)
}

export function verifyTileLeaf(
  wallIndex: number,
  tileId: TileId,
  salt: string,
  expectedLeafHash: string,
): boolean {
  return core().wasm_verify_tile_leaf(wallIndex, tileId, salt, expectedLeafHash)
}

export interface CommittedWallBundle {
  tiles: TileId[]
  salts: string[]
  leafHashes: string[]
}

export function createCommittedWall(roundSeed: string, hostSecret: string): CommittedWallBundle {
  return JSON.parse(core().wasm_create_committed_wall_json(roundSeed, hostSecret)) as CommittedWallBundle
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

/** TS 副露 → Rust `hand::Meld`（serde tag = type） */
function toRustMelds(melds: readonly MeldGroup[]): unknown[] {
  return melds.map((m) => {
    if (m.type === 'ankan') return { type: 'ankan', tiles: m.tiles.slice(0, 4) }
    const size = m.type === 'minkan' || m.type === 'kakan' ? 4 : 3
    return {
      type: m.type,
      tiles: m.tiles.slice(0, size),
      called: m.calledTile ?? m.tiles[0],
      from_seat: m.fromSeat ?? 0,
    }
  })
}

/** 台灣 16 張台數（Rust `yaku::evaluate_win`）；`concealed` 不含胡的那張牌 */
export function evaluateTaiwanWin(input: EvaluateWinInput): {
  items: TaiItem[]
  totalTai: number
  totalPoints: number
} {
  const payload = JSON.stringify({
    hand: { concealed: input.concealed, melds: toRustMelds(input.melds), flowers: input.flowers },
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
  const parsed = JSON.parse(core().wasm_evaluate_win_json(payload)) as {
    items?: TaiItem[]
    total_tai?: number
    total_points?: number
  }
  if (!parsed.items) throw new Error(`evaluate_win 無法解析輸入：${payload}`)
  return {
    items: parsed.items,
    totalTai: parsed.total_tai ?? 0,
    totalPoints: parsed.total_points ?? input.basePoints,
  }
}

/**
 * 電腦玩家選擇最佳捨牌（Rust `bot::choose_best_discard`，依向聽數與有效進張）。
 * `allowed` 限定可打的牌（例如宣告聽牌時只能打不破聽的牌）。
 */
export function chooseBotDiscard(
  concealed: readonly TileId[],
  melds: readonly MeldGroup[],
  isMigi: boolean,
  allowed?: readonly TileId[],
): TileId {
  if (concealed.length === 0) return 0
  if (isMigi) return concealed[concealed.length - 1]
  const best = core().wasm_bot_best_discard(
    JSON.stringify({ concealed, melds: toRustMelds(melds), flowers: [] }),
  )
  const pool = allowed && allowed.length > 0 ? allowed : concealed
  return pool.includes(best) ? best : pool[0]
}

export interface MahjongCorePort {
  kindOf(tileId: TileId): TileKind
  isFlower(kind: TileKind): boolean
}

export const mahjongCore: MahjongCorePort = {
  kindOf,
  isFlower: isFlowerKind,
}
