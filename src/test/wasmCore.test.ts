import { describe, expect, it } from 'vitest'
import { chooseBotDiscard, evaluateTaiwanWin, isMahjongWasmReady, type EvaluateWinInput } from '@/shared/wasm'
import {
  applyPlayerAction,
  createInitialTableState,
  decideBotActionForSeat,
  prepareNextRound,
  startRound,
} from '@/features/table/domain/tableState'

const baseWin: Omit<EvaluateWinInput, 'concealed' | 'melds' | 'winningTile'> = {
  flowers: [],
  isTsumo: false,
  roundWind: 0,
  seatWind: 1,
  involvesDealer: false,
  dealerStreak: 0,
  isMigi: false,
  isTenhouMigi: false,
  isTenhou: false,
  isChiihou: false,
  isRenhou: false,
  isLastTile: false,
  isRinshan: false,
  isChankan: false,
  isSevenRobOne: false,
  basePoints: 300,
  taiPoints: 100,
}

describe('Rust/Wasm core is the only rules engine', () => {
  it('is loaded (no TS fallback)', () => {
    expect(isMahjongWasmReady()).toBe(true)
  })

  it('scores with the full Rust yaku table', () => {
    // 1萬、3萬、5筒、7條、東 各一刻 + 單吊紅中，榮胡紅中 → 碰碰胡（舊 TS 備援算不出）
    const res = evaluateTaiwanWin({
      ...baseWin,
      concealed: [0, 1, 2, 8, 9, 10, 52, 53, 54, 96, 97, 98, 108, 109, 110, 124],
      melds: [],
      winningTile: 125,
    })
    const names = res.items.map((i) => i.name)
    expect(names).toContain('碰碰胡')
    expect(res.totalPoints).toBe(300 + res.totalTai * 100)
  })

  it('passes melds to Rust and respects the allowed discard set', () => {
    const concealed = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 108]
    const melds = [{ type: 'pon' as const, tiles: [124, 125, 126], fromSeat: 2 as const, calledTile: 126 }]
    expect(concealed).toContain(chooseBotDiscard(concealed, melds, false))
    expect(chooseBotDiscard(concealed, melds, false, [0, 4])).toSatisfy((t: number) => t === 0 || t === 4)
    expect(chooseBotDiscard(concealed, melds, true)).toBe(108)
  })

  it('plays many all-bot rounds through Rust scoring and bot decisions', () => {
    const state = createInitialTableState()
    for (const s of state.seats) s.isBot = true
    let wins = 0
    for (let round = 0; round < 40; round++) {
      if (round === 0) startRound(state, `seed-${round}`, `secret-${round}`)
      else prepareNextRound(state, `seed-${round}`, `secret-${round}`)
      for (let step = 0; step < 800 && state.phase !== 'ROUND_SETTLEMENT'; step++) {
        const seat =
          state.phase === 'CLAIM_WINDOW'
            ? state.claimWindow.find((c) => !c.responded)!.seat
            : state.currentSeat
        const cmd = decideBotActionForSeat(state, seat)
        expect(cmd).not.toBeNull()
        expect(applyPlayerAction(state, seat, cmd!)).toBe(true)
      }
      expect(state.phase).toBe('ROUND_SETTLEMENT')
      const s = state.settlement!
      expect(s.scoreDeltas.reduce((a, b) => a + b, 0)).toBe(0)
      if (!s.isExhaustiveDraw) {
        wins++
        expect(s.totalTai).toBeGreaterThan(0)
      }
    }
    expect(wins).toBeGreaterThan(0)
  })
})
