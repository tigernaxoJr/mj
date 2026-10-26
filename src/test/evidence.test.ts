import { describe, expect, it } from 'vitest'
import { verifyEvidence } from '@/features/table/application/evidenceVerifier'
import { bytesToBase64 } from '@/shared/wasm'
import { drop, innerType, playRound, playUntilDiscards, resign, setup } from './secureHarness'

describe('downloadable evidence (WP-5.6)', () => {
  it('lets a third party re-verify signatures, deck audits and scores of every round', () => {
    const { net, clients, host } = setup([0, 1, 2])
    for (let round = 0; round < 2; round++) {
      host.table.startRound()
      playRound(net, clients)
    }
    const log = JSON.parse(JSON.stringify(clients[2].table.exportEvidence()))
    const report = verifyEvidence(log)
    expect(report.errors).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.rounds.map((r) => r.status)).toEqual(['ok', 'ok'])
    // 重算的分數與牌桌上一致
    const total = [0, 1, 2, 3].map((s) => report.rounds.reduce((a, r) => a + (r.scoreDeltas?.[s] ?? 0), 0))
    expect(total.map((d) => d + 10000)).toEqual(host.state.seats.map((s) => s.score))

    // 改動任何一則訊息都會被發現
    const forged = JSON.parse(JSON.stringify(log))
    const i = forged.envelopes.findIndex((e: { body: string }) => e.body.includes('"DISCARD"'))
    forged.envelopes[i].body = forged.envelopes[i].body.replace('"DISCARD"', '"TSUMO"')
    const bad = verifyEvidence(forged)
    expect(bad.ok).toBe(false)
    expect(bad.badSignatures).toBe(1)
  })

  it('names the cheating shuffler from the evidence alone', () => {
    const { net, clients, host } = setup([0, 1, 2])
    const cheat = clients[1]
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
    const report = verifyEvidence(clients[0].table.exportEvidence())
    expect(report.ok).toBe(false)
    expect(report.rounds[0]).toMatchObject({ status: 'fault', detail: expect.stringContaining('座位 1') })
  })

  it('reports a degraded round as not fully verified', () => {
    const { net, clients, host } = setup([0, 1, 2])
    host.table.startRound()
    playUntilDiscards(net, clients, 6)
    drop(net, clients, 1)
    playRound(net, clients)
    const report = verifyEvidence(clients[2].table.exportEvidence())
    expect(report.rounds[0].status).toBe('degraded')
    expect(report.rounds[0].detail).toMatch(/重洗承諾驗證通過/)
    expect(report.ok).toBe(false)
  })
})
