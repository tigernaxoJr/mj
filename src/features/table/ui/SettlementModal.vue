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
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-5 backdrop-blur-md"
  >
    <div class="glass-card max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-3xl p-5 sm:p-7 text-[var(--ivory)] animate-in fade-in zoom-in-95 duration-200">
      <!-- 結算頭部 -->
      <div class="flex items-start justify-between border-b border-white/10 pb-4">
        <div>
          <div class="flex items-center gap-2">
            <span
              v-if="!state.settlement.isExhaustiveDraw"
              class="rounded-lg bg-[var(--accent)] px-2.5 py-0.5 text-xs font-black tracking-wider text-white"
            >
              {{ state.settlement.isTsumo ? '自摸' : '榮胡' }}
            </span>
            <span
              v-else
              class="rounded-lg bg-slate-700 px-2.5 py-0.5 text-xs font-bold text-slate-200"
            >
              流局
            </span>
            <h2 class="text-2xl font-black text-[var(--gold)] sm:text-3xl">
              <template v-if="state.settlement.isExhaustiveDraw">
                鐵八墩荒牌 · 連莊
              </template>
              <template v-else>
                {{ state.settlement.winnerSeats.map((s) => state.seats[s].name).join('、') }}
              </template>
            </h2>
          </div>
          <p class="mt-1 text-xs text-[var(--muted)]">
            底 {{ state.rules.basePoints }} / 台 {{ state.rules.taiPoints }} ·
            <span :class="state.auditVerified ? 'text-emerald-400' : 'text-rose-400'">
              {{ state.auditVerified ? '✓ SHA-256 承諾驗證通過' : '⚠ 承諾異常' }}
            </span>
          </p>
        </div>

        <div v-if="!state.settlement.isExhaustiveDraw" class="text-right">
          <span class="text-xs text-[var(--muted)]">總台數</span>
          <p class="text-3xl font-black tabular-nums text-[var(--gold)] sm:text-4xl">
            {{ state.settlement.totalTai }} <span class="text-lg">台</span>
          </p>
        </div>
      </div>

      <!-- 贏家牌型展開展示 -->
      <div
        v-if="state.settlement.winnerSeats.length > 0"
        class="mt-4 rounded-2xl bg-black/25 p-3.5 border border-white/5"
      >
        <p class="mb-2 text-xs font-semibold text-[var(--muted)]">胡牌面相：</p>
        <div class="flex flex-wrap items-center gap-1.5">
          <img
            v-for="(tId, idx) in state.seats[state.settlement.winnerSeats[0]].concealed"
            :key="`win-c-${idx}`"
            :src="`assets/tiles/tile_${kindOf(tId)}.png`"
            :alt="tileLabel(tId)"
            class="h-10 w-auto rounded shadow-sm sm:h-12"
          />
          <template
            v-for="(meld, mIdx) in state.seats[state.settlement.winnerSeats[0]].melds"
            :key="`win-m-${mIdx}`"
          >
            <span class="mx-1 text-white/20">|</span>
            <img
              v-for="(tId, tIdx) in meld.tiles"
              :key="`win-mt-${mIdx}-${tIdx}`"
              :src="`assets/tiles/tile_${kindOf(tId)}.png`"
              class="h-9 w-auto rounded sm:h-11"
            />
          </template>
        </div>

        <div
          v-if="state.seats[state.settlement.winnerSeats[0]].flowers.length > 0"
          class="mt-3 flex items-center gap-1.5 border-t border-white/5 pt-2 text-xs text-[var(--muted)]"
        >
          <span>花牌：</span>
          <img
            v-for="(fId, fIdx) in state.seats[state.settlement.winnerSeats[0]].flowers"
            :key="`win-f-${fIdx}`"
            :src="`assets/tiles/tile_${kindOf(fId)}.png`"
            class="h-7 w-auto sm:h-8"
          />
        </div>
      </div>

      <!-- 台數明細列表 -->
      <div v-if="state.settlement.taiItems.length" class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div
          v-for="(item, idx) in state.settlement.taiItems"
          :key="idx"
          class="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-xs sm:text-sm border border-white/5"
        >
          <span class="text-[var(--ivory)]">{{ item.name }}</span>
          <span class="font-bold text-[var(--gold)]">{{ item.tai }} 台</span>
        </div>
      </div>

      <!-- 四家籌碼變動 -->
      <div class="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div
          v-for="seat in state.seats"
          :key="seat.seat"
          class="rounded-2xl border p-2.5 text-center transition"
          :class="
            state.settlement.scoreDeltas[seat.seat] > 0
              ? 'border-[var(--gold)]/40 bg-[var(--gold)]/10'
              : state.settlement.scoreDeltas[seat.seat] < 0
                ? 'border-rose-500/30 bg-rose-950/20'
                : 'border-white/5 bg-white/5'
          "
        >
          <p class="text-[11px] text-[var(--muted)]">
            {{ windLabels[((seat.seat + 4 - state.dealerSeat) % 4) as SeatIndex] }}家 · {{ seat.name }}
          </p>
          <p
            class="my-0.5 text-base font-black tabular-nums"
            :class="
              state.settlement.scoreDeltas[seat.seat] > 0
                ? 'text-[var(--gold)]'
                : state.settlement.scoreDeltas[seat.seat] < 0
                  ? 'text-rose-400'
                  : 'text-slate-400'
            "
          >
            {{
              state.settlement.scoreDeltas[seat.seat] > 0
                ? `+${state.settlement.scoreDeltas[seat.seat]}`
                : state.settlement.scoreDeltas[seat.seat]
            }}
          </p>
          <p class="text-[11px] tabular-nums text-[var(--muted)]">總計 ${{ seat.score }}</p>
        </div>
      </div>

      <!-- 底部按鈕 -->
      <div class="mt-6 flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          class="glass rounded-2xl px-5 py-2.5 text-sm font-semibold text-[var(--muted)] transition hover:text-white active:scale-95 cursor-pointer"
          @click="emit('backToLobby')"
        >
          返回大廳
        </button>
        <button
          type="button"
          class="rounded-2xl bg-gradient-to-r from-[var(--gold)] to-amber-500 px-6 py-2.5 text-sm font-black text-slate-950 shadow-lg transition hover:brightness-110 active:scale-95 cursor-pointer"
          @click="emit('nextRound')"
        >
          下一局（{{
            state.settlement.isExhaustiveDraw ||
            state.settlement.winnerSeats.includes(state.dealerSeat)
              ? '連莊'
              : '換莊'
          }}）
        </button>
      </div>
    </div>
  </div>
</template>
