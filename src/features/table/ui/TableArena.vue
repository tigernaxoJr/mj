<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import Phaser from 'phaser'
import type { PlayerActionCommand, ProtocolMessage, RoomSeatSlot, RuleConfig, SeatIndex, TileId } from '@/shared/kernel/types'
import { isAudioMuted, setAudioMuted } from '@/features/audio'
import type { PeerTransportPort } from '@/features/lobby/infra/peerAdapter'
import { useTableSession } from '../application/useTableSession'
import type { SecureTableSecurity } from '../application/secureTable'
import { TableScene } from '../engine/TableScene'
import ActionHud from './ActionHud.vue'
import SettlementModal from './SettlementModal.vue'

const props = defineProps<{
  localSeat?: SeatIndex
  isHost?: boolean
  rules?: RuleConfig
  roomSeats?: readonly RoomSeatSlot[]
  transport?: PeerTransportPort | null
  initialMessage?: ProtocolMessage
  security?: SecureTableSecurity & { safetyCode?: string[] }
}>()

const emit = defineEmits<{
  leaveTable: []
}>()

const canvasHost = ref<HTMLDivElement | null>(null)
const muted = ref(isAudioMuted())
const handZoneHeight = ref(120)
/** 橫式時他家直列所佔的左右寬度，操作列避開不遮牌 */
const hudSideInset = ref(0)
let game: Phaser.Game | null = null
let tableScene: TableScene | null = null
let resizeObserver: ResizeObserver | null = null
let applyCanvasSize: (() => void) | null = null

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
  viewSeq,
  initAndStartRound,
  startNextRound,
  dispatchAction,
  auditStatus,
  securityFault,
  secureStatus,
  exportEvidence,
} = useTableSession({
  localSeat: props.localSeat ?? 0,
  isHost: props.isHost ?? true,
  rules: props.rules,
  roomSeats: props.roomSeats,
  transport: props.transport ?? null,
  initialMessage: props.initialMessage,
  security: props.security,
})

/** 牌局進行中的防作弊狀態提示（斷線、降級、旁觀） */
const liveNotice = computed(() => {
  const st = secureStatus.value
  if (st.hostLost) return { tone: 'bad', text: '與房主的連線中斷，牌局無法繼續' }
  if (state.phase === 'ROUND_SETTLEMENT') return null
  if (securityFault.value) return { tone: 'bad', text: `${auditNote.value}，本局作廢` }
  if (st.spectator) return { tone: 'warn', text: '你已被判定離線，由電腦代打（旁觀中）' }
  if (st.degradedNote) return { tone: 'warn', text: `⚠ ${st.degradedNote}` }
  return null
})

