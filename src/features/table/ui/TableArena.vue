<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
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
const handZoneHeight = ref(120)
let game: Phaser.Game | null = null
let tableScene: TableScene | null = null

const {
  state,
  localSeat,
  localPlayer,
  selfTurnOptions,
  localClaimEntry,
  waitingKinds,
  tenpaiDiscards,
  visibleCount,
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


const waitsWithLeft = computed(() => {
  return waitingKinds.value.map((k) => ({
    kind: k,
    left: Math.max(0, 4 - visibleCount(k)),
  }))
})

const discarderName = computed(() => {
  if (!state.lastDiscard) return ''
  return state.seats[state.lastDiscard.seat]?.name ?? ''
})

const turnStatus = computed(() => {
  if (state.phase === 'ROUND_SETTLEMENT') return '本局結算中'
  if (state.phase === 'CLAIM_WINDOW') {
    if (localClaimEntry.value) return '等待宣告...'
    return '等待其他玩家回應...'
  }
  if (state.currentSeat === localSeat.value) {
    if (migiSelectMode.value) return '請點選一張牌宣告聽牌打出'
    if (selectedTileId.value !== null) return '再次點選或點右側「打出」'
    return '輪到本家出牌'
  }
  const cur = state.seats[state.currentSeat]
  return `${cur?.name ?? '玩家'} 思考中...`
})

function syncScene(): void {
  if (!tableScene) return
  tableScene.syncState(
    state,
    localSeat.value,
    selectedTileId.value,
    migiSelectMode.value,
    selfTurnOptions.value.migiDiscardableTiles,
    tenpaiDiscards.value,
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
      onLayout: (cssH) => {
        handZoneHeight.value = cssH
      },
    })
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: canvasHost.value,
      width: canvasHost.value.clientWidth || window.innerWidth,
      height: canvasHost.value.clientHeight || window.innerHeight,
      backgroundColor: '#0a1626',
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
  <div class="fixed inset-0 h-[100dvh] w-full overflow-hidden select-none" style="background-color: var(--felt-out)">
    <!-- Phaser 3 渲染畫布 -->
    <div ref="canvasHost" class="absolute inset-0 h-full w-full" />

    <!-- 頂部資訊列：精簡優雅，不搶視覺 -->
    <header class="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-3 py-2 sm:px-5 sm:py-3">
      <div class="glass pointer-events-auto flex items-center gap-2 rounded-2xl px-3 py-1.5 text-xs text-[var(--ivory)]">
        <span class="font-black text-[var(--gold)]">台灣 16 張</span>
        <span class="text-white/20">|</span>
        <span class="text-[var(--muted)]">底 {{ state.rules.basePoints }} / 台 {{ state.rules.taiPoints }}</span>
      </div>

      <!-- 右側按鈕群 -->
      <div class="pointer-events-auto flex items-center gap-2">
        <button
          type="button"
          class="glass flex size-8 items-center justify-center rounded-xl text-sm transition hover:bg-white/10 active:scale-95 cursor-pointer"
          :title="muted ? '開啟聲音' : '靜音'"
          @click="toggleMute"
        >
          {{ muted ? '🔇' : '🔊' }}
        </button>
        <button
          type="button"
          class="glass flex h-8 items-center rounded-xl px-3 text-xs font-semibold text-rose-300 transition hover:bg-rose-950/60 active:scale-95 cursor-pointer"
          @click="emit('leaveTable')"
        >
          離開
        </button>
      </div>
    </header>

    <!-- 浮動操作層：動態根據手牌實際高度貼合定位 -->
    <footer
      class="pointer-events-none absolute inset-x-0 z-30 transition-all duration-200"
      :style="{ bottom: `${handZoneHeight + 6}px` }"
    >
      <ActionHud
        :is-my-turn="state.phase === 'TURN_ACTION_OR_DISCARD' && state.currentSeat === localSeat"
        :self-options="selfTurnOptions"
        :claim-entry="localClaimEntry"
        :waits="waitsWithLeft"
        :selected-tile-id="selectedTileId"
        :migi-select-mode="migiSelectMode"
        :is-migi="localPlayer.isMigi"
        :discarded-tile="state.lastDiscard?.tileId ?? null"
        :discarder-name="discarderName"
        :status="turnStatus"
        @action="onHudAction"
        @toggle-migi-mode="migiSelectMode = !migiSelectMode"
      />
    </footer>

    <!-- 結算彈窗 -->
    <SettlementModal
      :state="state"
      @next-round="startNextRound"
      @back-to-lobby="emit('leaveTable')"
    />
  </div>
</template>
