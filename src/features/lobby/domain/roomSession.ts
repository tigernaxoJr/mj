import {
  DEFAULT_RULE_CONFIG,
  type PlayerId,
  type RoomSeatSlot,
  type RuleConfig,
  type SeatIndex,
  type WindName,
} from '@/shared/kernel/types'

const ROOM_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const SEAT_WINDS: readonly WindName[] = ['east', 'south', 'west', 'north']
const BOT_NAMES: readonly string[] = ['電腦東風', '電腦南風', '電腦西風', '電腦北風']

export interface RoomSessionState {
  roomCode: string
  seats: [RoomSeatSlot, RoomSeatSlot, RoomSeatSlot, RoomSeatSlot]
  rules: RuleConfig
}

export function generateRoomCode(length = 6): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => ROOM_CHARS[b % ROOM_CHARS.length]).join('')
}

export function toPeerRoomId(roomCode: string): string {
  return `twmj-${roomCode.trim().toUpperCase()}`
}

export function createEmptySeat(seat: SeatIndex): RoomSeatSlot {
  return {
    seat,
    wind: SEAT_WINDS[seat],
    occupant: 'empty',
    playerId: null,
    name: '空位（可加電腦）',
    ready: false,
  }
}

export function createBotSeat(seat: SeatIndex): RoomSeatSlot {
  return {
    seat,
    wind: SEAT_WINDS[seat],
    occupant: 'bot',
    playerId: `bot-${seat}` as PlayerId,
    name: BOT_NAMES[seat],
    ready: true,
  }
}

export function createRoomSession(hostName = '房主', fillBots = true): RoomSessionState {
  const seats: [RoomSeatSlot, RoomSeatSlot, RoomSeatSlot, RoomSeatSlot] = [
    {
      seat: 0,
      wind: 'east',
      occupant: 'human',
      playerId: 'p1',
      name: hostName,
      ready: true,
    },
    fillBots ? createBotSeat(1) : createEmptySeat(1),
    fillBots ? createBotSeat(2) : createEmptySeat(2),
    fillBots ? createBotSeat(3) : createEmptySeat(3),
  ]
  return {
    roomCode: generateRoomCode(),
    seats,
    rules: { ...DEFAULT_RULE_CONFIG },
  }
}

/** 於指定座位加入電腦玩家（僅允許空位轉為電腦） */
export function addBotToSeat(session: RoomSessionState, seat: SeatIndex): boolean {
  if (session.seats[seat].occupant !== 'empty') return false
  session.seats[seat] = createBotSeat(seat)
  return true
}

/** 移除指定座位的電腦玩家，恢復為空位 */
export function removeBotFromSeat(session: RoomSessionState, seat: SeatIndex): boolean {
  if (session.seats[seat].occupant !== 'bot') return false
  session.seats[seat] = createEmptySeat(seat)
  return true
}

/** 一鍵將所有空位補滿電腦玩家 */
export function fillEmptySeatsWithBots(session: RoomSessionState): void {
  for (const s of [0, 1, 2, 3] as const) {
    if (session.seats[s].occupant === 'empty') {
      session.seats[s] = createBotSeat(s)
    }
  }
}

/** 檢查四家是否皆已就緒（真人 + 電腦滿 4 席且 ready） */
export function isRoomReadyToStart(session: RoomSessionState): boolean {
  return session.seats.every((slot) => slot.occupant !== 'empty' && slot.ready)
}