/** 下載本機保存的簽章紀錄（第三方可自行驗簽與重算） */
function downloadEvidence(): void {
  const log = exportEvidence()
  if (!log) return
  const blob = new Blob([JSON.stringify(log, null, 1)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  a.href = url
  a.download = `twmj-${log.roomCode}-${stamp}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 結算畫面的稽核說明 */
const auditNote = computed(() => {
  const f = securityFault.value
  if (f) {
    const who = f.seat === null ? '' : `${state.seats[f.seat]?.name ?? `座位 ${f.seat}`}：`
    return `⚠ 稽核未通過 · ${who}${f.reason}`
  }
  if (auditStatus.value === 'pending') return '稽核中…'
  if (auditStatus.value === 'degraded') return `⚠ ${secureStatus.value.degradedNote}`
  if (auditStatus.value === 'fail') return '⚠ 牌山承諾異常'
  return props.security ? '✓ 防作弊稽核通過' : '✓ 牌山承諾驗證通過'
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

/** 離開需點兩次，避免對局中誤觸 */
const confirmLeave = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
function requestLeave(): void {
  if (confirmLeave.value || state.phase === 'ROUND_SETTLEMENT') {
    emit('leaveTable')
    return
  }
  confirmLeave.value = true
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => (confirmLeave.value = false), 2500)
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
    viewSeq.value,
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
      onLayout: (cssH, portrait, sideCss) => {
        handZoneHeight.value = cssH
        hudSideInset.value = portrait ? 0 : Math.round(sideCss)
      },
    })
    // 畫布以裝置像素建立、zoom = 1/DPR 縮回 CSS 尺寸，手機高 DPR 下牌面仍清晰。
    // DPR 只在這裡讀取並同步給場景；瀏覽器縮放或換螢幕時一併更新 zoom 與畫布尺寸。
    const host = canvasHost.value
    const readDpr = () => Math.min(window.devicePixelRatio || 1, 2)
    let dpr = readDpr()
    const cssW = () => host.clientWidth || window.innerWidth
    const cssH = () => host.clientHeight || window.innerHeight
    tableScene.setDpr(dpr)
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host,
      width: Math.round(cssW() * dpr),
      height: Math.round(cssH() * dpr),
      backgroundColor: '#120b08',
      scale: {
        mode: Phaser.Scale.NONE,
        zoom: 1 / dpr,
      },
      scene: [tableScene],
    })
    applyCanvasSize = () => {
      if (!game || !tableScene) return
      const next = readDpr()
      const dprChanged = next !== dpr
      dpr = next
      tableScene.setDpr(dpr)
      // 先改尺寸再改 zoom：Phaser 在 zoom=1 時 resize() 不會回寫 style，順序顛倒會殘留舊的 CSS 尺寸
      game.scale.resize(Math.round(cssW() * dpr), Math.round(cssH() * dpr))
      if (dprChanged) game.scale.setZoom(1 / dpr)
      game.canvas.style.width = `${cssW()}px`
      game.canvas.style.height = `${cssH()}px`
    }
    resizeObserver = new ResizeObserver(() => applyCanvasSize?.())
    window.addEventListener('resize', applyCanvasSize)
    resizeObserver.observe(host)
  }
  await initAndStartRound()
  syncScene()
})

onUnmounted(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
  resizeObserver?.disconnect()
  if (applyCanvasSize) window.removeEventListener('resize', applyCanvasSize)
  if (game) {
    game.destroy(true)
    game = null
    tableScene = null
  }
})
</script>

<template>
  <div class="fixed inset-0 h-[100dvh] w-full overflow-hidden select-none" style="background-color: var(--wood-deep)">
    <!-- Phaser 3 渲染畫布 -->
    <div ref="canvasHost" class="absolute inset-0 h-full w-full" />

    <!-- 頂部資訊列：貼齊木框角落，不遮牌 -->
    <header
      class="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between px-3 pt-[max(0.6rem,env(safe-area-inset-top))] sm:px-5 sm:pt-4"
    >
      <div class="chip pointer-events-auto flex h-9 items-center gap-2 rounded-full pl-1.5 pr-3.5 text-xs">
        <span class="grid size-6 place-items-center rounded-full bg-[var(--cinnabar)] font-serif text-[11px] font-black text-white">16</span>
        <span class="hidden font-serif font-black tracking-wider text-[var(--brass-hi)] sm:inline">台灣十六張</span>
        <span class="hidden h-3 w-px bg-white/15 sm:inline-block" />
        <span class="font-bold tabular-nums text-[var(--muted)]">{{ state.rules.basePoints }}/{{ state.rules.taiPoints }}</span>
        <span v-if="transport" class="size-1.5 rounded-full bg-[var(--jade)]" title="P2P 連線中" />
        <span
          v-if="security?.safetyCode"
          class="hidden tracking-[0.1em] sm:inline"
          :title="'房間安全碼（防作弊牌局）'"
          :aria-label="`房間安全碼 ${security.safetyCode.join(' ')}`"
        >{{ security.safetyCode.join('') }}</span>
      </div>

      <div class="pointer-events-auto flex items-center gap-2">
        <button
          type="button"
          class="chip grid size-9 place-items-center rounded-full text-[var(--ivory)] transition hover:text-[var(--brass-hi)] active:scale-95"
          :aria-label="muted ? '開啟聲音' : '靜音'"
          :aria-pressed="muted"
          @click="toggleMute"
        >
          <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M11 5 6 9H3v6h3l5 4V5z" />
            <template v-if="muted"><path d="m22 9-6 6" /><path d="m16 9 6 6" /></template>
            <template v-else><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></template>
          </svg>
        </button>
        <button
          type="button"
          class="chip flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-bold transition active:scale-95"
          :class="confirmLeave ? 'border-[var(--cinnabar)]! bg-[var(--cinnabar)]! text-white' : 'text-[var(--muted)] hover:text-[var(--ivory)]'"
          @click="requestLeave"
        >
          <svg viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17 5 12l5-5" /><path d="M5 12h11" />
          </svg>
          {{ confirmLeave ? '確定離開？' : '離開' }}
        </button>
      </div>
    </header>

    <!-- 防作弊牌局：違規作廢、斷線降級、與房主斷線 -->
    <p
      v-if="liveNotice"
      role="alert"
      class="absolute inset-x-3 top-[max(3.4rem,calc(env(safe-area-inset-top)+3rem))] z-40 mx-auto max-w-md rounded-xl border px-3 py-2 text-center text-xs font-bold"
      :class="
        liveNotice.tone === 'bad'
          ? 'border-[var(--cinnabar)]/50 bg-[#2a0f0a]/95 text-[#ffb4a3]'
          : 'border-[var(--brass)]/50 bg-[#2a1d08]/95 text-[var(--brass-hi)]'
      "
    >
      {{ liveNotice.text }}
    </p>

    <!-- 浮動操作層：動態根據手牌實際高度貼合定位 -->
    <footer
      class="pointer-events-none absolute inset-x-0 z-30 transition-all duration-200"
      :style="{ bottom: `${handZoneHeight + 6}px`, paddingLeft: `${hudSideInset}px`, paddingRight: `${hudSideInset}px` }"
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
      :audit-status="auditStatus"
      :audit-note="auditNote"
      :can-export="!!security"
      @export-evidence="downloadEvidence"
      :can-advance="(props.isHost ?? true) && auditStatus !== 'pending'"
      @next-round="startNextRound"
      @back-to-lobby="emit('leaveTable')"
    />
  </div>
</template>
