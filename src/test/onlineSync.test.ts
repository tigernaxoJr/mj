import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlayerId, ProtocolMessage, RoomSeatSlot, SeatIndex } from '@/shared/kernel/types'
import type { MessageSink, PeerTransportPort } from '@/features/lobby/infra/peerAdapter'
import { useTableSession } from '@/features/table/application/useTableSession'
import { decideBotActionForSeat } from '@/features/table/domain/tableState'
import { HIDDEN_TILE } from '@/features/table/domain/stateView'

vi.mock('@/features/audio', () => ({ playSfx: () => {} }))

/** 記憶體內的房主 ↔ 客機連線；`tamper` 可在訊息送達前改寫，模擬作弊的房主 */
class FakeTransport implements Partial<PeerTransportPort> {
  sink: MessageSink | null = null
  peer: FakeTransport | null = null
  tamper: ((msg: ProtocolMessage) => ProtocolMessage) | null = null
  constructor(private readonly slotId: PlayerId | null) {}
  private deliver(msg: ProtocolMessage): void {
    const out = this.tamper ? this.tamper(msg) : msg
    // 模擬網路序列化：房主與客機不得共用物件參考
    this.peer?.sink?.(JSON.parse(JSON.stringify(out)) as ProtocolMessage, this.slotId ?? undefined)
  }
  broadcast(msg: ProtocolMessage): void {
    this.deliver(msg)
  }
  sendToPeer(_slot: PlayerId, msg: ProtocolMessage): void {
    this.deliver(msg)
  }
  sendToHost(msg: ProtocolMessage): void {
    this.deliver(msg)
  }
  setMessageSink(sink: MessageSink | null): void {
    this.sink = sink
  }
}

function slot(seat: SeatIndex, occupant: 'human' | 'bot', playerId: PlayerId): RoomSeatSlot {
  const wind = (['east', 'south', 'west', 'north'] as const)[seat]
  return { seat, wind, occupant, playerId, name: `S${seat}`, ready: true } as RoomSeatSlot
}

const roomSeats = [
  slot(0, 'human', 'p1'),
  slot(1, 'human', 'p2'),
  slot(2, 'bot', 'bot-2'),
  slot(3, 'bot', 'bot-3'),
]

/** 建立房主 + 客機，完成 commit → 客機種子 → 洗牌 → 首次視角同步 */
async function startOnlineRound() {
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
  // 房主 SEED_COMMIT 送出時客機才存在（對應真實流程：大廳收到後才開牌桌）
  let guest: ReturnType<typeof useTableSession> | null = null
  const origBroadcast = hostT.broadcast.bind(hostT)
  hostT.broadcast = (msg) => {
    if (msg.type === 'SEED_COMMIT' && !guest) {
      guest = useTableSession({
        localSeat: 1,
        isHost: false,
        roomSeats,
        transport: guestT as unknown as PeerTransportPort,
        initialMessage: JSON.parse(JSON.stringify(msg)) as ProtocolMessage,
      })
      void guest.initAndStartRound()
      return
    }
    origBroadcast(msg)
  }
  const starting = host.initAndStartRound()
  await vi.advanceTimersByTimeAsync(0)
  await starting
  if (!guest) throw new Error('guest was never created')
  return { host, guest: guest as ReturnType<typeof useTableSession>, hostT, guestT }
}

function playToSettlement(
  host: ReturnType<typeof useTableSession>,
  guest: ReturnType<typeof useTableSession>,
  beforeStep?: (i: number) => void,
): void {
  for (let i = 0; i < 600 && host.state.phase !== 'ROUND_SETTLEMENT'; i++) {
    beforeStep?.(i)
    vi.advanceTimersByTime(700)
    const myTurn = guest.state.phase === 'TURN_ACTION_OR_DISCARD' && guest.state.currentSeat === 1
    if (guest.localClaimEntry.value || myTurn) {
      const cmd = decideBotActionForSeat(guest.state, 1)
      if (cmd) guest.dispatchAction(1, cmd)
    }
    const hostTurn = host.state.phase === 'TURN_ACTION_OR_DISCARD' && host.state.currentSeat === 0
    if (hostTurn || host.localClaimEntry.value) {
      const cmd = decideBotActionForSeat(host.state, 0)
      if (cmd) host.dispatchAction(0, cmd)
    }
  }
}

