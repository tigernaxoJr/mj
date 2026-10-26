import { describe, expect, it } from 'vitest'
import type { TileId } from '@/shared/kernel/types'
import { publicProjection } from '@/features/table/domain/secureAudit'
import { ACTION_TIMEOUT_MS } from '@/features/table/application/secureTable'
import { drop, playRound, playUntilDiscards, setup, stepOnce, type Client } from './secureHarness'

/** 每張實體牌在「公開的牌 + 各家真正的手牌」中恰好出現一次（牌山剩下的另外算） */
function tilesInPlay(clients: Client[]): TileId[] {
  const host = clients[0].state
  const out: TileId[] = []
  host.seats.forEach((s, seat) => {
    out.push(...s.discards, ...s.flowers, ...s.melds.flatMap((m) => m.tiles))
    // 真人的手牌只有自己看得到；電腦座位（含代打）房主看得到
    const owner = clients.find((c) => c.seat === seat && !c.gone) ?? clients[0]
    out.push(...owner.state.seats[seat].concealed)
  })
  return out
}

describe('disconnect during a mental poker round (WP-5.6)', () => {
  it('degrades to host dealing, keeps every tile unique, finishes the round and audits the reshuffle', () => {
    const { net, clients, host } = setup([0, 1, 2, 3])
    host.table.startRound()
    playUntilDiscards(net, clients, 9)
    drop(net, clients, 2)
    net.flush()

    const stay = clients.filter((c) => !c.gone)
    for (const c of stay) {
      expect(c.faults).toEqual([])
      expect(c.table.degradedNote).toMatch(/防作弊已失效/)
      expect(c.state.seats[2].isBot).toBe(true)
    }
    // 重洗後沒有任何一張牌重複，也沒有遺失到牌池之外
    const inPlay = tilesInPlay(clients)
    expect(inPlay.every((t) => t >= 0)).toBe(true)
    expect(new Set(inPlay).size).toBe(inPlay.length)
    expect(inPlay.length + (host.state.tailCursor - host.state.headCursor)).toBe(144)

    playRound(net, clients, () => {
      const views = stay.map((c) => publicProjection(c.state))
      expect(new Set(views).size).toBe(1)
    })
    for (const c of stay) {
      expect(c.faults).toEqual([])
      expect(c.table.audited).toBe(true)
      expect(c.state.settlement).toEqual(host.state.settlement)
    }
    expect(host.state.seats.reduce((a, s) => a + s.score, 0)).toBe(40000)

    // 下一局只剩三位真人，照常防作弊
    host.table.startRound()
    playRound(net, clients)
    for (const c of stay) {
      expect(c.faults).toEqual([])
      expect(c.table.degradedNote).toBeNull()
      expect(c.state.auditVerified).toBe(true)
    }
  })

  it('degrades even when a player drops during the shuffle', () => {
    const { net, clients, host } = setup([0, 1, 2])
    host.table.startRound()
    // 房主先洗，送到客機前 p2 就斷線
    drop(net, clients, 1)
    net.flush()
    playRound(net, clients)
    const guest = clients[2]
    expect(guest.faults).toEqual([])
    expect(guest.table.audited).toBe(true)
    expect(guest.state.settlement).toEqual(host.state.settlement)
  })

  it('voids the round in strict mode and continues with the rest next round', () => {
    const { net, clients, host } = setup([0, 1, 2], { voidOnDisconnect: true })
    host.table.startRound()
    playUntilDiscards(net, clients, 5)
    drop(net, clients, 1)
    net.flush()
    for (const c of [clients[0], clients[2]]) {
      expect(c.state.phase).toBe('ROUND_SETTLEMENT')
      expect(c.state.settlement?.scoreDeltas).toEqual([0, 0, 0, 0])
      expect(c.table.degradedNote).toMatch(/作廢/)
    }
    host.table.startRound()
    playRound(net, clients)
    expect(clients[2].faults).toEqual([])
    expect(clients[2].state.auditVerified).toBe(true)
  })

  it('treats a silent player as gone after the protocol timeout, naming them', () => {
    let now = 0
    const { net, clients, host } = setup([0, 1, 2], { now: () => now })
    host.table.startRound()
    playUntilDiscards(net, clients, 4)
    // p3（座位 2）不再回應，但連線沒斷
    net.tamper = (p) => (p.from === 'p3' ? null : p.msg)
    clients[2].gone = true
    for (let i = 0; i < 40; i++) {
      net.flush()
      stepOnce(clients)
    }
    expect(host.table.incidents).toEqual([])
    now += ACTION_TIMEOUT_MS + 1
    host.table.tick()
    net.flush()
    expect(host.table.incidents[0]).toMatchObject({ seat: 2, reason: '逾時' })
    playRound(net, clients)
    expect(clients[1].faults).toEqual([])
    expect(clients[1].table.degradedNote).toMatch(/逾時/)
    expect(clients[1].state.settlement).toEqual(host.state.settlement)
  })
})
