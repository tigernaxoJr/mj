import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlayerId, ProtocolMessage, RoomMemberKeys, RoomSeatSlot, SeatIndex } from '@/shared/kernel/types'
import { createIdentitySeeds, mpIdentityPublic } from '@/shared/wasm'
import { memberKeysOf } from '@/features/lobby/domain/identityHandshake'
import { useTableSession } from '@/features/table/application/useTableSession'
import { decideBotActionForSeat } from '@/features/table/domain/tableState'
import { FakeStar } from './fakeStar'

vi.mock('@/features/audio', () => ({ playSfx: () => {} }))

const slot = (seat: SeatIndex, playerId: PlayerId, human: boolean): RoomSeatSlot =>
  ({
    seat,
    wind: (['east', 'south', 'west', 'north'] as const)[seat],
    occupant: human ? 'human' : 'bot',
    playerId,
    name: `S${seat}`,
    ready: true,
  }) as RoomSeatSlot

describe('table session in mental poker mode (host + guest + 2 bots)', () => {
  afterEach(() => vi.useRealTimers())

  it('plays two rounds driven only by the UI-facing API, with bots and auto-pass on timers', async () => {
    vi.useFakeTimers()
    const roomSeats = [slot(0, 'p1', true), slot(1, 'bot-1', false), slot(2, 'p3', true), slot(3, 'bot-3', false)]
    const ids = ([0, 2] as SeatIndex[]).map((seat) => {
      const seeds = createIdentitySeeds()
      return { seat, seeds, keys: memberKeysOf(seat, mpIdentityPublic(seeds)) }
    })
    const members: RoomMemberKeys[] = ids.map((i) => i.keys)
    const net = new FakeStar(['p3'])
    // 與真實流程相同：客機大廳收到第一則簽章訊息才掛上牌桌，其餘訊息先暫存
    const host = useTableSession({
      localSeat: 0,
      isHost: true,
      roomSeats,
      transport: net.hostTransport(),
      security: { roomCode: 'ROOMX1', seeds: ids[0].seeds, members },
    })
    const held: ProtocolMessage[] = []
    const guestT = net.guestTransport('p3')
    guestT.setMessageSink((msg) => void held.push(msg))
    await host.initAndStartRound()
    net.flush()
    expect(held.length).toBeGreaterThan(1)
    const guest = useTableSession({
      localSeat: 2,
      isHost: false,
      roomSeats,
      transport: {
        ...guestT,
        setMessageSink: (sink) => {
          guestT.setMessageSink(sink)
          if (sink) for (const m of held.slice(1)) sink(m)
        },
      } as typeof guestT,
      security: { roomCode: 'ROOMX1', seeds: ids[1].seeds, members },
      initialMessage: held[0],
    })
    await guest.initAndStartRound()

    for (let round = 0; round < 2; round++) {
      if (round === 1) await host.startNextRound()
      for (let i = 0; i < 3000; i++) {
        net.flush()
        vi.advanceTimersByTime(600)
        net.flush()
        if (host.auditStatus.value !== 'pending' && guest.auditStatus.value !== 'pending' && host.state.phase === 'ROUND_SETTLEMENT') break
        // 真人只在畫面會出現操作鈕時行動（與 UI 相同的入口）
        for (const s of [host, guest]) {
          const me = s.localSeat.value
          // 聽牌後摸切由本機自動處理；能自摸時才要玩家自己按
          const myTurn =
            s.state.phase === 'TURN_ACTION_OR_DISCARD' &&
            s.state.currentSeat === me &&
            (!s.localPlayer.value.isMigi || s.selfTurnOptions.value.canTsumo)
          if (s.localClaimEntry.value || myTurn) {
            const cmd = decideBotActionForSeat(s.state, me)
            if (cmd) s.dispatchAction(me, cmd)
          }
        }
      }
      expect(host.state.phase).toBe('ROUND_SETTLEMENT')
      expect(guest.securityFault.value).toBeNull()
      expect(host.securityFault.value).toBeNull()
      expect(guest.auditStatus.value).toBe('ok')
      expect(guest.state.settlement).toEqual(host.state.settlement)
      expect(guest.exportEvidence()!.envelopes.length).toBeGreaterThan(50)
    }
  })
})
