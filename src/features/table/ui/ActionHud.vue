<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { kindOf, type PlayerActionCommand, type TileId, type TileKind } from '@/shared/kernel/types'
import { tileLabel } from '@/shared/wasm'
import type { SeatClaimOption, SelfTurnOptions } from '../domain/tableState'

const props = defineProps<{
  isMyTurn: boolean
  selfOptions: SelfTurnOptions
  claimEntry: SeatClaimOption | null
  waits: { kind: TileKind; left: number }[]
  selectedTileId: TileId | null
  migiSelectMode: boolean
  isMigi: boolean
  discardedTile: TileId | null
  discarderName: string
  status: string
}>()

const emit = defineEmits<{
  action: [cmd: PlayerActionCommand]
  toggleMigiMode: []
}>()

const tileSrc = (k: number) => `assets/tiles/tile_${k}.png`
const chiiOpen = ref(false)
watch(() => props.claimEntry, () => (chiiOpen.value = false))

const hasSelfActions = computed(
  () =>
    props.isMyTurn &&
    (props.selfOptions.canTsumo ||
      props.selfOptions.ankanOptions.length > 0 ||
      props.selfOptions.kakanOptions.length > 0 ||
      (props.selfOptions.migiDiscardableTiles.length > 0 && !props.isMigi) ||
      props.selectedTileId !== null),
)

function onChii(): void {
  const opts = props.claimEntry?.chiiOptions ?? []
  if (opts.length === 1) emit('action', { type: 'CLAIM_CHII', meldTiles: opts[0] })
  else chiiOpen.value = !chiiOpen.value
}

/** 吃牌組合依牌序排列（含被吃的那張），讓玩家一眼看出順子 */
function chiiRun(pair: [TileId, TileId]): { kind: number; claimed: boolean }[] {
  const claimed = props.discardedTile === null ? [] : [{ kind: kindOf(props.discardedTile), claimed: true }]
  return [...pair.map((t) => ({ kind: kindOf(t), claimed: false })), ...claimed].sort((a, b) => a.kind - b.kind)
}

function discardSelected(): void {
  const id = props.selectedTileId
  if (id === null) return
  emit('action', props.migiSelectMode ? { type: 'DECLARE_MIGI', discardTileId: id } : { type: 'DISCARD', tileId: id })
}
</script>

