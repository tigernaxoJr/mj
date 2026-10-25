<script setup lang="ts">
import { ref } from 'vue'
import { kindOf, type PlayerActionCommand, type TileId, type TileKind } from '@/shared/kernel/types'
import { tileLabel } from '@/shared/wasm'
import type { SeatClaimOption, SelfTurnOptions } from '../domain/tableState'

const props = defineProps<{
  isMyTurn: boolean
  selfOptions: SelfTurnOptions
  claimEntry: SeatClaimOption | null
  waitingKinds: TileKind[]
  selectedTileId: TileId | null
  migiSelectMode: boolean
  discardedTile: TileId | null
}>()

const emit = defineEmits<{
  action: [cmd: PlayerActionCommand]
  toggleMigiMode: []
}>()

const showChiiPicker = ref(false)

function handleChiiClick(): void {
  if (!props.claimEntry) return
  if (props.claimEntry.chiiOptions.length === 1) {
    emit('action', { type: 'CLAIM_CHII', meldTiles: props.claimEntry.chiiOptions[0] })
    showChiiPicker.value = false
  } else {
    showChiiPicker.value = !showChiiPicker.value
  }
}

function chooseChiiPair(pair: [TileId, TileId]): void {
  showChiiPicker.value = false
  emit('action', { type: 'CLAIM_CHII', meldTiles: pair })
}
</script>

