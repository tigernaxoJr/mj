/**
 * WP-3.1: PeerJS 星狀連線介面卡 (4 人台灣麻將：1 Host + 最多 3 位遠端客機)
 * - 預設直連 PeerJS 官方公共信令池 (`0.peerjs.com`)，Peer ID 固定為 `twmj-<ROOM_CODE>`。
 * - 若設定 `VITE_PEER_HOST` 則優先連線自建伺服器，失敗時可自動平滑 Fallback 至公共信令池。
 * - 開房遇 `unavailable-id` 自動重抽房號重試。
 * - 房間滿 4 人（3 位遠端連線）或開局 `lockRoom()` 後，立即拒絕新連入並自公共信令伺服器斷開註冊。
 */
import Peer, { type DataConnection, type PeerJSOption } from 'peerjs'
import type { PlayerId, ProtocolMessage } from '@/shared/kernel/types'
import { generateRoomCode, toPeerRoomId } from '../domain/roomSession'

export { toPeerRoomId }

export type SignalingEndpointMode = 'custom' | 'public' | 'fallback-public'

export interface SignalingEndpointInfo {
  mode: SignalingEndpointMode
  label: string
  host: string
}

export interface HostCallbacks {
  onPeerConnected: (peerSlotId: PlayerId) => void
  onPeerMessage: (peerSlotId: PlayerId, msg: ProtocolMessage) => void
  onPeerDisconnected: (peerSlotId: PlayerId) => void
  onSignalingChanged?: (info: SignalingEndpointInfo) => void
}

export interface ClientCallbacks {
  onConnected: () => void
  onMessage: (msg: ProtocolMessage) => void
  onDisconnected: (reason?: string) => void
  onSignalingChanged?: (info: SignalingEndpointInfo) => void
}

export interface PeerTransportPort {
  hostRoomWithRetry(
    initialCode: string,
    callbacks: HostCallbacks,
    maxRetries?: number,
  ): Promise<string>
  joinRoom(roomCode: string, callbacks: ClientCallbacks): Promise<void>
  sendToPeer(peerSlotId: PlayerId, msg: ProtocolMessage): void
  broadcast(msg: ProtocolMessage, excludePeerSlotId?: PlayerId): void
  sendToHost(msg: ProtocolMessage): void
  lockRoom(): void
  disconnect(): void
  getSignalingInfo(): SignalingEndpointInfo
  /** 開始暫存收到的訊息（大廳交棒給牌桌前，避免遺漏） */
  holdMessages(): void
  /** 牌桌接管所有後續訊息，並先送出暫存內容；傳入 null 取消接管 */
  setMessageSink(sink: MessageSink | null): void
}

/** `fromPeer` 僅房主端有值（客機槽位 id） */
export type MessageSink = (msg: ProtocolMessage, fromPeer?: PlayerId) => void

export const MAX_REMOTE_PEERS = 3 // 1 Host ('p1') + 最多 3 Guests ('p2', 'p3', 'p4')
const GUEST_SLOT_IDS: readonly PlayerId[] = ['p2', 'p3', 'p4']

export interface ResolvedPeerConfig {
  hasCustomServer: boolean
  allowPublicFallback: boolean
  customEndpointLabel: string
  customOptions: PeerJSOption
  publicOptions: PeerJSOption
}

/**
 * 讀取 Vite 環境變數並組裝 PeerJS 連線設定（含 STUN / TURN 擴充與公共伺服器 Fallback 設定）
 */
