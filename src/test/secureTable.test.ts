import { describe, expect, it } from 'vitest'
import type { PlayerId, ProtocolMessage, RoomMemberKeys, RoomSeatSlot, SeatIndex } from '@/shared/kernel/types'
import { bytesToBase64, createIdentitySeeds, mpIdentityPublic, mpSign, type MpIdentitySeeds } from '@/shared/wasm'
import { memberKeysOf } from '@/features/lobby/domain/identityHandshake'
import { SecureTable } from '@/features/table/application/secureTable'
import { envelopeSigningBytes } from '@/features/table/application/secureChannel'
import { publicProjection, replaySecureRound } from '@/features/table/domain/secureAudit'
import { createInitialTableState, decideBotActionForSeat, type TableState } from '@/features/table/domain/tableState'
import type { DeckFault } from '@/features/table/application/deckProtocol'
import { FakeStar } from './fakeStar'

const ROOM = 'SAFE42'
const SLOTS: PlayerId[] = ['p2', 'p3', 'p4']

function seatSlot(seat: SeatIndex, human: boolean): RoomSeatSlot {
  const wind = (['east', 'south', 'west', 'north'] as const)[seat]
  return human
    ? { seat, wind, occupant: 'human', playerId: seat === 0 ? 'p1' : SLOTS[seat - 1], name: `真人${seat}`, ready: true }
    : { seat, wind, occupant: 'bot', playerId: `bot-${seat}` as PlayerId, name: `電腦${seat}`, ready: true }
}

interface Client {
  seat: SeatIndex
  table: SecureTable
  state: TableState
  seeds: MpIdentitySeeds
  faults: DeckFault[]
}

/** humans：真人座位（含房主 0）；其餘為電腦 */
function setup(humans: SeatIndex[]) {
  const roomSeats = ([0, 1, 2, 3] as SeatIndex[]).map((s) => seatSlot(s, humans.includes(s)))
  const ids = humans.map((seat) => {
    const seeds = createIdentitySeeds()
    return { seat, seeds, keys: memberKeysOf(seat, mpIdentityPublic(seeds)) }
  })
  const members: RoomMemberKeys[] = ids.map((i) => i.keys)
  const net = new FakeStar(humans.filter((s) => s !== 0).map((s) => SLOTS[s - 1]))
  const clients: Client[] = ids.map(({ seat, seeds }) => {
    const state = createInitialTableState(undefined, roomSeats)
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
    })
    transport.setMessageSink((msg, from) => void table.receive(msg, from))
    return { seat, table, state, seeds, faults }
  })
  return { net, clients, host: clients[0], members }
}

