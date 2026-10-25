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
const ALL_SEATS: readonly SeatIndex[] = [0, 1, 2, 3]

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
  for (const s of ALL_SEATS) {
    if (session.seats[s].occupant === 'empty') {
      session.seats[s] = createBotSeat(s)
    }
  }
}

/**
 * 將真人玩家排入座位（優先使用空位；若無空位但有電腦座位，自動替換首位電腦）
 */
export function assignHumanToSeat(
  session: RoomSessionState,
  playerId: PlayerId,
  name: string,
  preferredSeat?: SeatIndex,
): SeatIndex | null {
  const existing = session.seats.find((s) => s.playerId === playerId)
  const trimmedName = name.trim()

  if (existing) {
    existing.occupant = 'human'
    existing.name = trimmedName || existing.name
    existing.ready = true
    return existing.seat
  }

  let targetSeat: SeatIndex | undefined
  if (preferredSeat !== undefined && session.seats[preferredSeat].occupant !== 'human') {
    targetSeat = preferredSeat
  } else {
    targetSeat =
      ALL_SEATS.find((s) => session.seats[s].occupant === 'empty') ??
      ALL_SEATS.find((s) => session.seats[s].occupant === 'bot')
  }

  if (targetSeat === undefined) return null

  session.seats[targetSeat] = {
    seat: targetSeat,
    wind: SEAT_WINDS[targetSeat],
    occupant: 'human',
    playerId,
    name: trimmedName || `玩家 ${targetSeat + 1}`,
    ready: true,
  }
  return targetSeat
}

/**
 * 處理遠端玩家離線或中途斷線：
 * - `convertToBot = true`（對局進行中）：無縫切換為 Bot 代打
 * - `convertToBot = false`（大廳等待中）：釋放為空位
 */
export function handlePlayerDisconnect(
  session: RoomSessionState,
  playerId: PlayerId,
  convertToBot = true,
): SeatIndex | null {
  const slot = session.seats.find((s) => s.playerId === playerId)
  if (!slot) return null
  const seat = slot.seat
  session.seats[seat] = convertToBot ? createBotSeat(seat) : createEmptySeat(seat)
  return seat
}

/** 檢查四家是否皆已就緒（真人 + 電腦滿 4 席且 ready） */
export function isRoomReadyToStart(session: RoomSessionState): boolean {
  return session.seats.every((slot) => slot.occupant !== 'empty' && slot.ready)
}
