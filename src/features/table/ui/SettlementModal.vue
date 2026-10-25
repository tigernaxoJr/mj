<script setup lang="ts">
import { kindOf, type SeatIndex } from '@/shared/kernel/types'
import { tileLabel } from '@/shared/wasm'
import type { TableState } from '../domain/tableState'

defineProps<{
  state: TableState
}>()

const emit = defineEmits<{
  nextRound: []
  backToLobby: []
}>()

const windLabels: Record<SeatIndex, string> = { 0: '東', 1: '南', 2: '西', 3: '北' }
</script>

<template>
  <div
    v-if="state.phase === 'ROUND_SETTLEMENT' && state.settlement"
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/75 p-2.5 sm:p-4 backdrop-blur-sm"
  >
    <div class="max-h-[94dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-amber-400/50 bg-emerald-950/95 p-4 sm:p-6 text-amber-50 shadow-2xl">
      <div class="flex items-center justify-between border-b border-emerald-800 pb-3">
        <div>
          <h2 class="text-2xl font-extrabold text-amber-300">
            <template v-if="state.settlement.isExhaustiveDraw">
              鐵八墩流局 · 臭莊連莊
            </template>
            <template v-else>
              {{ state.settlement.winnerSeats.map((s) => state.seats[s].name).join('、') }}
              {{ state.settlement.isTsumo ? '自摸胡牌！' : '榮胡！' }}
            </template>
          </h2>
          <p class="mt-0.5 text-xs text-emerald-300">
            底 {{ state.rules.basePoints }} / 台 {{ state.rules.taiPoints }} ·
            <span :class="state.auditVerified ? 'text-emerald-300' : 'text-rose-400'">
              {{ state.auditVerified ? '✓ SHA-256 牌山承諾驗證通過' : '⚠ 牌山雜湊異常' }}
            </span>
          </p>
        </div>

        <div v-if="!state.settlement.isExhaustiveDraw" class="text-right">
          <span class="text-xs text-amber-200/80">總台數</span>
          <p class="text-3xl font-black text-amber-400">{{ state.settlement.totalTai }} 台</p>
        </div>
      </div>

      <!-- 贏家手牌展示 -->
      <div
        v-if="state.settlement.winnerSeats.length > 0"
        class="mt-4 rounded-xl border border-emerald-800/80 bg-emerald-900/50 p-3"
      >
        <div class="flex flex-wrap items-center gap-1.5">
          <img
            v-for="(tId, idx) in state.seats[state.settlement.winnerSeats[0]].concealed"
            :key="`win-c-${idx}`"
            :src="`assets/tiles/tile_${kindOf(tId)}.png`"
            :alt="tileLabel(tId)"
            class="h-11 w-auto rounded shadow"
          />
          <template
            v-for="(meld, mIdx) in state.seats[state.settlement.winnerSeats[0]].melds"
            :key="`win-m-${mIdx}`"
          >
            <span class="mx-1 text-emerald-500">|</span>
            <img
              v-for="(tId, tIdx) in meld.tiles"
              :key="`win-mt-${mIdx}-${tIdx}`"
              :src="`assets/tiles/tile_${kindOf(tId)}.png`"
              class="h-10 w-auto rounded"
            />
          </template>
        </div>
        <div
          v-if="state.seats[state.settlement.winnerSeats[0]].flowers.length > 0"
          class="mt-2 flex items-center gap-1 text-xs text-amber-200"
        >
          <span>花牌：</span>
          <img
            v-for="(fId, fIdx) in state.seats[state.settlement.winnerSeats[0]].flowers"
            :key="`win-f-${fIdx}`"
            :src="`assets/tiles/tile_${kindOf(fId)}.png`"
            class="h-7 w-auto"
          />
        </div>
      </div>

      <!-- 台數明細列表 -->
      <div class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div
          v-for="(item, idx) in state.settlement.taiItems"
          :key="idx"
          class="flex items-center justify-between rounded-lg border border-amber-500/30 bg-emerald-900/70 px-3 py-1.5 text-sm"
        >
          <span class="font-medium text-amber-100">{{ item.name }}</span>
          <span class="font-bold text-amber-300">{{ item.tai }} 台</span>
        </div>
      </div>

      <!-- 四家分數變動 -->
      <div class="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div
          v-for="seat in state.seats"
          :key="seat.seat"
          class="rounded-xl border border-emerald-800 bg-emerald-900/40 px-3 py-2 text-center"
        >
          <p class="text-xs text-emerald-300">
            {{ windLabels[((seat.seat + 4 - state.dealerSeat) % 4) as SeatIndex] }}家 · {{ seat.name }}
          </p>
          <p
            class="mt-0.5 text-base font-extrabold"
            :class="
              state.settlement.scoreDeltas[seat.seat] > 0
                ? 'text-amber-300'
                : state.settlement.scoreDeltas[seat.seat] < 0
                  ? 'text-rose-400'
                  : 'text-slate-300'
            "
          >
            {{
              state.settlement.scoreDeltas[seat.seat] > 0
                ? `+${state.settlement.scoreDeltas[seat.seat]}`
                : state.settlement.scoreDeltas[seat.seat]
            }}
          </p>
          <p class="text-xs text-emerald-200/70">總分：{{ seat.score }}</p>
        </div>
      </div>

      <div class="mt-6 flex justify-end gap-3">
        <button
          type="button"
          class="rounded-xl border border-emerald-600 bg-emerald-900 px-4 py-2.5 text-sm font-semibold text-emerald-100 hover:bg-emerald-800 cursor-pointer"
          @click="emit('backToLobby')"
        >
          返回大廳
        </button>
        <button
          type="button"
          class="rounded-xl bg-amber-500 px-6 py-2.5 text-sm font-extrabold text-emerald-950 shadow-lg hover:bg-amber-400 cursor-pointer"
          @click="emit('nextRound')"
        >
          下一局（{{
            state.settlement.isExhaustiveDraw ||
            state.settlement.winnerSeats.includes(state.dealerSeat)
              ? '莊家連莊'
              : '換莊'
          }}）
        </button>
      </div>
    </div>
  </div>
</template>
