import { describe, expect, it } from 'vitest'
import { bytesToBase64 } from '@/shared/wasm'
import { publicProjection, replaySecureRound } from '@/features/table/domain/secureAudit'
import { innerType, playRound, resign, setup } from './secureHarness'

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