export function getPeerConfig(): ResolvedPeerConfig {
  const env = (import.meta.env ?? {}) as Record<string, string | undefined>

  const rawStunUrls = (env.VITE_STUN_URLS ?? '').trim()
  const stunUrls: string[] = rawStunUrls
    ? rawStunUrls
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
    : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']

  const iceServers: RTCIceServer[] = stunUrls.map((urls: string) => ({ urls }))

  const turnUrl = (env.VITE_TURN_URL || '').trim()
  if (turnUrl) {
    const turnEntry: RTCIceServer = { urls: turnUrl }
    if (env.VITE_TURN_USERNAME) {
      turnEntry.username = env.VITE_TURN_USERNAME.trim()
    }
    if (env.VITE_TURN_CREDENTIAL) {
      turnEntry.credential = env.VITE_TURN_CREDENTIAL.trim()
    }
    iceServers.push(turnEntry)
  }

  const publicOptions: PeerJSOption = {
    config: { iceServers },
  }

  const customHost = (env.VITE_PEER_HOST || '').trim()
  const hasCustomServer = customHost.length > 0
  const allowPublicFallback = (env.VITE_PEER_FALLBACK_PUBLIC || 'true').toLowerCase() !== 'false'

  if (!hasCustomServer) {
    return {
      hasCustomServer: false,
      allowPublicFallback: true,
      customEndpointLabel: 'PeerJS 官方公共信令',
      customOptions: publicOptions,
      publicOptions,
    }
  }

  const secure =
    env.VITE_PEER_SECURE !== undefined
      ? env.VITE_PEER_SECURE.toLowerCase() === 'true'
      : customHost !== 'localhost' && customHost !== '127.0.0.1'

  const port = env.VITE_PEER_PORT ? Number(env.VITE_PEER_PORT) : secure ? 443 : 9000
  const path = (env.VITE_PEER_PATH || '/signaling').trim()
  const key = (env.VITE_PEER_KEY || 'peerjs').trim()

  const customOptions: PeerJSOption = {
    host: customHost,
    port,
    path,
    secure,
    key,
    config: { iceServers },
  }

  return {
    hasCustomServer: true,
    allowPublicFallback,
    customEndpointLabel: `${customHost}:${port}${path}`,
    customOptions,
    publicOptions,
  }
}

function isSignalingServerReachabilityError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase()
  return (
    lower.includes('network') ||
    lower.includes('server-error') ||
    lower.includes('socket-error') ||
    lower.includes('socket-closed') ||
    lower.includes('lost connection to server') ||
    lower.includes('could not connect to peer')
  )
}

export class PeerJsAdapter implements PeerTransportPort {
  private peer: Peer | null = null
  private hostConn: DataConnection | null = null
  private clientConns = new Map<PlayerId, DataConnection>()
  private isLocked = false
  private resolvedConfig: ResolvedPeerConfig = getPeerConfig()
  private currentSignalingInfo: SignalingEndpointInfo
  private sink: MessageSink | null = null
  private holding = false
  private held: Array<{ msg: ProtocolMessage; from?: PlayerId }> = []

  holdMessages(): void {
    this.holding = true
  }

  setMessageSink(sink: MessageSink | null): void {
    this.sink = sink
    this.holding = false
    const pending = this.held
    this.held = []
    if (sink) for (const { msg, from } of pending) sink(msg, from)
  }

  /** 已被牌桌接管或暫存時回傳 true，呼叫端不再走大廳 callback */
  private route(msg: ProtocolMessage, from?: PlayerId): boolean {
    if (this.sink) {
      this.sink(msg, from)
      return true
    }
    if (this.holding) {
      this.held.push({ msg, from })
      return true
    }
    return false
  }

  constructor() {
    this.currentSignalingInfo = this.resolvedConfig.hasCustomServer
      ? {
          mode: 'custom',
          label: `自建信令 (${this.resolvedConfig.customEndpointLabel})`,
          host: this.resolvedConfig.customEndpointLabel,
        }
      : {
          mode: 'public',
          label: '公共信令池 (PeerJS Cloud)',
          host: '0.peerjs.com',
        }
  }

  getSignalingInfo(): SignalingEndpointInfo {
    return this.currentSignalingInfo
  }

  private setSignalingMode(mode: SignalingEndpointMode): SignalingEndpointInfo {
    if (mode === 'custom') {
      this.currentSignalingInfo = {
        mode: 'custom',
        label: `自建信令 (${this.resolvedConfig.customEndpointLabel})`,
        host: this.resolvedConfig.customEndpointLabel,
      }
    } else if (mode === 'fallback-public') {
      this.currentSignalingInfo = {
        mode: 'fallback-public',
        label: '公共信令池 (自建信令離線已自動回退)',
        host: '0.peerjs.com',
      }
    } else {
      this.currentSignalingInfo = {
        mode: 'public',
        label: '公共信令池 (PeerJS Cloud)',
        host: '0.peerjs.com',
      }
    }
    return this.currentSignalingInfo
  }

