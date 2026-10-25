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
const statusText = ref('單機／自訂電腦席位模式（可隨時開啟 P2P 連線房）')
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
          statusText.value = `${peerSlotId.toUpperCase()} 已入座 ${windLabels[assigned]}家`
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
        statusText.value = `${peerSlotId.toUpperCase()} 已離線，座位恢復空位（可補電腦）`
        syncSnapshotToPeers()
      },
      onSignalingChanged: (info) => {
        statusText.value = `信令已連線：${info.label}`
      },
    })

    room.roomCode = finalCode
    p2pMode.value = 'hosting'
    localSeat.value = 0
    statusText.value = `房間已開啟！房號：${finalCode}（空位可自由配置電腦玩家）`
  } catch (err: unknown) {
    errorText.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function joinP2PRoom(): Promise<void> {
  const code = joinCodeInput.value.trim().toUpperCase()
  if (code.length < 4) {
    errorText.value = '請輸入有效的 6 碼房號'
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
        statusText.value = `已連入房號 ${code}，等待房主開局...`
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
  room.seats[0].name = playerName.value.trim() || '玩家東家'
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
  <div class="fixed inset-0 flex h-[100dvh] w-full items-center justify-center bg-emerald-950 p-4 select-none">
    <div class="w-full max-w-2xl rounded-3xl border border-amber-400/40 bg-emerald-900/85 p-6 shadow-2xl backdrop-blur">
      <!-- 標題列 -->
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-800 pb-4">
        <div>
          <h1 class="text-2xl font-black tracking-wider text-amber-300 sm:text-3xl">
            台灣 16 張麻將
          </h1>
          <p class="mt-0.5 text-xs text-emerald-200/85">{{ statusText }}</p>
        </div>

        <div class="flex items-center gap-2">
          <input
            v-model="playerName"
            type="text"
            maxlength="10"
            placeholder="玩家暱稱"
            class="w-32 rounded-xl border border-emerald-700 bg-emerald-950 px-3 py-1.5 text-sm font-semibold text-amber-100 focus:border-amber-400 focus:outline-none"
          />
          <span
            v-if="p2pMode !== 'solo'"
            class="rounded-xl border border-amber-400/50 bg-amber-500/20 px-3 py-1.5 font-mono text-sm font-black text-amber-300"
          >
            房號：{{ room.roomCode }}
          </span>
        </div>
      </div>

      <p v-if="errorText" class="mt-3 rounded-xl bg-rose-950/90 px-3 py-2 text-xs font-semibold text-rose-300">
        {{ errorText }}
      </p>

      <!-- 東南西北四家席位與電腦玩家開關 -->
      <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div
          v-for="slot in room.seats"
          :key="slot.seat"
          class="flex flex-col justify-between rounded-2xl border p-3 transition"
          :class="
            slot.occupant === 'human'
              ? 'border-amber-400/60 bg-emerald-950/90'
              : slot.occupant === 'bot'
                ? 'border-emerald-600/70 bg-emerald-950/75'
                : 'border-dashed border-emerald-700/60 bg-emerald-950/40'
          "
        >
          <div>
            <div class="flex items-center justify-between">
              <span class="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-extrabold text-amber-300">
                {{ windLabels[slot.seat] }}風席
              </span>
              <span
                class="text-[11px] font-semibold"
                :class="
                  slot.occupant === 'human'
                    ? 'text-amber-200'
                    : slot.occupant === 'bot'
                      ? 'text-emerald-300'
                      : 'text-slate-400'
                "
              >
                {{ slot.occupant === 'human' ? '真人' : slot.occupant === 'bot' ? '電腦 AI' : '空位' }}
              </span>
            </div>
            <p class="mt-2 truncate text-sm font-bold text-amber-50">
              {{ slot.seat === 0 && p2pMode !== 'joined' ? playerName || slot.name : slot.name }}
            </p>
          </div>

          <button
            v-if="slot.seat !== 0 && p2pMode !== 'joined' && slot.occupant !== 'human'"
            type="button"
            class="mt-3 w-full rounded-lg border py-1 text-xs font-bold transition cursor-pointer"
            :class="
              slot.occupant === 'bot'
                ? 'border-rose-400/40 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
                : 'border-emerald-400/50 bg-emerald-500/25 text-emerald-100 hover:bg-emerald-500/40'
            "
            @click="toggleBotSeat(slot.seat)"
          >
            {{ slot.occupant === 'bot' ? '移除電腦' : '+ 加入電腦' }}
          </button>
          <span v-else class="mt-3 block text-center text-[11px] text-emerald-400/80">
            ✓ 已就緒
          </span>
        </div>
      </div>

      <!-- 底台規則與攔胡設定 -->
      <div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-800/80 bg-emerald-950/60 px-4 py-2.5 text-xs">
        <div class="flex items-center gap-2">
          <span class="font-bold text-amber-300">底／台設定：</span>
          <button
            type="button"
            class="rounded-lg px-2.5 py-1 font-bold transition cursor-pointer"
            :class="
              room.rules.basePoints === 300
                ? 'bg-amber-500 text-emerald-950'
                : 'bg-emerald-900 text-emerald-200'
            "
            @click="
              room.rules.basePoints = 300;
              room.rules.taiPoints = 100
            "
          >
            300 / 100
          </button>
          <button
            type="button"
            class="rounded-lg px-2.5 py-1 font-bold transition cursor-pointer"
            :class="
              room.rules.basePoints === 100
                ? 'bg-amber-500 text-emerald-950'
                : 'bg-emerald-900 text-emerald-200'
            "
            @click="
              room.rules.basePoints = 100;
              room.rules.taiPoints = 20
            "
          >
            100 / 20
          </button>
        </div>

        <label class="flex items-center gap-2 font-semibold text-emerald-100 cursor-pointer">
          <input v-model="room.rules.allowMultiRon" type="checkbox" class="accent-amber-400" />
          允許一炮多響（未勾選則為標準逆時針攔胡）
        </label>
      </div>

      <!-- P2P 連線與加入房間操作區 -->
      <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div class="flex items-center gap-2 rounded-2xl border border-emerald-800/80 bg-emerald-950/50 p-2.5">
          <button
            type="button"
            :disabled="busy"
            class="flex-1 rounded-xl border border-amber-400/50 bg-emerald-800/80 px-3 py-2 text-xs font-bold text-amber-200 hover:bg-emerald-700 cursor-pointer"
            @click="hostP2PRoom"
          >
            {{ p2pMode === 'hosting' ? `已開房 (${room.roomCode})` : '建立 P2P 連線房' }}
          </button>
          <button
            type="button"
            class="rounded-xl border border-emerald-600 bg-emerald-900/80 px-3 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-800 cursor-pointer"
            @click="handleFillBots"
          >
            電腦補滿空位
          </button>
        </div>

        <div class="flex items-center gap-2 rounded-2xl border border-emerald-800/80 bg-emerald-950/50 p-2.5">
          <input
            v-model="joinCodeInput"
            type="text"
            maxlength="6"
            placeholder="輸入 6 碼房號"
            class="w-full rounded-xl border border-emerald-700 bg-emerald-950 px-3 py-2 font-mono text-xs uppercase text-amber-100 focus:border-amber-400 focus:outline-none"
          />
          <button
            type="button"
            :disabled="busy"
            class="shrink-0 rounded-xl bg-sky-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-sky-500 cursor-pointer"
            @click="joinP2PRoom"
          >
            加入房間
          </button>
        </div>
      </div>

      <!-- 立即開局按鈕 -->
      <div class="mt-5">
        <button
          v-if="p2pMode !== 'joined'"
          type="button"
          class="w-full rounded-2xl bg-gradient-to-r from-amber-500 via-amber-400 to-amber-500 py-3.5 text-lg font-black tracking-wide text-emerald-950 shadow-xl transition hover:brightness-105 cursor-pointer"
          @click="handleStartGame"
        >
          立即開局打牌（未滿席位自動由電腦補齊）
        </button>
        <div
          v-else
          class="w-full rounded-2xl border border-amber-400/40 bg-emerald-950/80 py-3 text-center text-sm font-bold text-amber-200"
        >
          已連線入座，等待房主按下開局...
        </div>
      </div>
    </div>
  </div>
</template>
