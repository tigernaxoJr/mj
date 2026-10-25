import { describe, expect, it } from 'vitest'
import { isFlowerKind, kindOf } from '@/shared/kernel/types'
import { createCommittedWall, getWaitingKinds, sha256Hex, verifyTileLeaf } from '@/shared/wasm'
import {
  addBotToSeat,
  assignHumanToSeat,
  createRoomSession,
  fillEmptySeatsWithBots,
  generateRoomCode,
  handlePlayerDisconnect,
  isRoomReadyToStart,
  removeBotFromSeat,
  toPeerRoomId,
} from '@/features/lobby'
import {
  applyPlayerAction,
  createInitialTableState,
  decideBotActionForSeat,
  prepareNextRound,
  startRound,
} from '@/features/table/domain/tableState'

describe('Taiwan 16-tile Mahjong full core & state machine', () => {
  it('maps 144 physical tiles to 42 tile kinds accurately', () => {
    expect(kindOf(0)).toBe(0)
    expect(kindOf(3)).toBe(0)
    expect(kindOf(4)).toBe(1)
    expect(kindOf(135)).toBe(33)
    expect(isFlowerKind(kindOf(135))).toBe(false)
    expect(kindOf(136)).toBe(34)
    expect(kindOf(143)).toBe(41)
    expect(isFlowerKind(kindOf(136))).toBe(true)
  })

  it('produces standard SHA-256 and verifies Co-Seeded Commit-Reveal wall leaves', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    const wall = createCommittedWall('round-seed-1', 'host-secret-1')
    expect(wall.tiles).toHaveLength(144)
    expect(verifyTileLeaf(0, wall.tiles[0], wall.salts[0], wall.leafHashes[0])).toBe(true)
    expect(verifyTileLeaf(0, (wall.tiles[0] + 1) % 144, wall.salts[0], wall.leafHashes[0])).toBe(
      false,
    )
  })

  it('supports adding/removing computer players and P2P disconnect bot takeover', () => {
    const room = createRoomSession('房主', false)
    expect(isRoomReadyToStart(room)).toBe(false)

    expect(addBotToSeat(room, 1)).toBe(true)
    expect(room.seats[1].occupant).toBe('bot')

    expect(removeBotFromSeat(room, 1)).toBe(true)
    expect(room.seats[1].occupant).toBe('empty')

    const seatIdx = assignHumanToSeat(room, 'p2', '客機二號')
    expect(seatIdx).toBe(1)
    expect(room.seats[1].occupant).toBe('human')

    // 斷線時轉為電腦代打
    handlePlayerDisconnect(room, 'p2', true)
    expect(room.seats[1].occupant).toBe('bot')

    fillEmptySeatsWithBots(room)
    expect(isRoomReadyToStart(room)).toBe(true)

    const code = generateRoomCode()
    expect(toPeerRoomId(code)).toBe(`twmj-${code}`)
  })

  it('runs a complete 16-tile Mahjong round from flower replacement to settlement & next round', () => {
    const state = createInitialTableState()
    // 將 4 家全設為 Bot 跑完整自動對局驗證狀態機不卡死、不出現相公
    for (const s of state.seats) {
      s.isBot = true
    }

    startRound(state, 'test-round-seed-42', 'test-host-secret-99')

    if (state.phase !== 'ROUND_SETTLEMENT') {
      expect(state.phase).toBe('TURN_ACTION_OR_DISCARD')
      // 開門補花後：莊家應有 17 張非花暗牌，閒家各 16 張非花暗牌
      expect(state.seats[0].concealed).toHaveLength(17)
      expect(state.seats[1].concealed).toHaveLength(16)
      expect(state.seats[2].concealed).toHaveLength(16)
      expect(state.seats[3].concealed).toHaveLength(16)
      for (const s of state.seats) {
        expect(s.concealed.every((id) => !isFlowerKind(kindOf(id)))).toBe(true)
      }
    }

    let safetySteps = 0
    while (state.phase !== 'ROUND_SETTLEMENT' && safetySteps < 600) {
      safetySteps++
      if (state.phase === 'CLAIM_WINDOW') {
        const pending = state.claimWindow.find((c) => !c.responded)
        expect(pending).toBeDefined()
        const cmd = decideBotActionForSeat(state, pending!.seat)
        expect(cmd).not.toBeNull()
        expect(applyPlayerAction(state, pending!.seat, cmd!)).toBe(true)
      } else if (state.phase === 'TURN_ACTION_OR_DISCARD') {
        const seat = state.currentSeat
        const cmd = decideBotActionForSeat(state, seat)
        expect(cmd).not.toBeNull()
        expect(applyPlayerAction(state, seat, cmd!)).toBe(true)
      }
    }

    expect(state.phase).toBe('ROUND_SETTLEMENT')
    expect(state.settlement).not.toBeNull()

    // 驗證每家非贏家手牌皆維持 3n+1（無相公）
    for (const s of state.seats) {
      if (!state.settlement!.winnerSeats.includes(s.seat)) {
        expect(s.concealed.length + s.melds.length * 3).toBe(16)
      }
    }

    // 測試進入下一局連莊/換莊
    prepareNextRound(state, 'test-round-seed-43', 'test-host-secret-100')
    expect(state.phase).toBe('TURN_ACTION_OR_DISCARD')
  })

  it('correctly calculates waiting tiles for 16-tile hand', () => {
    // 萬子 1,2,3, 4,5,6, 7,8,9, 筒子 1,1,1, 條子 2,3,4, 中,中 (共 17 張)
    // 待摸狀態 (16 張)：萬子 1,2,3, 4,5,6, 7,8,9, 筒子 1,1,1, 條子 2,3,4, 中 (單騎中)
    const hand16 = [
      0, 4, 8,    // 1,2,3 萬
      12, 16, 20, // 4,5,6 萬
      24, 28, 32, // 7,8,9 萬
      36, 37, 38, // 1 筒刻
      76, 80, 84, // 2,3,4 條
      124,        // 紅中
    ]
    const waits = getWaitingKinds(hand16, 0)
    expect(waits).toContain(31) // 聽紅中
  })
})