describe('online play: host-authoritative, hidden hands, committed wall', () => {
  afterEach(() => vi.useRealTimers())

  it('guest sees only their own hand, yet mirrors every public change', async () => {
    const { host, guest } = await startOnlineRound()

    expect(guest.state.seats[1].concealed).toEqual(host.state.seats[1].concealed)
    for (const seat of [0, 2, 3] as const) {
      expect(guest.state.seats[seat].concealed).toHaveLength(host.state.seats[seat].concealed.length)
      expect(guest.state.seats[seat].concealed.every((t) => t === HIDDEN_TILE)).toBe(true)
    }
    expect(guest.state.wallTiles).toHaveLength(0)
    expect(guest.state.hostSecret).toBe('')

    playToSettlement(host, guest, () => {
      for (const seat of [0, 2, 3] as const) {
        if (guest.state.phase === 'ROUND_SETTLEMENT') return
        expect(guest.state.seats[seat].discards).toEqual(host.state.seats[seat].discards)
        expect(guest.state.seats[seat].concealed.every((t) => t === HIDDEN_TILE)).toBe(true)
      }
      expect(guest.state.currentSeat).toBe(host.state.currentSeat)
    })

    expect(guest.state.phase).toBe('ROUND_SETTLEMENT')
    // 結算後四家手牌公開，且稽核（承諾、牌山、逐步重播）通過
    expect(guest.state.seats[0].concealed).toEqual(host.state.seats[0].concealed)
    expect(guest.state.settlement).toEqual(host.state.settlement)
    expect(guest.state.auditVerified).toBe(true)
  })

  it('the next round is also committed and audited', async () => {
    const { host, guest } = await startOnlineRound()
    playToSettlement(host, guest)
    expect(guest.state.auditVerified).toBe(true)

    const next = host.startNextRound()
    await vi.advanceTimersByTimeAsync(0)
    await next
    expect(guest.state.phase).not.toBe('ROUND_SETTLEMENT')
    expect(guest.state.seats[1].concealed).toEqual(host.state.seats[1].concealed)

    playToSettlement(host, guest)
    expect(guest.state.phase).toBe('ROUND_SETTLEMENT')
    expect(guest.state.auditVerified).toBe(true)
  })

  it('detects a host that swaps a wall tile after the wall was committed', async () => {
    // 房主權威流程的稽核只能抓到「改變了公開局面」的換牌：偶爾換過的兩張落到同一家、
    // 最後結果完全相同（或一開局就胡、根本沒摸到），重播無從分辨。這正是 Mental Poker 牌局要補的洞。
    // 因此重試數次，要求至少一次被抓到。
    let detected = 0
    for (let attempt = 0; attempt < 6 && detected === 0; attempt++) {
      const { host, guest } = await startOnlineRound()
      playToSettlement(host, guest, (i) => {
        if (i === 1) {
          // 開局後偷換牌山：把緊接著要摸的兩張互換
          const w = host.state.wallTiles
          const at = host.state.headCursor
          ;[w[at], w[at + 1]] = [w[at + 1], w[at]]
        }
      })
      expect(guest.state.phase).toBe('ROUND_SETTLEMENT')
      if (!guest.state.auditVerified) detected++
      vi.useRealTimers()
    }
    expect(detected).toBeGreaterThan(0)
  })

  it('detects a host that reveals a different secret than the one it committed to', async () => {
    const { host, guest, hostT } = await startOnlineRound()
    hostT.tamper = (msg) =>
      msg.type === 'ROUND_AUDIT' ? { ...msg, hostSecret: `${msg.hostSecret}x` } : msg
    playToSettlement(host, guest)
    expect(guest.state.auditVerified).toBe(false)
  })

  it('host ignores actions sent for a seat the peer does not own', async () => {
    const { host } = await startOnlineRound()
    const tile = host.state.seats[0].concealed[0]
    host.handleProtocolMessage(
      { type: 'PLAYER_ACTION', seat: 0, action: { type: 'DISCARD', tileId: tile } },
      'p2',
    )
    expect(host.state.seats[0].discards).toHaveLength(0)
  })
})
