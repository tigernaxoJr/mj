/**
 * WP-5.5: 防作弊牌局的公開投影與結算重播稽核（設計見 docs/04-host-anticheat-mental-poker.md §4.7）
 *
 * 牌局進行中每台裝置只看得到自己的牌，但「公開投影」（張數、牌海、副露、花、游標、結算……）四家必定相同。
 * 結算時所有人公開本局秘密、解出完整牌山，再用完整資訊從頭重播每個動作，
 * 逐步比對公開投影。過水、詐胡、藏花、假聽牌都會在這一步現形，並指出是哪一家。
 */
import type { PlayerActionCommand, SeatIndex, TileId } from '@/shared/kernel/types'
import { canonicalJson } from './stateView'
import { applyPlayerAction, startSecureRound, type TableState } from './tableState'

export interface SecureStep {
  actor: SeatIndex
  action: PlayerActionCommand
}

function publicView(state: TableState): unknown {
  return {
    phase: state.phase,
    roundWind: state.roundWind,
    dealerSeat: state.dealerSeat,
    dealerStreak: state.dealerStreak,
    currentSeat: state.currentSeat,
    headCursor: state.headCursor,
    tailCursor: state.tailCursor,
    remainingTiles: state.remainingTiles,
    lastDrawn: state.lastDrawnTile && { seat: state.lastDrawnTile.seat, isRinshan: state.lastDrawnTile.isRinshan },
    lastDiscard: state.lastDiscard,
    claimWindow: state.claimWindow.map((c) => ({ seat: c.seat, responded: c.responded })),
    seats: state.seats.map(seatView),
    settlement: state.settlement,
    lastCallout: state.lastCallout,
    anyMeldHappened: state.anyMeldHappened,
  }
}

function seatView(s: TableState['seats'][number]): unknown {
  return {
    concealed: s.concealed.length,
    melds: s.melds,
    flowers: s.flowers,
    discards: s.discards,
    isMigi: s.isMigi,
    isTenhouMigi: s.isTenhouMigi,
    score: s.score,
    firstTurnUnbroken: s.firstTurnUnbroken,
  }
}

/** 四家都算得出、且必定相同的局面摘要 */
export function publicProjection(state: TableState): string {
  return canonicalJson(publicView(state))
}

export type ReplayResult =
  | { ok: true; final: TableState }
  | { ok: false; step: number; seat: SeatIndex | null; reason: string }

/**
 * `base`：開局前（已換莊）的狀態；`steps[i]` 之後的公開投影應等於 `projections[i + 1]`，
 * `projections[0]` 為配牌與開門補花之後。
 */
export function replaySecureRound(
  base: TableState,
  wall: readonly TileId[],
  steps: readonly SecureStep[],
  projections: readonly string[],
): ReplayResult {
  const replay = JSON.parse(JSON.stringify(base)) as TableState
  startSecureRound(replay, wall)
  const mismatch = (step: number, actor: SeatIndex | null): ReplayResult => {
    // 指出公開狀態第一個對不上的座位（例如藏花、謊報），找不到就算在動作者頭上
    const live = JSON.parse(projections[step]) as { seats: unknown[] }
    const seats = (publicView(replay) as { seats: unknown[] }).seats
    const seat = seats.findIndex((s, i) => canonicalJson(s) !== canonicalJson(live.seats[i]))
    return { ok: false, step, seat: seat >= 0 ? (seat as SeatIndex) : actor, reason: '公開局面與重播不符' }
  }
  if (publicProjection(replay) !== projections[0]) return mismatch(0, null)
  for (let i = 0; i < steps.length; i++) {
    const { actor, action } = steps[i]
    if (!applyPlayerAction(replay, actor, action)) {
      return { ok: false, step: i + 1, seat: actor, reason: '違規動作' }
    }
    if (publicProjection(replay) !== projections[i + 1]) return mismatch(i + 1, actor)
  }
  return { ok: true, final: replay }
}
