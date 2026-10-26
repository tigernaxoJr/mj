<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from 'vue'
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
  /** 客機：房主首局牌山種子（來自 WALL_LOCKED），用來重現相同牌山 */
  initialRound?: { roundSeed: string; hostSecret: string }
}

const emit = defineEmits<{
  startMatch: [payload: StartMatchPayload]
}>()

const playerName = ref('台灣雀神')
const joinCodeInput = ref('')
const p2pMode = ref<'solo' | 'hosting' | 'joined'>('solo')
const localSeat = ref<SeatIndex>(0)
const statusText = ref('選好座位與底台，按「開局」開始')
const errorText = ref('')
const busy = ref(false)

const room = reactive(createRoomSession(playerName.value, true))
let transport: PeerTransportPort | null = null
let keepTransportOnUnmount = false

const windLabels: Record<SeatIndex, string> = { 0: '東', 1: '南', 2: '西', 3: '北' }

type LobbyTab = 'solo' | 'host' | 'join'
const tab = ref<LobbyTab>('solo')
const copied = ref(false)
const tabs: { id: LobbyTab; label: string }[] = [
  { id: 'solo', label: '單機對戰' },
  { id: 'host', label: '開房邀友' },
  { id: 'join', label: '加入房間' },
]
/** 迷你牌桌九宮格：本家（東）在下，下家（南）在右，對家（西）在上，上家（北）在左 */
const seatGrid: Record<SeatIndex, string> = {
  0: 'col-start-2 row-start-3',
  1: 'col-start-3 row-start-2',
  2: 'col-start-2 row-start-1',
  3: 'col-start-1 row-start-2',
}
const heroTiles = [27, 31, 32, 0, 9]

const stakeOptions = [
  { base: 300, tai: 100 },
  { base: 100, tai: 20 },
]

function setStake(base: number, tai: number): void {
  room.rules.basePoints = base
  room.rules.taiPoints = tai
  syncSnapshotToPeers()
}

function seatEditable(slot: RoomSeatSlot): boolean {
  return slot.seat !== 0 && p2pMode.value !== 'joined' && slot.occupant !== 'human'
}

function seatHint(slot: RoomSeatSlot): string {
  if (slot.seat === localSeat.value) return '你'
  if (slot.occupant === 'human') return '真人'
  if (slot.occupant === 'bot') return seatEditable(slot) ? '點擊移除' : '電腦'
  return seatEditable(slot) ? '點擊加電腦' : '等待中'
}

const footerNote = computed(() =>
  tab.value === 'join' && p2pMode.value === 'solo' ? '輸入好友分享的 6 碼房號後按「加入」' : statusText.value,
)

function selectTab(next: LobbyTab): void {
  if (p2pMode.value !== 'solo') return
  tab.value = next
  errorText.value = ''
}

async function copyRoomCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(room.roomCode)
    copied.value = true
    setTimeout(() => (copied.value = false), 1600)
  } catch {
    copied.value = false
  }
}

