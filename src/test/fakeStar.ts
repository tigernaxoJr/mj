import type { PlayerId, ProtocolMessage } from '@/shared/kernel/types'
import type { MessageSink, PeerTransportPort } from '@/features/lobby/infra/peerAdapter'

type Packet = { to: 'host' | PlayerId; from?: PlayerId; msg: ProtocolMessage }

/**
 * 記憶體內的星狀網路：1 房主 + 多客機。訊息先排隊，`flush()` 才依序送達（模擬非同步網路，
 * 也避免同步遞迴）。`tamper` 可在送達前改寫或丟棄封包，模擬作弊的轉送者。
 */
export class FakeStar {
  private queue: Packet[] = []
  private sinks = new Map<'host' | PlayerId, MessageSink>()
  tamper: ((p: Packet) => ProtocolMessage | null) | null = null
  delivered = 0

  constructor(readonly guestSlots: PlayerId[]) {}

  hostTransport(): PeerTransportPort {
    return this.endpoint('host')
  }

  guestTransport(slot: PlayerId): PeerTransportPort {
    return this.endpoint(slot)
  }

  private endpoint(me: 'host' | PlayerId): PeerTransportPort {
    const push = (to: 'host' | PlayerId, msg: ProtocolMessage) =>
      // 模擬序列化：兩端不得共用物件參考
      this.queue.push({ to, from: me === 'host' ? undefined : me, msg: JSON.parse(JSON.stringify(msg)) })
    const port: Partial<PeerTransportPort> = {
      sendToHost: (msg) => push('host', msg),
      sendToPeer: (slot, msg) => push(slot, msg),
      broadcast: (msg, exclude) => {
        for (const g of this.guestSlots) if (g !== exclude) push(g, msg)
      },
      setMessageSink: (sink) => {
        if (sink) this.sinks.set(me, sink)
        else this.sinks.delete(me)
      },
      holdMessages: () => {},
      lockRoom: () => {},
      disconnect: () => {},
    }
    return port as PeerTransportPort
  }

  /** 送出所有排隊中的封包（含處理過程中新產生的），回傳送達數 */
  flush(limit = 200_000): number {
    let n = 0
    while (this.queue.length > 0) {
      if (++n > limit) throw new Error('FakeStar: 訊息無限循環')
      const p = this.queue.shift()!
      const msg = this.tamper ? this.tamper(p) : p.msg
      if (!msg) continue
      this.delivered++
      this.sinks.get(p.to)?.(msg, p.to === 'host' ? p.from : undefined)
    }
    return n
  }
}
