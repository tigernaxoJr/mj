/**
 * 全域核心型別與跨切片契約 (Shared Kernel Types)
 * 嚴格對齊 docs/02-architecture-and-rules.md 規格
 */

export type PlayerId = 'p1' | 'p2' | 'p3' | 'p4' | 'bot-0' | 'bot-1' | 'bot-2' | 'bot-3'

/** 東=0, 南=1, 西=2, 北=3 */
export type SeatIndex = 0 | 1 | 2 | 3

export type WindName = 'east' | 'south' | 'west' | 'north'

export type SeatOccupantType = 'human' | 'bot' | 'empty'

export interface RoomSeatSlot {
  seat: SeatIndex
  wind: WindName
  occupant: SeatOccupantType
  playerId: PlayerId | null
  name: string
  ready: boolean
}

/** 實體牌 ID: 0..143 (共 144 張) */
export type TileId = number

/** 牌面種類 ID: 0..41 (共 42 種) */
export type TileKind = number

export interface RuleConfig {
  /** 底分 (預設 300) */
  basePoints: number
  /** 每台分數 (預設 100) */
  taiPoints: number
  /** 是否允許一炮多響 (預設 false = 逆時針攔胡) */
  allowMultiRon: boolean
  /** 出牌思考秒數 (預設 12 秒) */
  turnTimeoutSec: number
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  basePoints: 300,
  taiPoints: 100,
  allowMultiRon: false,
  turnTimeoutSec: 12,
}

export type MeldType = 'chii' | 'pon' | 'minkan' | 'ankan' | 'kakan'

export interface MeldGroup {
  type: MeldType
  tiles: TileId[]
  fromSeat?: SeatIndex
  calledTile?: TileId
}

export type TurnPhase =
  | 'IDLE'
  | 'DEALING'
  | 'FLOWER_REPLACEMENT'
  | 'TURN_DRAW'
  | 'TURN_ACTION_OR_DISCARD'
  | 'CLAIM_WINDOW'
  | 'ROUND_SETTLEMENT'

export type PlayerActionCommand =
  | { type: 'DISCARD'; tileId: TileId }
  | { type: 'TSUMO' }
  | { type: 'ANKAN'; kind: TileKind }
  | { type: 'KAKAN'; kind: TileKind }
  | { type: 'DECLARE_MIGI'; discardTileId: TileId }
  | { type: 'CLAIM_CHII'; meldTiles: [TileId, TileId] }
  | { type: 'CLAIM_PON' }
  | { type: 'CLAIM_MINKAN' }
  | { type: 'CLAIM_RON' }
  | { type: 'CLAIM_PASS' }

export interface TaiItem {
  name: string
  tai: number
}

export interface SettlementSummary {
  winnerSeats: SeatIndex[]
  loserSeat: SeatIndex | null
  isTsumo: boolean
  isExhaustiveDraw: boolean
  winningTile: TileId | null
  taiItems: TaiItem[]
  totalTai: number
  scoreDeltas: [number, number, number, number]
}

/** P2P 連線協議訊息 (Co-Seeded Commit-Reveal) */
export type ProtocolMessage =
  | { type: 'ROOM_SNAPSHOT'; roomCode: string; seats: [RoomSeatSlot, RoomSeatSlot, RoomSeatSlot, RoomSeatSlot]; rules: RuleConfig }
  | { type: 'SEAT_UPDATE'; seat: SeatIndex; slot: RoomSeatSlot }
  | { type: 'SEED_COMMIT'; seat: SeatIndex; commitHash: string }
  | { type: 'SEED_REVEAL'; seat: SeatIndex; seedHex: string }
  | { type: 'WALL_LOCKED'; roundSeed: string; leafHashes: string[] }
  | { type: 'TILE_DRAWN_PRIVATE'; wallIndex: number; tileId: TileId; salt: string }
  | { type: 'TILE_DRAWN_PUBLIC'; seat: SeatIndex; wallIndex: number; flowerReveals: TileId[] }
  | { type: 'PLAYER_ACTION'; seat: SeatIndex; action: PlayerActionCommand }
  | { type: 'ROUND_AUDIT'; hostSecret: string; fullWall: TileId[]; salts: string[] }

/** 實體牌轉牌面種類 `0..41` */
export function kindOf(tileId: TileId): TileKind {
  return tileId < 136 ? Math.floor(tileId / 4) : 34 + (tileId - 136)
}

export function isFlowerKind(kind: TileKind): boolean {
  return kind >= 34
}
