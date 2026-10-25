<script setup lang="ts">
import { onUnmounted, reactive, ref } from 'vue'
import type { ProtocolMessage, RoomSeatSlot, RuleConfig, SeatIndex } from '@/shared/kernel/types'
import {
  addBotToSeat,
  assignHumanToSeat,
  createRoomSession,
  fillEmptySeatsWithBots,
  handlePlayerDisconnect,
  isRoomReadyToStart,
  removeBotFromSeat,
} from '../domain/roomSession'
import { createPeerTransport, type PeerTransportPort } from '../infra/peerAdapter'

export interface StartMatchPayload {
  localSeat: SeatIndex
  isHost: boolean
  rules: RuleConfig
  roomSeats: [RoomSeatSlot, RoomSeatSlot, RoomSeatSlot, RoomSeatSlot]
  transport: PeerTransportPort | null
}

const emit = defineEmits<{
  startMatch: [payload: StartMatchPayload]
}>()

const playerName = ref('台灣雀神')
const joinCodeInput = ref('')
const p2pMode = ref<'solo' | 'hosting' | 'joined'>('solo')
const localSeat = ref<SeatIndex>(0)
const statusText = ref('單機／自選電腦牌友，或建立 P2P 連線')
const errorText = ref('')
const busy = ref(false)

const room = reactive(createRoomSession(playerName.value, true))
let transport: PeerTransportPort | null = null
let keepTransportOnUnmount = false

const windLabels: Record<SeatIndex, string> = { 0: '東', 1: '南', 2: '西', 3: '北' }

function syncSnapshotToPeers(): void {
  if (p2pMode.value === 'hosting' && transport) {
    transport.broadcast({
      type: 'ROOM_SNAPSHOT',
      roomCode: room.roomCode,
      seats: [...room.seats] as [RoomSeatSlot, RoomSeatSlot, RoomSeatSlot, RoomSeatSlot],
      rules: { ...room.rules },
    })
  }
}

function toggleBotSeat(seat: SeatIndex): void {
  if (p2pMode.value === 'joined') return
  const slot = room.seats[seat]
  if (slot.occupant === 'bot') {
    removeBotFromSeat(room, seat)
  } else if (slot.occupant === 'empty') {
    addBotToSeat(room, seat)
  }
  syncSnapshotToPeers()
}

function handleFillBots(): void {
  if (p2pMode.value === 'joined') return
  fillEmptySeatsWithBots(room)
  syncSnapshotToPeers()
}

