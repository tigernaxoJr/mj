/** 防作弊牌局測試共用：記憶體網路上的 N 位真人，每家以電腦決策代打自己的座位 */
import { DEFAULT_RULE_CONFIG, type PlayerId, type ProtocolMessage, type RoomMemberKeys, type RoomSeatSlot, type SeatIndex } from '@/shared/kernel/types'
import { bytesToBase64, createIdentitySeeds, mpIdentityPublic, mpSign, type MpIdentitySeeds } from '@/shared/wasm'
import { memberKeysOf } from '@/features/lobby/domain/identityHandshake'
import { SecureTable } from '@/features/table/application/secureTable'
import { envelopeSigningBytes } from '@/features/table/application/secureChannel'
import { createInitialTableState, decideBotActionForSeat, type TableState } from '@/features/table/domain/tableState'
import type { DeckFault } from '@/features/table/application/deckProtocol'
import { FakeStar } from './fakeStar'

export const ROOM = 'SAFE42'
export const SLOTS: PlayerId[] = ['p2', 'p3', 'p4']

function seatSlot(seat: SeatIndex, human: boolean): RoomSeatSlot {
  const wind = (['east', 'south', 'west', 'north'] as const)[seat]
  return human
    ? { seat, wind, occupant: 'human', playerId: seat === 0 ? 'p1' : SLOTS[seat - 1], name: `真人${seat}`, ready: true }
    : { seat, wind, occupant: 'bot', playerId: `bot-${seat}` as PlayerId, name: `電腦${seat}`, ready: true }
}

export interface Client {
  seat: SeatIndex
  table: SecureTable
  state: TableState
  seeds: MpIdentitySeeds
  faults: DeckFault[]
  /** 測試中被斷線的客機 */
  gone?: boolean
}

/** humans：真人座位（含房主 0）；其餘為電腦 */
export function setup(humans: SeatIndex[], opts: { voidOnDisconnect?: boolean; now?: () => number } = {}) {
  const roomSeats = ([0, 1, 2, 3] as SeatIndex[]).map((s) => seatSlot(s, humans.includes(s)))
  const ids = humans.map((seat) => {
    const seeds = createIdentitySeeds()
    return { seat, seeds, keys: memberKeysOf(seat, mpIdentityPublic(seeds)) }
  })
  const members: RoomMemberKeys[] = ids.map((i) => i.keys)
  const net = new FakeStar(humans.filter((s) => s !== 0).map((s) => SLOTS[s - 1]))
  const clients: Client[] = ids.map(({ seat, seeds }) => {
    const state = createInitialTableState({ ...DEFAULT_RULE_CONFIG, voidOnDisconnect: !!opts.voidOnDisconnect }, roomSeats)
    const transport = seat === 0 ? net.hostTransport() : net.guestTransport(SLOTS[seat - 1])
    const faults: DeckFault[] = []
    const table = new SecureTable({
      state,
      localSeat: seat,
      isHost: seat === 0,
      roomSeats,
      transport,
      security: { roomCode: ROOM, seeds, members },
      onStep: () => {},
      onFault: (f) => faults.push(f),
      now: opts.now,
    })
    transport.setMessageSink((msg, from) => void table.receive(msg, from))
    transport.setPeerLeftHandler((peer) => (peer ? table.onPeerLeft(peer) : table.onHostLost()))
    return { seat, table, state, seeds, faults }
  })
  return { net, clients, host: clients[0], members }
}

/** 每家用自己看得到的狀態做一次電腦決策（房主兼代電腦座位） */
export function stepOnce(clients: Client[]): void {
  for (const c of clients.filter((x) => !x.gone && !x.table.spectator)) {
    const s = c.state
    const seats: SeatIndex[] = c.seat === 0 ? ([0, 1, 2, 3] as SeatIndex[]).filter((x) => x === 0 || c.table.isBotSeat(x)) : [c.seat]
    for (const seat of seats) {
      const waiting =
        (s.phase === 'CLAIM_WINDOW' && s.claimWindow.some((e) => e.seat === seat && !e.responded)) ||
        (s.phase === 'TURN_ACTION_OR_DISCARD' && s.currentSeat === seat)
      if (!waiting) continue
      const cmd = decideBotActionForSeat(s, seat)
      if (cmd) c.table.submit(seat, cmd)
    }
  }
}

/** 一直打到本局結算並稽核完 */
export function playRound(net: FakeStar, clients: Client[], check?: () => void): void {
  for (let i = 0; i < 2000; i++) {
    net.flush()
    check?.()
    if (clients.filter((c) => !c.gone && !c.table.spectator).every((c) => c.table.audited)) return
    stepOnce(clients)
  }
  throw new Error('牌局沒有結束')
}

export function resign(env: ProtocolMessage, seeds: MpIdentitySeeds, edit: (body: Record<string, unknown>) => void): ProtocolMessage {
  if (env.type !== 'SIGNED') return env
  const body = JSON.parse(env.body) as Record<string, unknown>
  edit(body)
  const text = JSON.stringify(body)
  const sig = bytesToBase64(mpSign(seeds, envelopeSigningBytes(ROOM, env.seat, env.n, text)))
  return { ...env, body: text, sig }
}

export const innerType = (msg: ProtocolMessage): string | null =>
  msg.type === 'SIGNED' ? (JSON.parse(msg.body) as { type: string }).type : null

/** 打到第 n 次有人打牌（網路靜止時）為止 */
export function playUntilDiscards(net: FakeStar, clients: Client[], n: number): void {
  let stop = false
  try {
    playRound(net, clients, () => {
      const discards = clients[0].state.seats.reduce((a, s) => a + s.discards.length, 0)
      if (discards >= n) {
        stop = true
        throw new Error('stop')
      }
    })
  } catch (err) {
    if (!stop) throw err
  }
}

export function drop(net: FakeStar, clients: Client[], seat: SeatIndex): void {
  clients.find((c) => c.seat === seat)!.gone = true
  net.drop(SLOTS[seat - 1])
}
