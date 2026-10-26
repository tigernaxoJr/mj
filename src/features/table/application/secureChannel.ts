/**
 * WP-5.3: 簽章信封與房主排序轉送（設計見 docs/04-host-anticheat-mental-poker.md §4.3、§4.9）
 *
 * - 每則協定訊息由原始發送者以 ed25519 簽章，房主轉送也改不了、冒充不了。
 * - 房主是唯一的排序者：客機的訊息先送到房主，房主驗證後「原封不動」轉送給全部客機（含發送者本人），
 *   所以每台裝置套用訊息的順序都相同；客機自己的動作也要等房主回送才套用。
 * - 每台裝置都保存收到的原始信封（`evidence`），可匯出給第三方重新驗簽與稽核。
 */
import type {
  PlayerId,
  ProtocolMessage,
  RoomMemberKeys,
  SeatIndex,
  SignedEnvelope,
} from '@/shared/kernel/types'
import { base64ToBytes, bytesToBase64, mpSign, mpVerifySignature, type MpIdentitySeeds } from '@/shared/wasm'
import type { PeerTransportPort } from '@/features/lobby/infra/peerAdapter'

export type InnerMessage = Exclude<ProtocolMessage, SignedEnvelope>

const enc = new TextEncoder()

export function envelopeSigningBytes(roomCode: string, seat: SeatIndex, n: number, body: string): Uint8Array {
  return enc.encode(`twmj/msg/v1|${roomCode}|${seat}|${n}|${body}`)
}

/** 第三方驗證用：檢查信封簽章，成功回傳內層訊息 */
export function openEnvelope(
  env: SignedEnvelope,
  roomCode: string,
  members: readonly RoomMemberKeys[],
): InnerMessage | null {
  const member = members.find((m) => m.seat === env.seat)
  if (!member || typeof env.body !== 'string' || typeof env.sig !== 'string') return null
  const ok = mpVerifySignature(
    base64ToBytes(member.signPub),
    envelopeSigningBytes(roomCode, env.seat, env.n, env.body),
    base64ToBytes(env.sig),
  )
  if (!ok) return null
  try {
    return JSON.parse(env.body) as InnerMessage
  } catch {
    return null
  }
}

export interface SecureChannelOptions {
  transport: PeerTransportPort
  seeds: MpIdentitySeeds
  roomCode: string
  localSeat: SeatIndex
  isHost: boolean
  members: readonly RoomMemberKeys[]
  /** 房主：客機連線槽位 → 座位，用來確認信封座位就是該連線本人 */
  seatOfPeer?: (peer: PlayerId) => SeatIndex | undefined
  /** 依房主排序收到的訊息；`signer` 為簽章者座位 */
  onMessage: (msg: InnerMessage, signer: SeatIndex) => void
  onReject?: (reason: string, seat?: SeatIndex) => void
}

/** 可下載的證據檔：房號、四家公鑰與依序收到的全部原始信封 */
export interface EvidenceLog {
  version: 1
  roomCode: string
  recordedBySeat: SeatIndex
  members: RoomMemberKeys[]
  envelopes: SignedEnvelope[]
}

export class SecureChannel {
  private nextN = 1
  private lastN = new Map<SeatIndex, number>()
  readonly evidence: SignedEnvelope[] = []

  constructor(private readonly opts: SecureChannelOptions) {}

  send(msg: InnerMessage): void {
    const { seeds, roomCode, localSeat, transport } = this.opts
    const n = this.nextN++
    const body = JSON.stringify(msg)
    const sig = bytesToBase64(mpSign(seeds, envelopeSigningBytes(roomCode, localSeat, n, body)))
    const env: SignedEnvelope = { type: 'SIGNED', seat: localSeat, n, body, sig }
    if (this.opts.isHost) {
      this.accept(env, msg)
    } else {
      transport.sendToHost(env)
    }
  }

  /** 交給 transport sink；不是簽章信封時回傳 false 讓呼叫端自行處理 */
  receive(raw: ProtocolMessage, fromPeer?: PlayerId): boolean {
    if (raw.type !== 'SIGNED') return false
    const reject = (reason: string) => this.opts.onReject?.(reason, raw.seat)
    if (this.opts.isHost) {
      // 客機只能替自己的座位發言
      if (!fromPeer || this.opts.seatOfPeer?.(fromPeer) !== raw.seat) return reject('連線與簽章座位不符'), true
    }
    if (!Number.isInteger(raw.n) || raw.n <= (this.lastN.get(raw.seat) ?? 0)) return reject('重放或亂序的訊息'), true
    const msg = openEnvelope(raw, this.opts.roomCode, this.opts.members)
    if (!msg) return reject('簽章驗證失敗'), true
    this.accept(raw, msg)
    return true
  }

  exportEvidence(): EvidenceLog {
    return {
      version: 1,
      roomCode: this.opts.roomCode,
      recordedBySeat: this.opts.localSeat,
      members: [...this.opts.members],
      envelopes: [...this.evidence],
    }
  }

  private queue: { env: SignedEnvelope; msg: InnerMessage }[] = []
  private draining = false

  private accept(env: SignedEnvelope, msg: InnerMessage): void {
    this.lastN.set(env.seat, env.n)
    this.queue.push({ env, msg })
    if (this.draining) return
    // 處理中觸發的新訊息排在後面：房主本機的處理順序與轉送給客機的順序一致
    this.draining = true
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        this.evidence.push(next.env)
        if (this.opts.isHost) this.opts.transport.broadcast(next.env)
        try {
          this.opts.onMessage(next.msg, next.env.seat)
        } catch (err) {
          this.opts.onReject?.(`處理訊息失敗：${err instanceof Error ? err.message : String(err)}`, next.env.seat)
        }
      }
    } finally {
      this.draining = false
    }
  }
}
