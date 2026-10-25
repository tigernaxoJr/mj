<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import Phaser from 'phaser'
import type { PlayerActionCommand, RoomSeatSlot, RuleConfig, SeatIndex, TileId } from '@/shared/kernel/types'
import { isAudioMuted, setAudioMuted } from '@/features/audio'
import type { PeerTransportPort } from '@/features/lobby/infra/peerAdapter'
import { useTableSession } from '../application/useTableSession'
import { TableScene } from '../engine/TableScene'
import ActionHud from './ActionHud.vue'
import SettlementModal from './SettlementModal.vue'

const props = defineProps<{
  localSeat?: SeatIndex
  isHost?: boolean
  rules?: RuleConfig
  roomSeats?: readonly RoomSeatSlot[]
  transport?: PeerTransportPort | null
}>()

const emit = defineEmits<{
  leaveTable: []
}>()

const canvasHost = ref<HTMLDivElement | null>(null)
const muted = ref(isAudioMuted())
let game: Phaser.Game | null = null
let tableScene: TableScene | null = null

const {
  state,
  localSeat,
  selfTurnOptions,
  localClaimEntry,
  waitingKinds,
  migiSelectMode,
  selectedTileId,
  initAndStartRound,
  startNextRound,
  dispatchAction,
} = useTableSession({
  localSeat: props.localSeat ?? 0,
  isHost: props.isHost ?? true,
  rules: props.rules,
  roomSeats: props.roomSeats,
  transport: props.transport ?? null,
})

const windChars: Record<SeatIndex, string> = { 0: '東', 1: '南', 2: '西', 3: '北' }

function syncScene(): void {
  if (!tableScene) return
  tableScene.syncState(
    state,
    localSeat.value,
    selectedTileId.value,
    migiSelectMode.value,
    selfTurnOptions.value.migiDiscardableTiles,
  )
}

function onSelectTile(tileId: TileId | null): void {
  selectedTileId.value = tileId
  syncScene()
}

function onDiscardTile(tileId: TileId): void {
  if (migiSelectMode.value) {
    dispatchAction(localSeat.value, { type: 'DECLARE_MIGI', discardTileId: tileId })
  } else {
    dispatchAction(localSeat.value, { type: 'DISCARD', tileId })
  }
  syncScene()
}

function onHudAction(cmd: PlayerActionCommand): void {
  dispatchAction(localSeat.value, cmd)
  syncScene()
}

function toggleMute(): void {
  muted.value = !muted.value
  setAudioMuted(muted.value)
}

watch(
  () => [
    state.phase,
    state.currentSeat,
    state.headCursor,
    state.tailCursor,
    state.calloutSeq,
    selectedTileId.value,
    migiSelectMode.value,
  ],
  () => {
    syncScene()
  },
  { deep: true },
)

onMounted(async () => {
  if (canvasHost.value) {
    tableScene = new TableScene()
    tableScene.bindCallbacks({
      onSelectTile,
      onDiscardTile,
    })
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: canvasHost.value,
      width: canvasHost.value.clientWidth || window.innerWidth,
      height: canvasHost.value.clientHeight || window.innerHeight,
      backgroundColor: '#042f2e',
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: [tableScene],
    })
  }
  await initAndStartRound()
  syncScene()
})

onUnmounted(() => {
  if (game) {
    game.destroy(true)
    game = null
    tableScene = null
  }
})
</script>

