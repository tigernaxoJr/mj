/**
 * WP-5.3: 大廳身分握手與房間安全碼（設計見 docs/04-host-anticheat-mental-poker.md §4.3）
 *
 * 先承諾、再公開：每位真人先送出 `hash(公鑰)`，房主把四家承諾（名冊）發給大家之後，
 * 各家才公開公鑰。房主在看到任何真實公鑰前就必須固定它要給每個人看的名冊，
 * 因此無法反覆挑選假公鑰去「湊」出相同的安全碼（否則 24 位元的安全碼用生日攻擊幾千次就撞得到）。
 */
import type { RoomMemberKeys, SeatIndex } from '@/shared/kernel/types'
import {
  base64ToBytes,
  bytesToBase64,
  mpRoomFingerprint,
  sha256Hex,
  type MpIdentityPublic,
} from '@/shared/wasm'

/** 64 個好唸、好分辨的 emoji；4 個為一組 = 24 位元 */
export const SAFETY_EMOJI: readonly string[] = [
  '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼',
  '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔',
  '🐧', '🐦', '🦆', '🦉', '🐴', '🦄', '🐝', '🐛',
  '🦋', '🐌', '🐞', '🐢', '🐍', '🐙', '🦀', '🐬',
  '🐳', '🦈', '🐘', '🦒', '🦓', '🐪', '🦔', '🌵',
  '🌲', '🌻', '🌹', '🍀', '🍁', '🍄', '🌙', '⭐',
  '🌈', '🔥', '💧', '⛄', '🍎', '🍌', '🍇', '🍉',
  '🍓', '🍒', '🍑', '🍍', '🥕', '🌽', '🍞', '🧀',
]

export function memberKeysOf(seat: SeatIndex, pub: MpIdentityPublic): RoomMemberKeys {
  return { seat, signPub: bytesToBase64(pub.signPub), boxPub: bytesToBase64(pub.boxPub) }
}

export function identityCommit(signPub: string, boxPub: string): string {
  return sha256Hex(`twmj/identity/v1|${signPub}|${boxPub}`)
}

/**
 * 客機檢查房主發來的公鑰清單：每把都要對得上名冊承諾、自己那把沒被掉包、
 * 名冊上的每位真人都有公鑰。回傳錯誤訊息，通過則回傳 null。
 */
export function checkMembersAgainstRoster(
  roster: readonly (string | null)[],
  members: readonly RoomMemberKeys[],
  mySeat: SeatIndex,
  mine: RoomMemberKeys,
): string | null {
  const seats = new Set<number>()
  for (const m of members) {
    if (seats.has(m.seat)) return `座位 ${m.seat} 出現兩組公鑰`
    seats.add(m.seat)
    if (roster[m.seat] !== identityCommit(m.signPub, m.boxPub)) return `座位 ${m.seat} 的公鑰與名冊承諾不符`
  }
  for (let s = 0; s < roster.length; s++) {
    if (roster[s] && !seats.has(s)) return `座位 ${s} 缺少公鑰`
  }
  const me = members.find((m) => m.seat === mySeat)
  if (!me || me.signPub !== mine.signPub || me.boxPub !== mine.boxPub) return '房主送來的清單中，你的公鑰被替換了'
  return null
}

/** 房間安全碼：每台裝置自行計算，從不經網路傳送 */
export function safetyCode(roomCode: string, members: readonly RoomMemberKeys[]): string[] {
  const fp = mpRoomFingerprint(
    roomCode,
    members.map((m) => ({ seat: m.seat, signPub: base64ToBytes(m.signPub), boxPub: base64ToBytes(m.boxPub) })),
  )
  const bits = (fp[0] << 16) | (fp[1] << 8) | fp[2]
  return [18, 12, 6, 0].map((shift) => SAFETY_EMOJI[(bits >> shift) & 63])
}

/** 還沒確認安全碼的真人客機座位（房主自己按開局即視為確認） */
export function unconfirmedSeats(humanSeats: readonly SeatIndex[], confirmed: readonly SeatIndex[]): SeatIndex[] {
  return humanSeats.filter((s) => s !== 0 && !confirmed.includes(s))
}