async function hostP2PRoom(): Promise<void> {
  errorText.value = ''
  busy.value = true
  try {
    transport?.disconnect()
    transport = createPeerTransport()
    room.seats[0].name = playerName.value.trim() || '房主'

    const finalCode = await transport.hostRoomWithRetry(room.roomCode, {
      onPeerConnected: (peerSlotId) => {
        const assigned = assignHumanToSeat(room, peerSlotId, `玩家 ${peerSlotId.toUpperCase()}`)
        if (assigned !== null) {
          statusText.value = `${peerSlotId.toUpperCase()} 已入座 ${windLabels[assigned]}風`
          syncSnapshotToPeers()
        }
      },
      onPeerMessage: (_peerSlotId, msg: ProtocolMessage) => {
        if (msg.type === 'SEAT_UPDATE') {
          room.seats[msg.seat] = msg.slot
          syncSnapshotToPeers()
        }
      },
      onPeerDisconnected: (peerSlotId) => {
        handlePlayerDisconnect(room, peerSlotId, false)
        statusText.value = `${peerSlotId.toUpperCase()} 已離線`
        syncSnapshotToPeers()
      },
      onSignalingChanged: (info) => {
        statusText.value = `信令伺服器：${info.label}`
      },
    })

    room.roomCode = finalCode
    p2pMode.value = 'hosting'
    localSeat.value = 0
    statusText.value = `房間已就緒！房號：${finalCode}`
  } catch (err: unknown) {
    errorText.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function joinP2PRoom(): Promise<void> {
  const code = joinCodeInput.value.trim().toUpperCase()
  if (code.length < 4) {
    errorText.value = '請輸入正確的 6 碼房號'
    return
  }
  errorText.value = ''
  busy.value = true
  try {
    transport?.disconnect()
    transport = createPeerTransport()
    await transport.joinRoom(code, {
      onConnected: () => {
        p2pMode.value = 'joined'
        statusText.value = `已加入房號 ${code}，等待房主開局...`
      },
      onMessage: (msg: ProtocolMessage) => {
        if (msg.type === 'ROOM_SNAPSHOT') {
          room.roomCode = msg.roomCode
          room.seats = msg.seats
          room.rules = msg.rules
        } else if (msg.type === 'WALL_LOCKED') {
          keepTransportOnUnmount = true
          emit('startMatch', {
            localSeat: localSeat.value,
            isHost: false,
            rules: { ...room.rules },
            roomSeats: [...room.seats] as [RoomSeatSlot, RoomSeatSlot, RoomSeatSlot, RoomSeatSlot],
            transport,
          })
        }
      },
      onDisconnected: (reason) => {
        p2pMode.value = 'solo'
        errorText.value = reason ?? '與房主連線中斷'
      },
    })
  } catch (err: unknown) {
    errorText.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function handleStartGame(): void {
  room.seats[0].name = playerName.value.trim() || '本家'
  if (!isRoomReadyToStart(room)) {
    fillEmptySeatsWithBots(room)
  }
  if (p2pMode.value === 'hosting' && transport) {
    transport.lockRoom()
    syncSnapshotToPeers()
  }
  keepTransportOnUnmount = true
  emit('startMatch', {
    localSeat: localSeat.value,
    isHost: p2pMode.value !== 'joined',
    rules: { ...room.rules },
    roomSeats: [...room.seats] as [RoomSeatSlot, RoomSeatSlot, RoomSeatSlot, RoomSeatSlot],
    transport: p2pMode.value === 'solo' ? null : transport,
  })
}

onUnmounted(() => {
  if (!keepTransportOnUnmount && transport) {
    transport.disconnect()
  }
})
</script>

<template>
  <div class="fixed inset-0 flex h-[100dvh] w-full items-center justify-center p-3 sm:p-6 select-none" style="background: radial-gradient(circle at 50% 40%, var(--felt-in), var(--felt-out))">
    <div class="glass-card max-h-[94dvh] w-full max-w-2xl overflow-y-auto rounded-3xl p-5 sm:p-8 text-[var(--ivory)]">
      <!-- 頂部品牌與暱稱 -->
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-5">
        <div>
          <div class="flex items-center gap-2">
            <span class="rounded bg-[var(--accent)] px-2 py-0.5 text-xs font-black tracking-widest text-white">TW 16</span>
            <h1 class="text-2xl font-black tracking-wide text-[var(--gold)] sm:text-3xl">
              台灣 16 張麻將
            </h1>
          </div>
          <p class="mt-1 text-xs text-[var(--muted)]">{{ statusText }}</p>
        </div>

        <div class="flex items-center gap-2">
          <input
            v-model="playerName"
            type="text"
            maxlength="10"
            placeholder="你的暱稱"
            class="w-32 rounded-xl bg-white/5 border border-white/10 px-3 py-1.5 text-xs font-semibold text-[var(--ivory)] focus:border-[var(--gold)] focus:outline-none"
          />
          <span
            v-if="p2pMode !== 'solo'"
            class="rounded-xl border border-[var(--gold)]/40 bg-[var(--gold)]/10 px-3 py-1.5 font-mono text-xs font-black text-[var(--gold)]"
          >
            房號：{{ room.roomCode }}
          </span>
        </div>
      </div>

      <!-- 錯誤提示 -->
      <p v-if="errorText" class="mt-3 rounded-xl bg-rose-950/80 border border-rose-500/30 px-3 py-2 text-xs font-semibold text-rose-300">
        {{ errorText }}
      </p>

      <!-- 四位雀友席次 -->
      <div class="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div
          v-for="slot in room.seats"
          :key="slot.seat"
          class="flex flex-col justify-between rounded-2xl border p-3 transition"
          :class="
            slot.occupant === 'human'
              ? 'border-[var(--gold)]/60 bg-white/10'
              : slot.occupant === 'bot'
                ? 'border-white/10 bg-white/5'
                : 'border-dashed border-white/10 bg-black/20'
          "
        >
          <div>
            <div class="flex items-center justify-between">
              <span class="rounded bg-[var(--gold)]/20 px-2 py-0.5 text-xs font-black text-[var(--gold)]">
                {{ windLabels[slot.seat] }}風
              </span>
              <span
                class="text-[11px] font-semibold"
                :class="
                  slot.occupant === 'human'
                    ? 'text-[var(--gold)]'
                    : slot.occupant === 'bot'
                      ? 'text-[var(--muted)]'
                      : 'text-white/30'
                "
              >
                {{ slot.occupant === 'human' ? '真人' : slot.occupant === 'bot' ? '電腦' : '空席' }}
              </span>
            </div>
            <p class="mt-2.5 truncate text-sm font-bold text-[var(--ivory)]">
              {{ slot.seat === 0 && p2pMode !== 'joined' ? playerName || slot.name : slot.name }}
            </p>
          </div>

          <button
            v-if="slot.seat !== 0 && p2pMode !== 'joined' && slot.occupant !== 'human'"
            type="button"
            class="mt-3 w-full rounded-xl py-1 text-xs font-bold transition cursor-pointer"
            :class="
              slot.occupant === 'bot'
                ? 'bg-rose-950/40 border border-rose-500/30 text-rose-300 hover:bg-rose-900/60'
                : 'bg-white/10 border border-white/15 text-[var(--ivory)] hover:bg-white/20'
            "
            @click="toggleBotSeat(slot.seat)"
          >
            {{ slot.occupant === 'bot' ? '移除電腦' : '+ 電腦入座' }}
          </button>
          <span v-else class="mt-3 block text-center text-[11px] text-[var(--gold)]/80">
            ✓ 就緒
          </span>
        </div>
      </div>

      <!-- 規則設置 -->
      <div class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/5 border border-white/5 px-4 py-3 text-xs">
        <div class="flex items-center gap-2">
          <span class="font-bold text-[var(--muted)]">底／台：</span>
          <button
            type="button"
            class="rounded-xl px-3 py-1 font-bold transition cursor-pointer"
            :class="
              room.rules.basePoints === 300
                ? 'bg-[var(--gold)] text-slate-950 shadow'
                : 'bg-white/10 text-[var(--ivory)]'
            "
            @click="room.rules.basePoints = 300; room.rules.taiPoints = 100"
          >
            300 / 100
          </button>
          <button
            type="button"
            class="rounded-xl px-3 py-1 font-bold transition cursor-pointer"
            :class="
              room.rules.basePoints === 100
                ? 'bg-[var(--gold)] text-slate-950 shadow'
                : 'bg-white/10 text-[var(--ivory)]'
            "
            @click="room.rules.basePoints = 100; room.rules.taiPoints = 20"
          >
            100 / 20
          </button>
        </div>

        <label class="flex items-center gap-2 font-medium text-[var(--ivory)] cursor-pointer">
          <input v-model="room.rules.allowMultiRon" type="checkbox" class="accent-[var(--accent)]" />
          允許一炮多響
        </label>
      </div>

      <!-- P2P 連線 / 開房 / 加入操作 -->
      <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="flex items-center gap-2 rounded-2xl bg-white/5 border border-white/5 p-2">
          <button
            type="button"
            :disabled="busy"
            class="flex-1 rounded-xl bg-white/10 hover:bg-white/15 px-3 py-2 text-xs font-bold text-[var(--gold)] transition cursor-pointer"
            @click="hostP2PRoom"
          >
            {{ p2pMode === 'hosting' ? `已開房 (${room.roomCode})` : '📡 建立連線房' }}
          </button>
          <button
            type="button"
            class="rounded-xl bg-white/10 hover:bg-white/15 px-3 py-2 text-xs font-bold text-[var(--ivory)] transition cursor-pointer"
            @click="handleFillBots"
          >
            補滿電腦
          </button>
        </div>

        <div class="flex items-center gap-2 rounded-2xl bg-white/5 border border-white/5 p-2">
          <input
            v-model="joinCodeInput"
            type="text"
            maxlength="6"
            placeholder="輸入 6 碼房號"
            class="w-full rounded-xl bg-black/20 border border-white/10 px-3 py-2 font-mono text-xs uppercase text-[var(--ivory)] focus:border-[var(--gold)] focus:outline-none"
          />
          <button
            type="button"
            :disabled="busy"
            class="shrink-0 rounded-xl bg-sky-600 hover:bg-sky-500 px-4 py-2 text-xs font-bold text-white transition cursor-pointer"
            @click="joinP2PRoom"
          >
            加入
          </button>
        </div>
      </div>

      <!-- 開局大按鈕 -->
      <div class="mt-6">
        <button
          v-if="p2pMode !== 'joined'"
          type="button"
          class="w-full rounded-2xl bg-gradient-to-r from-[var(--gold)] via-amber-400 to-[var(--gold)] py-3.5 text-base font-black tracking-wide text-slate-950 shadow-xl transition hover:brightness-110 active:scale-[0.99] cursor-pointer"
          @click="handleStartGame"
        >
          立即開局（未滿席位自動由電腦補齊）
        </button>
        <div
          v-else
          class="w-full rounded-2xl bg-white/5 border border-[var(--gold)]/30 py-3 text-center text-xs font-bold text-[var(--gold)]"
        >
          已連入房間，等待房主開局...
        </div>
      </div>
    </div>
  </div>
</template>