/** 每家用自己看得到的狀態做電腦決策（房主兼代電腦座位），直到本局結算並稽核完 */
function playRound(net: FakeStar, clients: Client[], check?: () => void): void {
  for (let i = 0; i < 2000; i++) {
    net.flush()
    check?.()
    if (clients.every((c) => c.table.audited)) return
    for (const c of clients) {
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
  throw new Error('牌局沒有結束')
}

function resign(env: ProtocolMessage, seeds: MpIdentitySeeds, edit: (body: Record<string, unknown>) => void): ProtocolMessage {
  if (env.type !== 'SIGNED') return env
  const body = JSON.parse(env.body) as Record<string, unknown>
  edit(body)
  const text = JSON.stringify(body)
  const sig = bytesToBase64(mpSign(seeds, envelopeSigningBytes(ROOM, env.seat, env.n, text)))
  return { ...env, body: text, sig }
}

const innerType = (msg: ProtocolMessage): string | null =>
  msg.type === 'SIGNED' ? (JSON.parse(msg.body) as { type: string }).type : null

describe('mental poker table (WP-5.4 / 5.5)', () => {
  it('four humans: nobody, the host included, sees another hand; two rounds pass the audit', () => {
    const { net, clients, host } = setup([0, 1, 2, 3])
    let checkedHidden = false
    for (let round = 0; round < 2; round++) {
      expect(host.table.startRound()).toBe(true)
      playRound(net, clients, () => {
        // 每次網路靜止時，四家的公開局面必定一致
        const views = clients.map((c) => publicProjection(c.state))
        expect(new Set(views).size).toBe(1)
        if (host.state.phase === 'TURN_ACTION_OR_DISCARD') {
          for (const c of clients) {
            for (const other of clients) {
              if (other.seat === c.seat) continue
              expect(c.state.seats[other.seat].concealed.every((t) => t < 0)).toBe(true)
            }
            expect(c.state.seats[c.seat].concealed.every((t) => t >= 0)).toBe(true)
          }
          checkedHidden = true
        }
      })
      for (const c of clients) {
        expect(c.faults).toEqual([])
        expect(c.table.audited).toBe(true)
        expect(c.state.auditVerified).toBe(true)
        // 稽核後四家手牌公開且一致
        expect(c.state.seats.map((s) => s.concealed)).toEqual(host.state.seats.map((s) => s.concealed))
        expect(c.state.settlement).toEqual(host.state.settlement)
      }
    }
    expect(checkedHidden).toBe(true)
    expect(host.state.seats.reduce((a, s) => a + s.score, 0)).toBe(40000)
  })

  it('two humans + two bots: the host runs the bots, the guest sees neither the host nor the bots', () => {
    const { net, clients, host } = setup([0, 2])
    const guest = clients[1]
    expect(host.table.startRound()).toBe(true)
    let seen = false
    playRound(net, clients, () => {
      if (host.state.phase !== 'TURN_ACTION_OR_DISCARD') return
      seen = true
      for (const s of [0, 1, 3] as const) expect(guest.state.seats[s].concealed.every((t) => t < 0)).toBe(true)
      // 電腦座位由房主執行，房主必須知道它們的牌（威脅模型 §3 已註明）
      for (const s of [1, 3] as const) expect(host.state.seats[s].concealed.every((t) => t >= 0)).toBe(true)
      expect(host.state.seats[2].concealed.every((t) => t < 0)).toBe(true)
    })
    expect(seen).toBe(true)
    expect(guest.faults).toEqual([])
    expect(guest.state.auditVerified).toBe(true)
  })

  it('names the player who duplicates a tile while shuffling', () => {
    const { net, clients, host } = setup([0, 1, 2])
    const cheat = clients[1]
    // 南家洗牌時把一張牌換成另一張的複本（訊息經房主轉送，作弊者自己收到的回送也是這份）
    net.tamper = (p) => {
      if (p.to === 'host' && innerType(p.msg) === 'DECK_SHUFFLED' && p.msg.type === 'SIGNED' && p.msg.seat === 1) {
        return resign(p.msg, cheat.seeds, (b) => {
          const deck = Uint8Array.from(atob(b.deck as string), (c) => c.charCodeAt(0))
          deck.copyWithin(5 * 32, 6 * 32, 7 * 32)
          b.deck = bytesToBase64(deck)
        })
      }
      return p.msg
    }
    host.table.startRound()
    playRound(net, clients)
    for (const honest of [clients[0], clients[2]]) {
      expect(honest.table.fault).toMatchObject({ seat: 1, reason: expect.stringContaining('洗牌') })
      expect(honest.state.auditVerified).toBe(false)
    }
  })

  it('rejects a wrong key share on the spot and names the sender', () => {
    const { net, clients, host } = setup([0, 1, 2])
    const cheat = clients[1]
    let tampered = false
    net.tamper = (p) => {
      if (!tampered && p.to === 'host' && innerType(p.msg) === 'KEY_SHARE' && p.msg.type === 'SIGNED' && p.msg.seat === 1) {
        tampered = true
        // 南家把兩個位置的封裝互換：對收方而言就是「錯的金鑰」
        return resign(p.msg, cheat.seeds, (b) => {
          const sealed = b.sealed as string[]
          ;[sealed[0], sealed[1]] = [sealed[1], sealed[0]]
        })
      }
      return p.msg
    }
    host.table.startRound()
    for (let i = 0; i < 20 && !clients.some((c) => c.faults.length > 0); i++) net.flush()
    const victims = clients.filter((c) => c.faults.length > 0)
    expect(victims.length).toBeGreaterThan(0)
    for (const v of victims) expect(v.faults[0]).toMatchObject({ seat: 1 })
  })

  it('catches an illegal action when the round is replayed with the full wall', () => {
    const { net, clients, host } = setup([0, 1])
    host.table.startRound()
    playRound(net, clients)
    const t = host.table.auditTranscript()
    expect(t).not.toBeNull()
    const { base, steps, projections } = t!
    const wall = host.state.wallTiles
    expect(clients.map((c) => c.faults)).toEqual([[], []])
    expect(replaySecureRound(base, wall, steps, projections)).toMatchObject({ ok: true })

    // 南家第一次打牌改成打一張不在手上的牌
    const i = steps.findIndex((s) => s.actor === 1 && s.action.type === 'DISCARD')
    const forged = steps.map((s, k) => (k === i ? { actor: s.actor, action: { type: 'DISCARD' as const, tileId: 999 } } : s))
    const res = replaySecureRound(base, wall, forged, projections)
    expect(res).toMatchObject({ ok: false, seat: 1 })

    // 把某家的「過」改成碰：牌不夠，重播時就被拒絕
    const j = steps.findIndex((s) => s.action.type === 'CLAIM_PASS')
    const forgedPon = steps.map((s, k) => (k === j ? { actor: s.actor, action: { type: 'CLAIM_PON' as const } } : s))
    const res2 = replaySecureRound(base, wall, forgedPon, projections)
    expect(res2.ok).toBe(false)
  })
})
