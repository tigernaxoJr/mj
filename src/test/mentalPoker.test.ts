import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  createIdentitySeeds,
  MP_DECK_BYTES,
  mpAuditRound,
  mpCardCommits,
  mpCardKey,
  mpCommitCardKey,
  mpDeckCipher,
  mpIdentityPublic,
  mpInitialDeck,
  mpOpenShare,
  mpRekeyPass,
  mpRoomFingerprint,
  mpSealShare,
  mpShufflePass,
  mpSign,
  mpUnlock,
  mpVerifySignature,
  randomBytes32,
  type MpDeck,
} from '@/shared/wasm'

const enc = new TextEncoder()

/** 4 位真人依序洗牌、換鑰，模擬一局的公開紀錄 */
function honestRound(secrets: Uint8Array[]) {
  const shuffled: MpDeck[] = []
  const rekeyed: MpDeck[] = []
  let deck = mpInitialDeck()
  for (const s of secrets) shuffled.push((deck = mpShufflePass(deck, s)))
  for (const s of secrets) rekeyed.push((deck = mpRekeyPass(deck, s)))
  return { shuffled, rekeyed, commits: secrets.map(mpCardCommits), secrets, final: deck }
}

describe('Mental Poker Wasm bindings', () => {
  const secrets = Array.from({ length: 4 }, randomBytes32)
  const round = honestRound(secrets)
  const keysAt = (i: number) => secrets.map((s) => mpCardKey(s, i))

  it('draws secrets from the Web Crypto CSPRNG', () => {
    expect(secrets.every((s) => s.length === 32)).toBe(true)
    expect(new Set(secrets.map(bytesToBase64)).size).toBe(4)
  })

  it('deals a shuffled permutation of all 144 tiles', () => {
    expect(round.final.length).toBe(MP_DECK_BYTES)
    const wall = Array.from({ length: 144 }, (_, i) => mpUnlock(mpDeckCipher(round.final, i), keysAt(i)))
    expect([...wall].sort((a, b) => a! - b!)).toEqual(Array.from({ length: 144 }, (_, i) => i))
    expect(wall).not.toEqual([...wall].sort((a, b) => a! - b!))
  })

  it('reveals nothing when the drawer withholds their layer', () => {
    for (let i = 0; i < 144; i += 13) {
      expect(mpUnlock(mpDeckCipher(round.final, i), keysAt(i).slice(1))).toBeNull()
    }
  })

  it('commits bind each card key', () => {
    const commits = mpCardCommits(secrets[2])
    expect(mpCommitCardKey(mpCardKey(secrets[2], 10))).toEqual(commits.subarray(320, 352))
    expect(mpCommitCardKey(mpCardKey(secrets[2], 11))).not.toEqual(commits.subarray(320, 352))
  })

  it('audits an honest round and returns the dealt wall', () => {
    const res = mpAuditRound(round)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    res.wall.forEach((tile, i) => expect(mpUnlock(mpDeckCipher(round.final, i), keysAt(i))).toBe(tile))
  })

  it('names the cheating layer and position', () => {
    const tampered = round.rekeyed.map((d) => d.slice())
    tampered[2].copyWithin(40 * 32, 41 * 32, 42 * 32)
    expect(mpAuditRound({ ...round, rekeyed: tampered })).toEqual({
      ok: false,
      fault: 'rekey',
      layer: 2,
      wallIndex: 40,
    })
    const liar = [...secrets]
    liar[3] = randomBytes32()
    expect(mpAuditRound({ ...round, secrets: liar })).toMatchObject({ ok: false, fault: 'shuffle', layer: 3 })
    expect(mpAuditRound({ ...round, secrets: secrets.slice(0, 3) })).toMatchObject({ ok: false, fault: 'malformed' })
  })

  it('rejects malformed decks instead of silently continuing', () => {
    expect(() => mpShufflePass(new Uint8Array(32), secrets[0])).toThrow()
    expect(() => mpShufflePass(mpInitialDeck(), new Uint8Array(31))).toThrow()
    expect(mpUnlock(new Uint8Array(32).fill(0xff), keysAt(0))).toBeNull()
  })

  it('seals key shares end to end through a relaying host', () => {
    const [south, west, host] = [createIdentitySeeds(), createIdentitySeeds(), createIdentitySeeds()]
    const southPub = mpIdentityPublic(south)
    const westPub = mpIdentityPublic(west)
    const ctx = { round: 3, wallIndex: 17, fromSeat: 1, toSeat: 2 }
    const key = mpCardKey(secrets[1], 17)

    // 走一趟線上傳輸的 base64
    const sealed = base64ToBytes(bytesToBase64(mpSealShare(south, westPub.boxPub, ctx, key)))
    expect(mpOpenShare(west, southPub.boxPub, ctx, sealed)).toEqual(key)
    expect(mpOpenShare(host, southPub.boxPub, ctx, sealed)).toBeNull()
    expect(mpOpenShare(west, southPub.boxPub, { ...ctx, wallIndex: 18 }, sealed)).toBeNull()
    const flipped = sealed.slice()
    flipped[0] ^= 1
    expect(mpOpenShare(west, southPub.boxPub, ctx, flipped)).toBeNull()
  })

  it('signs and verifies protocol messages', () => {
    const [a, b] = [createIdentitySeeds(), createIdentitySeeds()]
    const msg = enc.encode('DISCARD 37')
    const sig = mpSign(a, msg)
    expect(mpVerifySignature(mpIdentityPublic(a).signPub, msg, sig)).toBe(true)
    expect(mpVerifySignature(mpIdentityPublic(a).signPub, enc.encode('DISCARD 38'), sig)).toBe(false)
    expect(mpVerifySignature(mpIdentityPublic(b).signPub, msg, sig)).toBe(false)
    expect(mpVerifySignature(new Uint8Array(3), msg, sig)).toBe(false)
  })

  it('derives a room fingerprint that every client computes identically', () => {
    const members = Array.from({ length: 4 }, (_, seat) => ({ seat, ...mpIdentityPublic(createIdentitySeeds()) }))
    const honest = mpRoomFingerprint('ABC123', members)
    expect(honest.length).toBe(32)
    expect(mpRoomFingerprint('ABC123', [...members].reverse())).toEqual(honest)
    const mitm = members.map((m) => ({ ...m }))
    mitm[2].boxPub = members[0].boxPub
    expect(mpRoomFingerprint('ABC123', mitm)).not.toEqual(honest)
  })

  it('base64 round-trips a full deck', () => {
    expect(base64ToBytes(bytesToBase64(round.final))).toEqual(round.final)
  })
})