<template>
  <div class="pointer-events-auto flex flex-col items-center gap-2">
    <!-- 聽牌提示列 -->
    <div
      v-if="waitingKinds.length > 0"
      class="flex items-center gap-2 rounded-full border border-amber-400/50 bg-emerald-950/90 px-3.5 py-1 text-xs shadow-lg backdrop-blur"
    >
      <span class="font-bold text-amber-300">聽牌：</span>
      <div class="flex items-center gap-1.5">
        <span
          v-for="k in waitingKinds"
          :key="k"
          class="inline-flex items-center gap-1 rounded bg-emerald-800/80 px-1.5 py-0.5 font-semibold text-amber-100"
        >
          <img :src="`assets/tiles/tile_${k}.png`" :alt="tileLabel(k, false)" class="h-5 w-auto" />
          {{ tileLabel(k, false) }}
        </span>
      </div>
    </div>

    <!-- 多組吃牌選擇器 -->
    <div
      v-if="showChiiPicker && claimEntry && claimEntry.chiiOptions.length > 1"
      class="flex items-center gap-2 rounded-xl border border-amber-400/60 bg-emerald-950/95 p-2 shadow-2xl"
    >
      <span class="px-2 text-xs font-bold text-amber-200">選擇吃牌組合：</span>
      <button
        v-for="(pair, idx) in claimEntry.chiiOptions"
        :key="idx"
        type="button"
        class="flex items-center gap-1 rounded-lg border border-emerald-600 bg-emerald-900 px-2 py-1 hover:border-amber-400 cursor-pointer"
        @click="chooseChiiPair(pair)"
      >
        <img :src="`assets/tiles/tile_${kindOf(pair[0])}.png`" class="h-7 w-auto" />
        <img :src="`assets/tiles/tile_${kindOf(pair[1])}.png`" class="h-7 w-auto" />
      </button>
    </div>

    <!-- 自身摸牌回合操作鈕 (自摸 / 暗槓 / 加槓 / 宣告聽牌 / 出牌) -->
    <div
      v-if="isMyTurn && (selfOptions.canTsumo || selfOptions.ankanOptions.length > 0 || selfOptions.kakanOptions.length > 0 || selfOptions.migiDiscardableTiles.length > 0 || selectedTileId !== null)"
      class="flex flex-wrap items-center justify-center gap-2.5 rounded-2xl border border-amber-500/40 bg-emerald-950/90 px-4 py-2 shadow-2xl backdrop-blur"
    >
      <button
        v-if="selfOptions.canTsumo"
        type="button"
        class="rounded-xl bg-gradient-to-b from-red-500 to-red-700 px-5 py-2 text-base font-extrabold text-amber-100 shadow-lg ring-2 ring-amber-300 transition hover:scale-105 cursor-pointer"
        @click="emit('action', { type: 'TSUMO' })"
      >
        自摸
      </button>

      <button
        v-for="ak in selfOptions.ankanOptions"
        :key="`ankan-${ak.kind}`"
        type="button"
        class="rounded-xl bg-amber-600 px-4 py-2 text-sm font-bold text-white shadow hover:bg-amber-500 cursor-pointer"
        @click="emit('action', { type: 'ANKAN', kind: ak.kind })"
      >
        暗槓 {{ tileLabel(ak.kind, false) }}
      </button>

      <button
        v-for="kk in selfOptions.kakanOptions"
        :key="`kakan-${kk.kind}`"
        type="button"
        class="rounded-xl bg-amber-600 px-4 py-2 text-sm font-bold text-white shadow hover:bg-amber-500 cursor-pointer"
        @click="emit('action', { type: 'KAKAN', kind: kk.kind })"
      >
        加槓 {{ tileLabel(kk.kind, false) }}
      </button>

      <button
        v-if="selfOptions.migiDiscardableTiles.length > 0"
        type="button"
        class="rounded-xl px-4 py-2 text-sm font-bold transition cursor-pointer"
        :class="
          migiSelectMode
            ? 'bg-purple-500 text-white ring-2 ring-amber-300'
            : 'bg-purple-800/90 text-purple-100 hover:bg-purple-700'
        "
        @click="emit('toggleMigiMode')"
      >
        {{ migiSelectMode ? '取消聽牌選擇' : '聽牌 (MIGI)' }}
      </button>

      <button
        v-if="selectedTileId !== null"
        type="button"
        class="rounded-xl bg-amber-400 px-4 py-2 text-sm font-extrabold text-emerald-950 shadow hover:bg-amber-300 cursor-pointer"
        @click="
          emit(
            'action',
            migiSelectMode
              ? { type: 'DECLARE_MIGI', discardTileId: selectedTileId }
              : { type: 'DISCARD', tileId: selectedTileId },
          )
        "
      >
        打出 {{ tileLabel(selectedTileId, true) }}
      </button>
    </div>

    <!-- 他人捨牌後的攔胡與副露競爭視窗 (胡 / 槓 / 碰 / 吃 / 過) -->
    <div
      v-if="claimEntry"
      class="flex items-center gap-2.5 rounded-2xl border border-amber-400/70 bg-emerald-950/95 px-5 py-2.5 shadow-2xl backdrop-blur"
    >
      <span v-if="discardedTile !== null" class="mr-1 flex items-center gap-1 text-xs text-amber-200">
        捨牌：
        <img :src="`assets/tiles/tile_${kindOf(discardedTile)}.png`" class="h-7 w-auto" />
      </span>

      <button
        v-if="claimEntry.canRon"
        type="button"
        class="rounded-xl bg-gradient-to-b from-red-500 to-red-700 px-5 py-2 text-base font-extrabold text-amber-100 shadow-lg ring-2 ring-amber-300 transition hover:scale-105 cursor-pointer"
        @click="emit('action', { type: 'CLAIM_RON' })"
      >
        胡
      </button>

      <button
        v-if="claimEntry.minkanTiles"
        type="button"
        class="rounded-xl bg-amber-600 px-4 py-2 text-sm font-bold text-white shadow hover:bg-amber-500 cursor-pointer"
        @click="emit('action', { type: 'CLAIM_MINKAN' })"
      >
        槓
      </button>

      <button
        v-if="claimEntry.ponTiles"
        type="button"
        class="rounded-xl bg-sky-600 px-4 py-2 text-sm font-bold text-white shadow hover:bg-sky-500 cursor-pointer"
        @click="emit('action', { type: 'CLAIM_PON' })"
      >
        碰
      </button>

      <button
        v-if="claimEntry.chiiOptions.length > 0"
        type="button"
        class="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white shadow hover:bg-emerald-500 cursor-pointer"
        @click="handleChiiClick"
      >
        吃
      </button>

      <button
        type="button"
        class="rounded-xl border border-slate-500/60 bg-slate-800/90 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-700 cursor-pointer"
        @click="emit('action', { type: 'CLAIM_PASS' })"
      >
        過
      </button>
    </div>
  </div>
</template>
