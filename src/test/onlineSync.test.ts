import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlayerId, ProtocolMessage, RoomSeatSlot, SeatIndex } from '@/shared/kernel/types'
import type { MessageSink, PeerTransportPort } from '@/features/lobby/infra/peerAdapter'
import { decideBotActionForSeat } from '@/features/table/domain/tableState'
import { useTableSession } from '@/features/table/application/useTableSession'

vi.mock('@/features/audio', () => ({ playSfx: () => {} }))

class FakeTransport implements Partial<PeerTransportPort> {
  sink: MessageSink | null = null
  peer: FakeTransport | null = null
  sent: ProtocolMessage[] = []
  constructor(private readonly slotId: PlayerId | null) {}
  broadcast(msg: ProtocolMessage): void {
    this.sent.push(msg)
    this.peer?.sink?.(msg)
  }
  sendToHost(msg: ProtocolMessage): void {
    this.peer?.sink?.(msg, this.slotId ?? undefined)
  }
  setMessageSink(sink: MessageSink | null): void {
    this.sink = sink
  }
}

function slot(seat: SeatIndex, occupant: 'human' | 'bot', playerId: PlayerId): RoomSeatSlot {
  const wind = (['east', 'south', 'west', 'north'] as const)[seat]
  return { seat, wind, occupant, playerId, name: `S${seat}`, ready: true } as RoomSeatSlot
}

describe('online play sync (host authoritative)', () => {
  it('guest sees the host discard and the host applies guest actions', async () => {
    const roomSeats = [
      slot(0, 'human', 'p1'),
      slot(1, 'human', 'p2'),
      slot(2, 'bot', 'bot-2'),
      slot(3, 'bot', 'bot-3'),
    ]
    vi.useFakeTimers()
    const hostT = new FakeTransport(null)
    const guestT = new FakeTransport('p2')
    hostT.peer = guestT
    guestT.peer = hostT

    const host = useTableSession({
      localSeat: 0,
      isHost: true,
      roomSeats,
      transport: hostT as unknown as PeerTransportPort,
    })
    await host.initAndStartRound()
    const lock = hostT.sent.find((m) => m.type === 'WALL_LOCKED')
    if (lock?.type !== 'WALL_LOCKED') throw new Error('host did not announce the wall')

    const guest = useTableSession({
      localSeat: 1,
      isHost: false,
      roomSeats,
      transport: guestT as unknown as PeerTransportPort,
      initialRound: { roundSeed: lock.roundSeed, hostSecret: lock.hostSecret },
    })
    await guest.initAndStartRound()

    // 同一牌山：莊家手牌一致
    expect(guest.state.seats[0].concealed).toEqual(host.state.seats[0].concealed)
    expect(guest.state.currentSeat).toBe(0)

    // 房主出牌 → 客機同步，並輪到下一家
    const tile = host.state.seats[0].concealed[0]
    expect(host.dispatchAction(0, { type: 'DISCARD', tileId: tile })).toBe(true)
    expect(guest.state.seats[0].discards).toEqual(host.state.seats[0].discards)
    expect(guest.state.phase).toBe(host.state.phase)
    expect(guest.state.currentSeat).toBe(host.state.currentSeat)

    // 整局對打：房主端的電腦自動出牌，客機（座位 1）以自己的視角送出動作，雙方狀態需始終一致
    try {
      for (let i = 0; i < 600 && host.state.phase !== 'ROUND_SETTLEMENT'; i++) {
        vi.advanceTimersByTime(700)
        const entry = guest.localClaimEntry.value
        const myTurn =
          guest.state.phase === 'TURN_ACTION_OR_DISCARD' && guest.state.currentSeat === 1
        if (entry || myTurn) {
          const cmd = decideBotActionForSeat(guest.state, 1)
          if (cmd) guest.dispatchAction(1, cmd)
        }
        const hostTurn =
          host.state.phase === 'TURN_ACTION_OR_DISCARD' && host.state.currentSeat === 0
        if (hostTurn || host.localClaimEntry.value) {
          const cmd = decideBotActionForSeat(host.state, 0)
          if (cmd) host.dispatchAction(0, cmd)
        }
        expect(JSON.stringify(guest.state.seats)).toBe(JSON.stringify(host.state.seats))
        expect(guest.state.phase).toBe(host.state.phase)
      }
    } finally {
      vi.useRealTimers()
    }
    expect(host.state.phase).toBe('ROUND_SETTLEMENT')
    expect(guest.state.phase).toBe('ROUND_SETTLEMENT')
    expect(guest.state.settlement).toEqual(host.state.settlement)
  })

  afterEach(() => vi.useRealTimers())

  it('host ignores actions sent for a seat the peer does not own', async () => {
    const roomSeats = [
      slot(0, 'human', 'p1'),
      slot(1, 'human', 'p2'),
      slot(2, 'bot', 'bot-2'),
      slot(3, 'bot', 'bot-3'),
    ]
    const hostT = new FakeTransport(null)
    const host = useTableSession({
      localSeat: 0,
      isHost: true,
      roomSeats,
      transport: hostT as unknown as PeerTransportPort,
    })
    await host.initAndStartRound()
    const tile = host.state.seats[0].concealed[0]
    host.handleProtocolMessage(
      { type: 'PLAYER_ACTION', seat: 0, action: { type: 'DISCARD', tileId: tile } },
      'p2',
    )
    expect(host.state.seats[0].discards).toHaveLength(0)
  })
})