<template>
  <div class="flex w-full items-end justify-between gap-2 px-3 sm:px-5">
    <!-- 左：狀態與聽牌資訊 -->
    <div class="pointer-events-auto flex min-w-0 flex-col items-start gap-1.5">
      <div v-if="waits.length" class="chip flex max-w-full items-center gap-2 overflow-x-auto rounded-2xl py-1.5 pl-1.5 pr-3" aria-label="聽牌">
        <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--brass)] font-serif text-sm font-black text-[#2a1a07]">聽</span>
        <span v-for="w in waits" :key="w.kind" class="flex shrink-0 items-center gap-1">
          <img
            :src="tileSrc(w.kind)"
            :alt="tileLabel(w.kind, false)"
            class="h-8 w-auto drop-shadow"
            :class="w.left === 0 && 'opacity-35 grayscale'"
          />
          <span class="text-[11px] font-bold tabular-nums" :class="w.left === 0 ? 'text-[var(--faint)]' : 'text-[var(--ivory)]'">
            ×{{ w.left }}
          </span>
        </span>
      </div>
      <p v-if="status" class="chip flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-bold text-[var(--ivory)] sm:text-xs" aria-live="polite">
        <span class="size-2 shrink-0 rounded-full" :class="isMyTurn ? 'turn-dot bg-[var(--jade)]' : 'bg-[var(--faint)]'" />
        {{ status }}
      </p>
    </div>

    <!-- 右：操作鈕（拇指熱區） -->
    <div class="pointer-events-auto flex shrink-0 flex-col items-end gap-2">
      <!-- 吃牌組合選擇 -->
      <div v-if="chiiOpen && claimEntry" class="chip flex gap-1.5 rounded-2xl p-1.5">
        <button
          v-for="(pair, i) in claimEntry.chiiOptions"
          :key="i"
          type="button"
          class="flex rounded-xl p-1 transition hover:bg-white/10 active:scale-95"
          :aria-label="`吃 ${chiiRun(pair).map((t) => tileLabel(t.kind, false)).join('')}`"
          @click="emit('action', { type: 'CLAIM_CHII', meldTiles: pair })"
        >
          <img
            v-for="(t, j) in chiiRun(pair)"
            :key="j"
            :src="tileSrc(t.kind)"
            alt=""
            class="h-11 w-auto"
            :class="t.claimed && '-translate-y-1 drop-shadow-[0_0_6px_var(--jade)]'"
          />
        </button>
      </div>

      <!-- 他家捨牌：胡 / 槓 / 碰 / 吃 / 過 -->
      <div v-if="claimEntry" class="flex items-end gap-2">
        <div v-if="discardedTile !== null" class="chip mr-1 flex flex-col items-center rounded-2xl px-2 pb-1 pt-1.5">
          <img :src="tileSrc(kindOf(discardedTile))" :alt="tileLabel(discardedTile)" class="h-12 w-auto drop-shadow" />
          <span class="mt-0.5 max-w-16 truncate text-[10px] text-[var(--muted)]">{{ discarderName }}</span>
        </div>
        <button v-if="claimEntry.canRon" type="button" class="act act-win" @click="emit('action', { type: 'CLAIM_RON' })">胡</button>
        <button v-if="claimEntry.minkanTiles" type="button" class="act act-brass" @click="emit('action', { type: 'CLAIM_MINKAN' })">槓</button>
        <button v-if="claimEntry.ponTiles" type="button" class="act act-azure" @click="emit('action', { type: 'CLAIM_PON' })">碰</button>
        <button v-if="claimEntry.chiiOptions.length" type="button" class="act act-jade" :aria-expanded="chiiOpen" @click="onChii">吃</button>
        <button type="button" class="act act-ghost" @click="emit('action', { type: 'CLAIM_PASS' })">過</button>
      </div>

      <!-- 自己回合：自摸 / 槓 / 聽 / 打出 -->
      <div v-else-if="hasSelfActions" class="flex flex-wrap items-end justify-end gap-2">
        <button
          v-for="ak in selfOptions.ankanOptions"
          :key="`a${ak.kind}`"
          type="button"
          class="pill"
          @click="emit('action', { type: 'ANKAN', kind: ak.kind })"
        >
          暗槓 <img :src="tileSrc(ak.kind)" :alt="tileLabel(ak.kind, false)" class="h-7 w-auto" />
        </button>
        <button
          v-for="kk in selfOptions.kakanOptions"
          :key="`k${kk.kind}`"
          type="button"
          class="pill"
          @click="emit('action', { type: 'KAKAN', kind: kk.kind })"
        >
          加槓 <img :src="tileSrc(kk.kind)" :alt="tileLabel(kk.kind, false)" class="h-7 w-auto" />
        </button>
        <button
          v-if="selfOptions.migiDiscardableTiles.length && !isMigi"
          type="button"
          class="pill"
          :class="migiSelectMode && 'pill-on'"
          :aria-pressed="migiSelectMode"
          @click="emit('toggleMigiMode')"
        >
          <span class="font-serif">{{ migiSelectMode ? '取消聽' : '聽牌' }}</span>
        </button>
        <button v-if="selectedTileId !== null" type="button" class="pill pill-primary" @click="discardSelected">
          {{ migiSelectMode ? '聽牌打出' : '打出' }}
          <img :src="tileSrc(kindOf(selectedTileId))" :alt="tileLabel(selectedTileId)" class="h-7 w-auto" />
        </button>
        <button v-if="selfOptions.canTsumo" type="button" class="act act-win act-wide" @click="emit('action', { type: 'TSUMO' })">
          自摸
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference '../../../style.css';

.act {
  @apply grid size-14 place-items-center rounded-2xl font-serif text-2xl font-black transition select-none active:scale-90 sm:size-16 sm:text-3xl;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.35),
    inset 0 0 0 1px rgba(255, 255, 255, 0.12),
    0 10px 24px -8px rgba(0, 0, 0, 0.7);
}
.act-win {
  @apply size-16 text-white sm:size-20 sm:text-4xl;
  background: linear-gradient(180deg, var(--cinnabar-hi), var(--cinnabar) 55%, #a8291a);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.4),
    0 0 0 3px rgba(255, 210, 200, 0.25),
    0 10px 30px -6px rgba(224, 72, 47, 0.7);
  animation: beat 1.1s ease-in-out infinite;
}
.act-wide {
  @apply w-24 text-2xl sm:w-28 sm:text-3xl;
}
.act-brass {
  @apply text-[#2a1a07];
  background: linear-gradient(180deg, var(--brass-hi), var(--brass) 55%, #a87d28);
}
.act-azure {
  @apply text-white;
  background: linear-gradient(180deg, #7fa8ff, var(--azure) 55%, #2c4f99);
}
.act-jade {
  @apply text-white;
  background: linear-gradient(180deg, var(--jade-hi), var(--jade) 55%, #1f6e50);
}
.act-ghost {
  @apply size-12 text-lg text-[var(--muted)] sm:size-14 sm:text-xl;
  background: rgba(18, 11, 8, 0.85);
  box-shadow:
    inset 0 0 0 1px rgba(212, 166, 74, 0.3),
    0 8px 20px -8px rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
}
.pill {
  @apply flex h-11 items-center gap-1.5 rounded-2xl px-4 text-sm font-bold text-[var(--ivory)] transition active:scale-95;
  background: rgba(18, 11, 8, 0.88);
  box-shadow:
    inset 0 0 0 1px rgba(212, 166, 74, 0.3),
    0 8px 20px -8px rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
}
.pill-on {
  @apply text-[var(--brass-hi)];
  box-shadow: inset 0 0 0 2px var(--brass);
}
.pill-primary {
  @apply text-white;
  background: linear-gradient(180deg, var(--jade-hi), var(--jade) 50%, #1f6e50);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.35),
    0 8px 22px -8px rgba(63, 174, 130, 0.8);
}
.turn-dot {
  animation: blink 1s ease-in-out infinite;
}
@keyframes beat {
  50% {
    transform: scale(1.06);
  }
}
@keyframes blink {
  50% {
    opacity: 0.35;
  }
}
</style>
