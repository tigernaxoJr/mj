import { describe, expect, it } from 'vitest'
import type { PlayerId, ProtocolMessage, RoomMemberKeys, SeatIndex } from '@/shared/kernel/types'
import { createIdentitySeeds, mpIdentityPublic, type MpIdentitySeeds } from '@/shared/wasm'
import {
  checkMembersAgainstRoster,
  identityCommit,
  memberKeysOf,
  SAFETY_EMOJI,
  safetyCode,
} from '@/features/lobby/domain/identityHandshake'
import { openEnvelope, SecureChannel, type InnerMessage } from '@/features/table/application/secureChannel'
import { FakeStar } from './fakeStar'

function people(n: number) {
  return Array.from({ length: n }, (_, seat) => {
    const seeds = createIdentitySeeds()
    return { seeds, keys: memberKeysOf(seat as SeatIndex, mpIdentityPublic(seeds)) }
  })
}

describe('room safety code', () => {
  it('uses 64 distinct single-glyph emoji', () => {
    expect(SAFETY_EMOJI).toHaveLength(64)
    expect(new Set(SAFETY_EMOJI).size).toBe(64)
  })

  it('is computed identically by everyone and changes when a key is swapped', () => {
    const ps = people(4)
    const members = ps.map((p) => p.keys)
    const code = safetyCode('ABC234', members)
    expect(code).toHaveLength(4)
    expect(safetyCode('ABC234', [...members].reverse())).toEqual(code)
    const mitm = members.map((m) => ({ ...m }))
    mitm[2].boxPub = members[0].boxPub
    // 24 位元，隨機撞上的機率 1/16M
    expect(safetyCode('ABC234', mitm)).not.toEqual(code)
  })

  it('lets a guest reject a host that swaps keys after the roster was fixed', () => {
    const ps = people(3)
    const members = ps.map((p) => p.keys)
    const roster = members.map((m) => identityCommit(m.signPub, m.boxPub))
    expect(checkMembersAgainstRoster(roster, members, 1, members[1])).toBeNull()

    // 房主在名冊之後才把西家換成自己能控制的公鑰
    const fake = people(1)[0].keys
    const swapped = members.map((m) => (m.seat === 2 ? { ...fake, seat: 2 as SeatIndex } : m))
    expect(checkMembersAgainstRoster(roster, swapped, 1, members[1])).toMatch(/承諾不符/)

    // 房主連名冊一起換：客機看到自己的公鑰被替換
    const replacedMe = members.map((m) => (m.seat === 1 ? { ...fake, seat: 1 as SeatIndex } : m))
    const forgedRoster = replacedMe.map((m) => identityCommit(m.signPub, m.boxPub))
    expect(checkMembersAgainstRoster(forgedRoster, replacedMe, 1, members[1])).toMatch(/替換/)

    // 少給一家
    expect(checkMembersAgainstRoster(roster, members.slice(0, 2), 1, members[1])).toMatch(/缺少/)
  })
})

describe('signed envelopes through a relaying host', () => {
  function setup(n: number) {
    const ps = people(n)
    const members: RoomMemberKeys[] = ps.map((p) => p.keys)
    const slots: PlayerId[] = (['p2', 'p3', 'p4'] as PlayerId[]).slice(0, n - 1)
    const net = new FakeStar(slots)
    const got: { seat: SeatIndex; msg: InnerMessage; signer: SeatIndex }[] = []
    const rejects: string[] = []
    const mk = (seat: SeatIndex, seeds: MpIdentitySeeds) => {
      const transport = seat === 0 ? net.hostTransport() : net.guestTransport(slots[seat - 1])
      const ch = new SecureChannel({
        transport,
        seeds,
        roomCode: 'ROOM42',
        localSeat: seat,
        isHost: seat === 0,
        members,
        seatOfPeer: (peer) => (slots.indexOf(peer) + 1) as SeatIndex,
        onMessage: (msg, signer) => got.push({ seat, msg, signer }),
        onReject: (reason) => rejects.push(`${seat}:${reason}`),
      })
      transport.setMessageSink((msg, from) => void ch.receive(msg, from))
      return ch
    }
    const channels = ps.map((p, seat) => mk(seat as SeatIndex, p.seeds))
    return { net, channels, got, rejects, members, ps }
  }

  const action = (seat: SeatIndex): InnerMessage => ({
    type: 'SECURE_ACTION',
    round: 0,
    seat,
    action: { type: 'CLAIM_PASS' },
    reveals: [],
  })

  it('delivers every message to everyone in the host order, own echoes included', () => {
    const { net, channels, got, rejects } = setup(3)
    channels[1].send(action(1))
    channels[0].send(action(0))
    channels[2].send(action(2))
    net.flush()
    expect(rejects).toEqual([])
    const orderAt = (seat: number) => got.filter((g) => g.seat === seat).map((g) => g.signer)
    // 房主自己的訊息先處理，客機的訊息到房主時才排序
    expect(orderAt(0)).toEqual([0, 1, 2])
    expect(orderAt(1)).toEqual(orderAt(0))
    expect(orderAt(2)).toEqual(orderAt(0))
    expect(channels[2].exportEvidence().envelopes).toHaveLength(3)
  })

  it('rejects a host that forges or alters a guest message', () => {
    const { net, channels, got, rejects } = setup(3)
    net.tamper = (p) => {
      const m = p.msg as ProtocolMessage
      if (p.to === 'p3' && m.type === 'SIGNED' && m.seat === 1) {
        return { ...m, body: m.body.replace('CLAIM_PASS', 'CLAIM_RON') }
      }
      return p.msg
    }
    channels[1].send(action(1))
    net.flush()
    expect(got.filter((g) => g.seat === 2)).toHaveLength(0)
    expect(rejects).toContain('2:簽章驗證失敗')
    // 另一位客機與房主照常收到
    expect(got.filter((g) => g.seat === 1)).toHaveLength(1)
  })

  it('rejects replays and a guest speaking for another seat', () => {
    const { net, channels, got, rejects } = setup(3)
    let captured: ProtocolMessage | null = null
    net.tamper = (p) => {
      if (p.to === 'p3' && p.msg.type === 'SIGNED') captured = p.msg
      return p.msg
    }
    channels[1].send(action(1))
    net.flush()
    const before = got.length
    // 房主把舊訊息再送一次
    net.hostTransport().sendToPeer('p3', captured!)
    net.flush()
    expect(got.length).toBe(before)
    expect(rejects).toContain('2:重放或亂序的訊息')

    // 客機 p3（座位 2）轉送座位 1 的簽章訊息給房主
    let dropped: ProtocolMessage | null = null
    channels[1].send(action(1))
    net.tamper = (p) => {
      if (p.to === 'host' && p.from === 'p2') return (dropped = p.msg), null
      return p.msg
    }
    net.flush()
    net.tamper = null
    net.guestTransport('p3').sendToHost(dropped!)
    net.flush()
    expect(rejects).toContain('0:連線與簽章座位不符')
  })

  it('evidence can be verified by a third party', () => {
    const { net, channels, members } = setup(2)
    channels[1].send(action(1))
    channels[0].send(action(0))
    net.flush()
    const log = channels[1].exportEvidence()
    const opened = log.envelopes.map((e) => openEnvelope(e, log.roomCode, log.members))
    expect(opened.every((m) => m?.type === 'SECURE_ACTION')).toBe(true)
    const forged = { ...log.envelopes[0], body: log.envelopes[0].body.replace('CLAIM_PASS', 'CLAIM_RON') }
    expect(openEnvelope(forged, log.roomCode, members)).toBeNull()
  })
})
