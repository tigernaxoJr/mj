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
  /** 防作弊牌局有真人斷線時：true = 本局作廢；false（預設）= 降級為房主發牌繼續打 */
  voidOnDisconnect: boolean
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  basePoints: 300,
  taiPoints: 100,
  allowMultiRon: false,
  turnTimeoutSec: 12,
  voidOnDisconnect: false,
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

/** 真人玩家本次連線的公鑰（base64，各 32 bytes） */
export interface RoomMemberKeys {
  seat: SeatIndex
  signPub: string
  boxPub: string
}

/**
 * 簽章信封：`body` 為內層 ProtocolMessage 的 JSON，簽的是
 * `twmj/msg/v1|房號|seat|n|body`；`n` 為該座位遞增序號，防重放。
 */
export interface SignedEnvelope {
  type: 'SIGNED'
  seat: SeatIndex
  n: number
  body: string
  sig: string
}

/**
 * 公開某牌山位置：依層順序附上每一層的逐張鎖（base64）。
 * 斷線降級後由房主重發的位置則改用承諾葉節點證明：`keys` 為空，附上 `tile` 與 `salt`。
 */
export interface TileRevealProof {
  wallIndex: number
  keys: string[]
  tile?: TileId
  salt?: string
}

/** P2P 連線協議訊息 (Co-Seeded Commit-Reveal) */
export type ProtocolMessage =
  | SignedEnvelope
  // --- 身分握手（大廳，未簽章；先承諾再公開，房主無法挑選公鑰去湊安全碼）---
  | { type: 'IDENTITY_COMMIT'; commit: string }
  | { type: 'IDENTITY_ROSTER'; roomCode: string; commits: (string | null)[] }
  | { type: 'IDENTITY_REVEAL'; signPub: string; boxPub: string }
  | { type: 'IDENTITY_KEYS'; members: RoomMemberKeys[] }
  | { type: 'IDENTITY_RESET' }
  // --- Mental Poker 牌山協定（一律包在 SignedEnvelope 內）---
  | { type: 'ROUND_START'; round: number }
  | { type: 'DECK_SHUFFLED'; round: number; seat: SeatIndex; deck: string }
  | { type: 'DECK_REKEYED'; round: number; seat: SeatIndex; deck: string; keyCommits: string }
  | { type: 'KEY_SHARE'; round: number; from: SeatIndex; to: SeatIndex; wallIndices: number[]; sealed: string[] }
  /** 位置持有者宣告：`wallIndices` 中哪些是花牌（附金鑰公開），其餘為非花牌 */
  | { type: 'TILE_RESOLVE'; round: number; seat: SeatIndex; wallIndices: number[]; flowers: TileRevealProof[] }
  /** 公開動作：附上動作所需公開的牌（打出、吃碰槓所用、胡牌時整手） */
  | { type: 'SECURE_ACTION'; round: number; seat: SeatIndex; action: PlayerActionCommand; reveals: TileRevealProof[] }
  | { type: 'ROUND_REVEAL'; round: number; seat: SeatIndex; secret: string }
  // --- 斷線降級（§4.8；只有房主能宣告）---
  /** 某位真人離開（斷線或逾時）：牌局中則降級為房主發牌，該座位由電腦代打 */
  | { type: 'DEGRADE'; round: number; seat: SeatIndex; reason: string }
  /** 嚴格模式：有人斷線本局直接作廢 */
  | { type: 'ROUND_VOID'; round: number; seat: SeatIndex; reason: string }
  /** 留下的真人把暗牌證明加密交給房主（其他人看不到） */
  | { type: 'DEGRADE_HAND'; round: number; seat: SeatIndex; sealed: string }
  | { type: 'DEGRADE_COMMIT'; round: number; commit: string }
  | { type: 'DEGRADE_SEED'; round: number; seat: SeatIndex; seed: string }
  /** 重洗後的牌池承諾：`slots` 為各位置對應的承諾索引（虛擬位置 ≥ 144 為代打座位的新手牌） */
  | { type: 'DEGRADE_WALL'; round: number; roundSeed: string; leafHashes: string[]; slots: [number, number][] }
  /** 房主私下把重發的牌交給持有者 */
  | { type: 'DEGRADE_DEAL'; round: number; to: SeatIndex; wallIndices: number[]; sealed: string }
  | { type: 'DEGRADE_REVEAL'; round: number; secret: string }
  | { type: 'ROOM_SNAPSHOT'; roomCode: string; seats: [RoomSeatSlot, RoomSeatSlot, RoomSeatSlot, RoomSeatSlot]; rules: RuleConfig }
  | { type: 'SEAT_UPDATE'; seat: SeatIndex; slot: RoomSeatSlot }
  | { type: 'SEED_COMMIT'; seat: SeatIndex; commitHash: string }
  | { type: 'SEED_REVEAL'; seat: SeatIndex; seedHex: string }
  | { type: 'SEAT_ASSIGNED'; seat: SeatIndex }
  | { type: 'WALL_LOCKED'; roundSeed: string; hostCommit: string; leafHashes: string[] }
  | { type: 'TILE_DRAWN_PRIVATE'; wallIndex: number; tileId: TileId; salt: string }
  | { type: 'TILE_DRAWN_PUBLIC'; seat: SeatIndex; wallIndex: number; flowerReveals: TileId[] }
  | { type: 'PLAYER_ACTION'; seat: SeatIndex; action: PlayerActionCommand }
  /** 房主 → 單一客機：該客機視角的牌桌（他家手牌已蓋住）及產生它的動作；`view` 為 TableState */
  | { type: 'STATE_SYNC'; seq: number; actor: SeatIndex | null; action: PlayerActionCommand | null; view: unknown }
  | { type: 'ROUND_AUDIT'; hostSecret: string; fullWall: TileId[]; salts: string[] }

/** 實體牌轉牌面種類 `0..41` */
export function kindOf(tileId: TileId): TileKind {
  return tileId < 136 ? Math.floor(tileId / 4) : 34 + (tileId - 136)
}

export function isFlowerKind(kind: TileKind): boolean {
  return kind >= 34
}