function syncSnapshotToPeers(): void {
  if (p2pMode.value === 'hosting' && transport) {
    transport.broadcast({
      type: 'ROOM_SNAPSHOT',
      roomCode: room.roomCode,
      seats: [...room.seats] as [RoomSeatSlot, RoomSeatSlot, RoomSeatSlot, RoomSeatSlot],
      rules: { ...room.rules },
    })
    // 客機不知道自己的座位，由房主逐一告知
    for (const slot of room.seats) {
      if (slot.occupant === 'human' && slot.playerId && slot.seat !== 0) {
        transport.sendToPeer(slot.playerId, { type: 'SEAT_ASSIGNED', seat: slot.seat })
      }
    }
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
        } else if (msg.type === 'SEAT_ASSIGNED') {
          localSeat.value = msg.seat
        } else if (msg.type === 'WALL_LOCKED') {
          keepTransportOnUnmount = true
          // 牌桌掛載前先暫存後續訊息，避免漏接房主的出牌
          transport?.holdMessages()
          emit('startMatch', {
            initialRound: { roundSeed: msg.roundSeed, hostSecret: msg.hostSecret },
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
  <div class="wood-bg fixed inset-0 h-[100dvh] w-full overflow-hidden select-none">
    <div class="scroll-thin flex h-full w-full overflow-y-auto">
    <div
      class="m-auto flex w-full max-w-6xl flex-col gap-4 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-8 lg:flex-row lg:items-center lg:gap-14 lg:py-10 short:gap-2 short:py-2"
    >
      <!-- 品牌主視覺 -->
      <section class="flex shrink-0 items-center gap-4 short:gap-3 lg:flex-1 lg:flex-col lg:items-start lg:gap-10">
        <div class="relative ml-3 h-16 w-24 shrink-0 short:hidden sm:h-20 sm:w-28 lg:order-2 lg:ml-0 lg:h-44 lg:w-80" aria-hidden="true">
          <img
            v-for="(k, i) in heroTiles"
            :key="k"
            :src="`assets/tiles/tile_${k}.png`"
            alt=""
            class="hero-tile"
            :style="{ '--i': i - 2 }"
          />
        </div>
        <div class="min-w-0 lg:order-1 short:flex short:items-baseline short:gap-3">
          <p class="whitespace-nowrap text-[10px] font-bold tracking-[0.25em] text-[var(--brass)] short:hidden sm:text-[11px] sm:tracking-[0.35em] lg:text-xs">TAIWAN · 16 TILES</p>
          <h1 class="brass-text mt-1 font-serif text-3xl font-black leading-tight tracking-wider short:mt-0 short:text-2xl sm:text-4xl lg:text-7xl">
            台灣十六張
          </h1>
          <p class="mt-1 text-xs text-[var(--muted)] sm:text-sm lg:mt-4 lg:max-w-md lg:text-base lg:leading-relaxed">
            單機陪練電腦牌友，或開房邀好友 P2P 直連<span class="hidden lg:inline">——洗牌以雙方種子承諾鎖定，結算可驗證，不需伺服器</span>。
          </p>
          <ul class="mt-6 hidden gap-6 text-sm text-[var(--muted)] lg:flex">
            <li class="flex items-center gap-2"><span class="dot bg-[var(--jade)]" />向聽數 AI</li>
            <li class="flex items-center gap-2"><span class="dot bg-[var(--brass)]" />完整台數</li>
            <li class="flex items-center gap-2"><span class="dot bg-[var(--cinnabar)]" />防作弊洗牌</li>
          </ul>
        </div>
      </section>

      <!-- 開局設定 -->
      <section class="panel w-full shrink-0 rounded-[26px] p-4 sm:p-6 lg:w-[480px] short:grid short:grid-cols-2 short:gap-x-5 short:p-4">
        <div>
        <!-- 暱稱 -->
        <div class="flex items-center gap-3">
          <label for="nick" class="shrink-0 text-xs font-bold text-[var(--muted)]">暱稱</label>
          <input
            id="nick"
            v-model="playerName"
            type="text"
            maxlength="10"
            placeholder="你的暱稱"
            :disabled="p2pMode === 'joined'"
            class="field h-10 min-w-0 flex-1 rounded-xl px-3 text-sm font-bold"
          />
        </div>

        <!-- 迷你牌桌：座位 -->
        <div class="mt-4 grid grid-cols-3 grid-rows-3 gap-1.5 sm:gap-2 short:mt-2.5 short:gap-1!" role="group" aria-label="座位">
          <div class="mini-felt col-start-2 row-start-2 grid place-items-center rounded-2xl text-center">
            <div>
              <p class="font-serif text-lg font-black text-[var(--brass-hi)] sm:text-xl">
                {{ room.rules.basePoints }}<span class="mx-0.5 text-xs text-[var(--muted)]">/</span>{{ room.rules.taiPoints }}
              </p>
              <p class="text-[10px] text-[var(--muted)]">底 / 台</p>
            </div>
          </div>
          <component
            :is="seatEditable(slot) ? 'button' : 'div'"
            v-for="slot in room.seats"
            :key="slot.seat"
            :type="seatEditable(slot) ? 'button' : undefined"
            class="seat"
            :class="[seatGrid[slot.seat], `seat-${slot.occupant}`, slot.seat === localSeat && 'seat-me']"
            :aria-label="`${windLabels[slot.seat]}位：${slot.occupant === 'empty' ? '空位，點擊加入電腦' : slot.name}`"
            @click="seatEditable(slot) && toggleBotSeat(slot.seat)"
          >
            <span class="seal" :class="slot.seat === 0 && 'seal-dealer'">{{ windLabels[slot.seat] }}</span>
            <span class="min-w-0 max-w-full text-center sm:flex-1 sm:text-left short:flex-none! short:text-center!">
              <span class="block truncate text-xs font-bold sm:text-sm">
                {{ slot.occupant === 'empty' ? '空位' : slot.seat === 0 && p2pMode !== 'joined' ? playerName || slot.name : slot.name }}
              </span>
              <span class="block truncate text-[10px] text-[var(--muted)] short:hidden">{{ seatHint(slot) }}</span>
            </span>
          </component>
        </div>

        </div>

        <div>
        <!-- 規則 -->
        <div class="mt-4 short:mt-0 flex flex-wrap items-center justify-between gap-3">
          <div class="seg" role="radiogroup" aria-label="底台">
            <button
              v-for="opt in stakeOptions"
              :key="opt.base"
              type="button"
              role="radio"
              :aria-checked="room.rules.basePoints === opt.base"
              :disabled="p2pMode === 'joined'"
              @click="setStake(opt.base, opt.tai)"
            >
              {{ opt.base }} / {{ opt.tai }}
            </button>
          </div>
          <label class="flex cursor-pointer items-center gap-2 text-xs font-bold text-[var(--ivory)]">
            <input
              v-model="room.rules.allowMultiRon"
              type="checkbox"
              class="peer sr-only"
              :disabled="p2pMode === 'joined'"
              @change="syncSnapshotToPeers"
            />
            <span class="switch" aria-hidden="true" />
            一炮多響
          </label>
        </div>

        <!-- 模式 -->
        <div class="mt-5 short:mt-3 grid grid-cols-3 rounded-2xl bg-black/30 p-1" role="tablist" aria-label="遊戲模式">
          <button
            v-for="t in tabs"
            :key="t.id"
            type="button"
            role="tab"
            :aria-selected="tab === t.id"
            :disabled="p2pMode !== 'solo' && tab !== t.id"
            class="tab"
            @click="selectTab(t.id)"
          >
            {{ t.label }}
          </button>
        </div>

        <div class="mt-3 flex min-h-[72px] short:min-h-[60px] short:mt-2 items-center rounded-2xl border border-white/5 bg-black/20 p-3">
          <div v-if="tab === 'solo'" class="flex w-full items-center justify-between gap-3">
            <p class="text-xs leading-relaxed text-[var(--muted)]">與電腦牌友對戰；點座位增減電腦，空位開局時自動補齊。</p>
            <button type="button" class="btn-ghost h-9 shrink-0 rounded-xl px-3 text-xs font-bold" @click="handleFillBots">
              補滿電腦
            </button>
          </div>

          <template v-else-if="tab === 'host'">
            <div v-if="p2pMode === 'hosting'" class="flex w-full items-center justify-between gap-3">
              <div>
                <p class="text-[10px] font-bold tracking-widest text-[var(--muted)]">房號 · 分享給好友</p>
                <p class="font-mono text-2xl font-black tracking-[0.25em] text-[var(--brass-hi)]">{{ room.roomCode }}</p>
              </div>
              <button type="button" class="btn-ghost h-9 shrink-0 rounded-xl px-3 text-xs font-bold" @click="copyRoomCode">
                {{ copied ? '已複製 ✓' : '複製房號' }}
              </button>
            </div>
            <div v-else class="flex w-full items-center justify-between gap-3">
              <p class="text-xs leading-relaxed text-[var(--muted)]">建立 6 碼房號，好友輸入後即入座；未滿座位由電腦補上。</p>
              <button
                type="button"
                :disabled="busy"
                class="btn-brass h-9 shrink-0 rounded-xl px-4 text-xs font-black disabled:opacity-60"
                @click="hostP2PRoom"
              >
                {{ busy ? '連線中…' : '建立房間' }}
              </button>
            </div>
          </template>

          <template v-else>
            <div v-if="p2pMode === 'joined'" class="flex w-full items-center gap-3">
              <span class="pulse-dot" aria-hidden="true" />
              <p class="text-xs text-[var(--ivory)]">
                已加入 <b class="font-mono text-[var(--brass-hi)]">{{ room.roomCode }}</b>，等待房主開局…
              </p>
            </div>
            <form v-else class="flex w-full items-center gap-2" @submit.prevent="joinP2PRoom">
              <input
                v-model="joinCodeInput"
                type="text"
                maxlength="6"
                autocapitalize="characters"
                autocomplete="off"
                placeholder="輸入 6 碼房號"
                aria-label="房號"
                class="field h-10 min-w-0 flex-1 rounded-xl px-3 font-mono text-sm font-bold uppercase tracking-[0.2em]"
              />
              <button type="submit" :disabled="busy" class="btn-brass h-10 shrink-0 rounded-xl px-5 text-sm font-black disabled:opacity-60">
                {{ busy ? '…' : '加入' }}
              </button>
            </form>
          </template>
        </div>

        <p
          v-if="errorText"
          role="alert"
          class="mt-3 rounded-xl border border-[var(--cinnabar)]/40 bg-[var(--cinnabar)]/10 px-3 py-2 text-xs font-bold text-[#ffb4a3]"
        >
          {{ errorText }}
        </p>

        <!-- 開局 -->
        <button
          v-if="p2pMode !== 'joined' && tab !== 'join'"
          type="button"
          class="btn-brass mt-4 short:mt-3 short:h-12 flex h-14 w-full items-center justify-center rounded-2xl font-serif text-lg font-black tracking-[0.4em] transition active:scale-[0.99]"
          @click="handleStartGame"
        >
          開局
        </button>
        <p class="mt-2 truncate text-center text-[11px] text-[var(--faint)]" aria-live="polite">{{ footerNote }}</p>
        </div>
      </section>
    </div>
    </div>
  </div>
</template>

<style scoped>
@reference '../../../style.css';

.hero-tile {
  position: absolute;
  left: 50%;
  bottom: 0;
  height: 100%;
  width: auto;
  transform-origin: 50% 130%;
  transform: translateX(-50%) rotate(calc(var(--i) * 12deg));
  filter: drop-shadow(0 10px 14px rgba(0, 0, 0, 0.55));
  animation: fan-in 0.7s cubic-bezier(0.2, 0.9, 0.3, 1.2) both;
  animation-delay: calc((var(--i) + 2) * 60ms);
}
@keyframes fan-in {
  from {
    transform: translateX(-50%) rotate(0deg) translateY(20%);
    opacity: 0;
  }
}
.dot {
  @apply inline-block size-2 rounded-full;
}
.mini-felt {
  background: radial-gradient(circle at 50% 40%, var(--felt-in), var(--felt-out));
  box-shadow:
    inset 0 0 0 1px rgba(212, 166, 74, 0.35),
    inset 0 6px 18px rgba(0, 0, 0, 0.45);
}
.seat {
  @apply flex min-h-14 short:min-h-0 short:py-1! min-w-0 flex-col items-center justify-center gap-1 rounded-2xl border px-1.5 py-2 text-[var(--ivory)] transition sm:min-h-16 sm:flex-row sm:gap-2 sm:px-2.5 short:flex-col! short:gap-0.5!;
}
button.seat:active {
  transform: scale(0.97);
}
.seat-empty {
  @apply border-dashed border-white/15 bg-black/15 text-[var(--muted)];
}
button.seat-empty:hover {
  @apply border-[var(--brass)]/60 bg-white/5;
}
.seat-bot {
  @apply border-white/10 bg-white/[0.04];
}
button.seat-bot:hover {
  @apply border-[var(--cinnabar)]/50;
}
.seat-human {
  @apply border-[var(--jade)]/50 bg-[var(--jade)]/10;
}
.seat-me {
  @apply border-[var(--brass)]/70 bg-[var(--brass)]/10;
}
.seal {
  @apply grid size-7 shrink-0 place-items-center rounded-lg font-serif text-sm font-black sm:size-8 sm:text-base;
  background: #2a1b12;
  color: var(--ivory);
  box-shadow: inset 0 0 0 1px rgba(212, 166, 74, 0.35);
}
.seal-dealer {
  background: var(--cinnabar);
  color: #fff;
  box-shadow: inset 0 0 0 1px rgba(255, 220, 200, 0.5);
}
.seg {
  @apply flex rounded-xl bg-black/30 p-1;
}
.seg button {
  @apply h-8 rounded-lg px-3 text-xs font-bold text-[var(--muted)] transition;
}
.seg button[aria-checked='true'] {
  @apply bg-[var(--brass)] text-[#2a1a07] shadow;
}
.switch {
  @apply relative inline-block h-5 w-9 shrink-0 rounded-full bg-white/15 transition;
}
.switch::after {
  content: '';
  @apply absolute left-0.5 top-0.5 size-4 rounded-full bg-[var(--ivory)] transition;
}
.peer:checked + .switch {
  background: var(--jade);
}
.peer:checked + .switch::after {
  transform: translateX(16px);
}
.peer:focus-visible + .switch {
  outline: 2px solid var(--brass-hi);
  outline-offset: 2px;
}
.tab {
  @apply h-9 rounded-xl text-xs font-bold text-[var(--muted)] transition sm:text-sm;
}
.tab[aria-selected='true'] {
  @apply bg-[var(--panel-solid)] text-[var(--brass-hi)];
  box-shadow: inset 0 0 0 1px rgba(212, 166, 74, 0.35);
}
.tab:disabled {
  @apply opacity-40;
}
.pulse-dot {
  @apply inline-block size-2.5 shrink-0 rounded-full bg-[var(--jade)];
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.3;
    transform: scale(0.7);
  }
}
</style>
