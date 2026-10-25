import { describe, expect, it } from 'vitest'
import { isFlowerKind, kindOf } from '@/shared/kernel/types'
import {
  addBotToSeat,
  createRoomSession,
  fillEmptySeatsWithBots,
  generateRoomCode,
  isRoomReadyToStart,
  removeBotFromSeat,
  toPeerRoomId,
} from '@/features/lobby'
import { createInitialTableState } from '@/features/table'

describe('shared kernel & initial state', () => {
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

  it('creates 6-char room code and peer room id', () => {
    const code = generateRoomCode()
    expect(code).toHaveLength(6)
    expect(toPeerRoomId(code)).toBe(`twmj-${code}`)
  })

  it('supports adding and removing computer (bot) players on room seats', () => {
    const room = createRoomSession('房主', false)
    expect(isRoomReadyToStart(room)).toBe(false)

    expect(addBotToSeat(room, 1)).toBe(true)
    expect(room.seats[1].occupant).toBe('bot')

    expect(removeBotFromSeat(room, 1)).toBe(true)
    expect(room.seats[1].occupant).toBe('empty')

    fillEmptySeatsWithBots(room)
    expect(isRoomReadyToStart(room)).toBe(true)
  })

  it('initializes 4 seats with 144 tiles in table state', () => {
    const state = createInitialTableState()
    expect(state.remainingTiles).toBe(144)
    expect(state.seats).toHaveLength(4)
  })
})
