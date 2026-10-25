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
  <div class="flex w-full items-end justify-between gap-2 px-2 sm:px-4">
    <!-- 左：狀態與聽牌資訊 -->
    <div class="pointer-events-auto flex min-w-0 flex-col items-start gap-1.5">
      <div
        v-if="waits.length"
        class="glass flex max-w-full items-center gap-2 overflow-x-auto rounded-2xl px-2.5 py-1.5"
        aria-label="聽牌"
      >
        <span class="shrink-0 text-xs font-bold text-[var(--gold)]">聽</span>
        <span v-for="w in waits" :key="w.kind" class="flex shrink-0 items-center gap-1">
          <img :src="tileSrc(w.kind)" :alt="tileLabel(w.kind, false)" class="h-8 w-auto" :class="w.left === 0 && 'opacity-35 grayscale'" />
          <span class="text-[11px] font-semibold tabular-nums" :class="w.left === 0 ? 'text-[var(--muted)]' : 'text-[var(--ivory)]'">
            ×{{ w.left }}
          </span>
        </span>
      </div>
      <p v-if="status" class="glass rounded-full px-3 py-1 text-[11px] font-medium text-[var(--ivory)] sm:text-xs">
        {{ status }}
      </p>
    </div>

    <!-- 右：操作鈕（拇指熱區） -->
    <div class="pointer-events-auto flex shrink-0 flex-col items-end gap-2">
      <!-- 吃牌組合選擇 -->
      <div v-if="chiiOpen && claimEntry" class="glass flex gap-1.5 rounded-2xl p-1.5">
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
            :class="t.claimed && '-translate-y-1 drop-shadow-[0_0_6px_var(--accent)]'"
          />
        </button>
      </div>

      <!-- 他家捨牌：胡 / 槓 / 碰 / 吃 / 過 -->
      <div v-if="claimEntry" class="flex items-end gap-2">
        <div v-if="discardedTile !== null" class="glass mr-1 flex flex-col items-center rounded-2xl px-2 py-1.5">
          <img :src="tileSrc(kindOf(discardedTile))" :alt="tileLabel(discardedTile)" class="h-12 w-auto" />
          <span class="mt-0.5 max-w-16 truncate text-[10px] text-[var(--muted)]">{{ discarderName }}</span>
        </div>
        <button v-if="claimEntry.canRon" type="button" class="act act-win" @click="emit('action', { type: 'CLAIM_RON' })">胡</button>
        <button v-if="claimEntry.minkanTiles" type="button" class="act act-gold" @click="emit('action', { type: 'CLAIM_MINKAN' })">槓</button>
        <button v-if="claimEntry.ponTiles" type="button" class="act act-blue" @click="emit('action', { type: 'CLAIM_PON' })">碰</button>
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
          {{ migiSelectMode ? '取消聽' : '聽牌' }}
        </button>
        <button v-if="selectedTileId !== null" type="button" class="pill pill-primary" @click="discardSelected">
          {{ migiSelectMode ? '聽牌打出' : '打出' }}
          <img :src="tileSrc(kindOf(selectedTileId))" :alt="tileLabel(selectedTileId)" class="h-7 w-auto" />
        </button>
        <button v-if="selfOptions.canTsumo" type="button" class="act act-win" @click="emit('action', { type: 'TSUMO' })">
          <span class="text-xl">自摸</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference '../../../style.css';

.act {
  @apply grid size-14 place-items-center rounded-full text-2xl font-black shadow-lg ring-1 ring-white/15 transition select-none active:scale-90 sm:size-16 sm:text-3xl;
  font-family: 'Noto Serif TC', 'PMingLiU', serif;
}
.act-win {
  @apply size-16 text-[var(--ivory)] sm:size-20;
  background: radial-gradient(circle at 35% 30%, #ff7a5c, var(--accent) 55%, #a8291a);
  box-shadow: 0 0 0 3px #ffd2c855, 0 8px 24px #f0533a66;
  animation: beat 1.1s ease-in-out infinite;
}
.act-gold {
  @apply text-[#2b1d05];
  background: radial-gradient(circle at 35% 30%, #fbe3a1, var(--gold) 60%, #b8902f);
}
.act-blue {
  @apply text-white;
  background: radial-gradient(circle at 35% 30%, #7fb2ff, #3a6fd8 60%, #23479a);
}
.act-jade {
  @apply text-white;
  background: radial-gradient(circle at 35% 30%, #7fe0b4, #2a9d74 60%, #19684c);
}
.act-ghost {
  @apply size-12 text-lg text-[var(--muted)] sm:size-14 sm:text-xl;
  background: #0b1729cc;
  backdrop-filter: blur(8px);
}
.pill {
  @apply flex h-11 items-center gap-1.5 rounded-full px-4 text-sm font-bold text-[var(--ivory)] ring-1 ring-white/15 transition active:scale-95;
  background: #16263fe6;
  backdrop-filter: blur(8px);
}
.pill-on {
  @apply ring-2 ring-[var(--gold)] text-[var(--gold)];
}
.pill-primary {
  @apply text-white;
  background: var(--accent);
}
@keyframes beat {
  50% {
    transform: scale(1.06);
  }
}
@media (prefers-reduced-motion: reduce) {
  .act-win {
    animation: none;
  }
}
</style>