<template>
  <div class="fixed inset-0 h-[100dvh] w-full overflow-hidden bg-emerald-950 select-none">
    <!-- Phaser 3 全畫面牌桌畫布 -->
    <div ref="canvasHost" class="absolute inset-0 h-full w-full" />

    <!-- 四角街機駕駛艙玩家資訊與頂部控制列 -->
    <header class="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-1 px-2 py-1.5 sm:px-4 sm:py-2.5">
      <div class="pointer-events-auto flex items-center gap-1.5 rounded-xl border border-amber-400/30 bg-emerald-950/85 px-2.5 py-1 text-[11px] sm:px-3 sm:py-1.5 sm:text-xs shadow backdrop-blur">
        <span class="font-bold text-amber-300">台灣 16 張</span>
        <span class="hidden sm:inline text-emerald-300">|</span>
        <span class="hidden sm:inline text-emerald-100">底 {{ state.rules.basePoints }} / 台 {{ state.rules.taiPoints }}</span>
      </div>

      <!-- 對家資訊卡 -->
      <div class="rounded-xl border border-emerald-700/70 bg-emerald-950/85 px-2.5 py-1 text-[11px] sm:px-3 sm:text-xs text-amber-100 shadow backdrop-blur">
        <span class="font-bold text-amber-300">
          {{ windChars[(((localSeat + 2) % 4 + 4 - state.dealerSeat) % 4) as SeatIndex] }}家
        </span>
        · {{ state.seats[((localSeat + 2) % 4) as SeatIndex].name }}
        <span class="ml-1 font-mono text-emerald-300">
          ${{ state.seats[((localSeat + 2) % 4) as SeatIndex].score }}
        </span>
      </div>

      <div class="pointer-events-auto flex items-center gap-1.5 sm:gap-2">
        <button
          type="button"
          class="rounded-xl border border-emerald-700 bg-emerald-950/85 px-2 py-1 text-[11px] sm:px-3 sm:py-1.5 sm:text-xs font-semibold text-amber-200 hover:bg-emerald-900 cursor-pointer"
          @click="toggleMute"
        >
          {{ muted ? '🔇' : '🔊' }}<span class="hidden sm:inline"> {{ muted ? '靜音' : '音效' }}</span>
        </button>
        <button
          type="button"
          class="rounded-xl border border-rose-500/40 bg-emerald-950/85 px-2 py-1 text-[11px] sm:px-3 sm:py-1.5 sm:text-xs font-semibold text-rose-200 hover:bg-rose-950 cursor-pointer"
          @click="emit('leaveTable')"
        >
          離開
        </button>
      </div>
    </header>

    <!-- 左右家資訊徽章 -->
    <div class="pointer-events-none absolute left-1.5 top-12 sm:left-3 sm:top-1/2 z-20 sm:-translate-y-1/2 rounded-xl border border-emerald-700/70 bg-emerald-950/85 px-2 py-1 sm:px-2.5 sm:py-2 text-[10px] sm:text-xs text-amber-100 shadow backdrop-blur">
      <p class="font-bold text-amber-300">
        {{ windChars[(((localSeat + 3) % 4 + 4 - state.dealerSeat) % 4) as SeatIndex] }}家<span class="hidden sm:inline">（上家）</span>
      </p>
      <p class="mt-0.5 truncate max-w-16 sm:max-w-24">{{ state.seats[((localSeat + 3) % 4) as SeatIndex].name }}</p>
      <p class="font-mono text-emerald-300">${{ state.seats[((localSeat + 3) % 4) as SeatIndex].score }}</p>
    </div>

    <div class="pointer-events-none absolute right-1.5 top-12 sm:right-3 sm:top-1/2 z-20 sm:-translate-y-1/2 rounded-xl border border-emerald-700/70 bg-emerald-950/85 px-2 py-1 sm:px-2.5 sm:py-2 text-right text-[10px] sm:text-xs text-amber-100 shadow backdrop-blur">
      <p class="font-bold text-amber-300">
        {{ windChars[(((localSeat + 1) % 4 + 4 - state.dealerSeat) % 4) as SeatIndex] }}家<span class="hidden sm:inline">（下家）</span>
      </p>
      <p class="mt-0.5 truncate max-w-16 sm:max-w-24">{{ state.seats[((localSeat + 1) % 4) as SeatIndex].name }}</p>
      <p class="font-mono text-emerald-300">${{ state.seats[((localSeat + 1) % 4) as SeatIndex].score }}</p>
    </div>

    <!-- 本家底部浮動操作 HUD 與本家分數徽章 -->
    <footer class="pointer-events-none absolute inset-x-0 bottom-32 sm:bottom-24 z-30 flex flex-col items-center px-2 sm:px-4">
      <ActionHud
        :is-my-turn="state.phase === 'TURN_ACTION_OR_DISCARD' && state.currentSeat === localSeat"
        :self-options="selfTurnOptions"
        :claim-entry="localClaimEntry"
        :waiting-kinds="waitingKinds"
        :selected-tile-id="selectedTileId"
        :migi-select-mode="migiSelectMode"
        :discarded-tile="state.lastDiscard?.tileId ?? null"
        @action="onHudAction"
        @toggle-migi-mode="migiSelectMode = !migiSelectMode"
      />
    </footer>

    <div class="pointer-events-none absolute bottom-1.5 left-2 sm:bottom-3 sm:left-4 z-20 rounded-xl border border-amber-400/40 bg-emerald-950/90 px-2.5 py-1 sm:px-3 sm:py-1.5 text-[11px] sm:text-xs text-amber-100 shadow backdrop-blur">
      <span class="font-bold text-amber-300">
        {{ windChars[((localSeat + 4 - state.dealerSeat) % 4) as SeatIndex] }}家（本家）
      </span>
      · {{ state.seats[localSeat].name }}
      <span class="ml-1.5 font-mono font-bold text-emerald-300">${{ state.seats[localSeat].score }}</span>
      <span class="ml-1.5 text-[10px] sm:text-[11px] text-amber-200/70">（點選看聽牌，再點打出）</span>
    </div>

    <!-- 結算彈窗 -->
    <SettlementModal
      :state="state"
      @next-round="startNextRound"
      @back-to-lobby="emit('leaveTable')"
    />
  </div>
</template>
