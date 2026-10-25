import type { MeldGroup, RuleConfig, SeatIndex, TileId, TurnPhase, WindName } from '@/shared/kernel/types'
import { DEFAULT_RULE_CONFIG } from '@/shared/kernel/types'

export interface PlayerSeatState {
  seat: SeatIndex
  concealed: TileId[]
  melds: MeldGroup[]
  flowers: TileId[]
  discards: TileId[]
  isMigi: boolean
  score: number
}

export interface TableState {
  phase: TurnPhase
  roundWind: WindName
  dealerSeat: SeatIndex
  dealerStreak: number
  currentSeat: SeatIndex
  remainingTiles: number
  lastDiscard: { seat: SeatIndex; tileId: TileId } | null
  seats: [PlayerSeatState, PlayerSeatState, PlayerSeatState, PlayerSeatState]
  rules: RuleConfig
}

export function createInitialTableState(rules: RuleConfig = DEFAULT_RULE_CONFIG): TableState {
  const makeSeat = (seat: SeatIndex): PlayerSeatState => ({
    seat,
    concealed: [],
    melds: [],
    flowers: [],
    discards: [],
    isMigi: false,
    score: 10000,
  })
  return {
    phase: 'IDLE',
    roundWind: 'east',
    dealerSeat: 0,
    dealerStreak: 0,
    currentSeat: 0,
    remainingTiles: 144,
    lastDiscard: null,
    seats: [makeSeat(0), makeSeat(1), makeSeat(2), makeSeat(3)],
    rules,
  }
}