  private allocateGuestSlot(): PlayerId | null {
    for (const slotId of GUEST_SLOT_IDS) {
      if (!this.clientConns.has(slotId)) {
        return slotId
      }
    }
    return null
  }

  async hostRoomWithRetry(
    initialCode: string,
    callbacks: HostCallbacks,
    maxRetries = 4,
  ): Promise<string> {
    const useCustomFirst = this.resolvedConfig.hasCustomServer
    let usingPublicFallback = false

    let candidateCode = initialCode.trim().toUpperCase() || generateRoomCode()
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const options =
        useCustomFirst && !usingPublicFallback
          ? this.resolvedConfig.customOptions
          : this.resolvedConfig.publicOptions

      const info = this.setSignalingMode(
        useCustomFirst
          ? usingPublicFallback
            ? 'fallback-public'
            : 'custom'
          : 'public',
      )
      callbacks.onSignalingChanged?.(info)

      try {
        await this.tryOpenHostPeer(candidateCode, options, callbacks)
        return candidateCode
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)

        if (msg.includes('unavailable-id') && attempt < maxRetries) {
          candidateCode = generateRoomCode()
          continue
        }

        if (useCustomFirst && !usingPublicFallback && isSignalingServerReachabilityError(msg)) {
          if (this.resolvedConfig.allowPublicFallback) {
            usingPublicFallback = true
            attempt = -1
            continue
          }
          throw new Error(
            `無法連線至自建信令伺服器 (${this.resolvedConfig.customEndpointLabel})，請確認服務是否啟動`,
          )
        }

        throw err
      }
    }
    throw new Error('無法取得可用房號，請稍後再試')
  }

  private tryOpenHostPeer(
    roomCode: string,
    options: PeerJSOption,
    callbacks: HostCallbacks,
  ): Promise<void> {
    this.disconnect()
    this.isLocked = false

    return new Promise<void>((resolve, reject) => {
      const peer = new Peer(toPeerRoomId(roomCode), options)
      this.peer = peer

      let settled = false
      const openTimeoutId = setTimeout(() => {
        if (!settled) {
          settled = true
          this.disconnect()
          reject(new Error('network: 信令伺服器連線逾時'))
        }
      }, 6000)

      peer.once('open', () => {
        if (!settled) {
          settled = true
          clearTimeout(openTimeoutId)
          resolve()
        }
      })

      peer.on('error', (err) => {
        const errType = (err as { type?: string })?.type || ''
        const msg = errType ? `${errType}: ${err.message}` : err?.message || String(err)
        if (!settled) {
          settled = true
          clearTimeout(openTimeoutId)
          reject(new Error(msg))
        }
      })

      peer.on('connection', (conn) => {
        const slotId = this.allocateGuestSlot()
        if (this.isLocked || this.clientConns.size >= MAX_REMOTE_PEERS || !slotId) {
          conn.on('open', () => conn.close())
          setTimeout(() => conn.close(), 100)
          return
        }

        this.clientConns.set(slotId, conn)

        const markReady = () => {
          callbacks.onPeerConnected(slotId)
        }

        if (conn.open) {
          markReady()
        } else {
          conn.once('open', markReady)
        }

        conn.on('data', (data) => {
          if (!this.route(data as ProtocolMessage, slotId)) {
            callbacks.onPeerMessage(slotId, data as ProtocolMessage)
          }
        })

        conn.on('close', () => {
          if (this.clientConns.get(slotId) === conn) {
            this.clientConns.delete(slotId)
            callbacks.onPeerDisconnected(slotId)
          }
        })

        conn.on('error', () => {
          if (this.clientConns.get(slotId) === conn) {
            this.clientConns.delete(slotId)
            callbacks.onPeerDisconnected(slotId)
          }
        })
      })
    })
  }

  async joinRoom(roomCode: string, callbacks: ClientCallbacks): Promise<void> {
    const normalizedCode = roomCode.trim().toUpperCase()
    const useCustomFirst = this.resolvedConfig.hasCustomServer

    if (useCustomFirst) {
      const info = this.setSignalingMode('custom')
      callbacks.onSignalingChanged?.(info)
      try {
        await this.tryJoinRoomWithOptions(
          normalizedCode,
          this.resolvedConfig.customOptions,
          callbacks,
        )
        return
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (isSignalingServerReachabilityError(msg)) {
          if (this.resolvedConfig.allowPublicFallback) {
            const fallbackInfo = this.setSignalingMode('fallback-public')
            callbacks.onSignalingChanged?.(fallbackInfo)
            await this.tryJoinRoomWithOptions(
              normalizedCode,
              this.resolvedConfig.publicOptions,
              callbacks,
            )
            return
          }
          throw new Error(
            `自建信令伺服器 (${this.resolvedConfig.customEndpointLabel}) 離線或無法連線`,
          )
        }
        throw err
      }
    }

    const info = this.setSignalingMode('public')
    callbacks.onSignalingChanged?.(info)
    await this.tryJoinRoomWithOptions(normalizedCode, this.resolvedConfig.publicOptions, callbacks)
  }

  private tryJoinRoomWithOptions(
    roomCode: string,
    options: PeerJSOption,
    callbacks: ClientCallbacks,
  ): Promise<void> {
    this.disconnect()

    return new Promise<void>((resolve, reject) => {
      const peer = new Peer(options)
      this.peer = peer

      let settled = false
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true
          this.disconnect()
          reject(new Error('連線逾時：找不到該房號、房間已滿或牌局已開始'))
        }
      }, 10000)

      peer.on('error', (err) => {
        const errType = (err as { type?: string })?.type || ''
        const msg = errType ? `${errType}: ${err.message}` : err?.message || String(err)
        if (!settled) {
          settled = true
          clearTimeout(timeoutId)
          reject(
            new Error(
              msg.includes('peer-unavailable')
                ? '找不到該房號（或房主已開局鎖定房間）'
                : msg,
            ),
          )
        } else {
          callbacks.onDisconnected(msg)
        }
      })

      peer.once('open', () => {
        const conn = peer.connect(toPeerRoomId(roomCode), { reliable: true })
        this.hostConn = conn

        conn.on('error', (err) => {
          if (!settled) {
            settled = true
            clearTimeout(timeoutId)
            reject(err)
          }
        })

        const onOpen = () => {
          if (!settled) {
            settled = true
            clearTimeout(timeoutId)
            callbacks.onConnected()
            resolve()
          }
        }

        if (conn.open) {
          onOpen()
        } else {
          conn.once('open', onOpen)
        }

        conn.on('data', (data) => {
          if (!this.route(data as ProtocolMessage)) {
            callbacks.onMessage(data as ProtocolMessage)
          }
        })

        conn.on('close', () => {
          if (this.hostConn === conn) {
            this.hostConn = null
            callbacks.onDisconnected('與房主的連線已關閉（或房間人數已滿）')
          }
        })
      })
    })
  }

  sendToPeer(peerSlotId: PlayerId, msg: ProtocolMessage): void {
    const conn = this.clientConns.get(peerSlotId)
    if (conn && conn.open) {
      conn.send(msg)
    }
  }

  broadcast(msg: ProtocolMessage, excludePeerSlotId?: PlayerId): void {
    for (const [slotId, conn] of this.clientConns.entries()) {
      if (slotId !== excludePeerSlotId && conn.open) {
        conn.send(msg)
      }
    }
  }

  sendToHost(msg: ProtocolMessage): void {
    if (this.hostConn && this.hostConn.open) {
      this.hostConn.send(msg)
    }
  }

  /**
   * 房主開局後鎖定房間並斷開信令註冊（保留已建立的 WebRTC DataConnection），
   * 防止牌局進行中遭外部連入。
   */
  lockRoom(): void {
    this.isLocked = true
    if (this.peer && !this.peer.disconnected) {
      this.peer.disconnect()
    }
  }

  disconnect(): void {
    this.isLocked = false
    this.sink = null
    this.holding = false
    this.held = []
    for (const conn of this.clientConns.values()) {
      conn.close()
    }
    this.clientConns.clear()

    if (this.hostConn) {
      const conn = this.hostConn
      this.hostConn = null
      conn.close()
    }

    if (this.peer) {
      const p = this.peer
      this.peer = null
      p.destroy()
    }
  }
}

export function createPeerTransport(): PeerTransportPort {
  return new PeerJsAdapter()
}
