<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { kindOf, type SeatIndex, type TileId } from '@/shared/kernel/types'
import { tileLabel } from '@/shared/wasm'
import type { TableState } from '../domain/tableState'

const props = withDefaults(
  defineProps<{
    state: TableState
    /** 連線客機不能自行開下一局，須等房主 */
    canAdvance?: boolean
    auditStatus?: 'pending' | 'ok' | 'fail' | 'degraded'
    auditNote?: string
    /** 防作弊牌局：可下載本機保存的簽章紀錄 */
    canExport?: boolean
    /** 測試模式全速放行結算彈窗 */
    fastPaced?: boolean
  }>(),
  { canAdvance: true, auditStatus: 'ok', auditNote: '', canExport: false, fastPaced: false },
)

const emit = defineEmits<{
  nextRound: []
  backToLobby: []
  exportEvidence: []
}>()

const windLabels: Record<SeatIndex, string> = { 0: '東', 1: '南', 2: '西', 3: '北' }
const tileSrc = (t: TileId) => `assets/tiles/tile_${kindOf(t)}.png`

const settlement = computed(() => props.state.settlement)
/** 暫時收起結算單，看牌桌上攤開的四家手牌 */
const peek = ref(false)
/** 胡牌後留給牌桌震動/特效與看牌的遊戲感頓點，頓點結束後才跳出結算單 */
const isDelayElapsed = ref(props.fastPaced)
let delayTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.state.phase === 'ROUND_SETTLEMENT' && !!settlement.value,
  (isSettle) => {
    peek.value = false
    if (delayTimer) clearTimeout(delayTimer)
    if (isSettle) {
      if (props.fastPaced) {
        isDelayElapsed.value = true
      } else {
        isDelayElapsed.value = false
        delayTimer = setTimeout(() => {
          isDelayElapsed.value = true
        }, 1100)
      }
    } else {
      isDelayElapsed.value = props.fastPaced
    }
  },
  { immediate: true },
)
const winner = computed(() => {
  const s = settlement.value
  return s && s.winnerSeats.length ? props.state.seats[s.winnerSeats[0]] : null
})

/** 胡張已併入手牌；拆出來單獨標示 */
const winnerHand = computed(() => {
  const p = winner.value
  if (!p) return { concealed: [] as TileId[], winTile: null as TileId | null }
  const win = settlement.value?.winningTile ?? null
  const idx = win === null ? -1 : p.concealed.lastIndexOf(win)
  if (idx < 0) return { concealed: p.concealed, winTile: null }
  return { concealed: p.concealed.filter((_, i) => i !== idx), winTile: win }
})

const headline = computed(() => {
  const s = settlement.value
  if (!s) return ''
  if (s.isExhaustiveDraw) return '荒牌流局'
  return s.winnerSeats.map((seat) => props.state.seats[seat].name).join('、')
})

const subline = computed(() => {
  const s = settlement.value
  if (!s) return ''
  if (s.isExhaustiveDraw) return '鐵八墩 · 莊家連莊'
  if (s.isTsumo) return '自摸 · 三家付'
  return s.loserSeat !== null ? `${props.state.seats[s.loserSeat].name} 放槍` : '榮胡'
})

const keepsDealer = computed(() => {
  const s = settlement.value
  return !!s && (s.isExhaustiveDraw || s.winnerSeats.includes(props.state.dealerSeat))
})

function seatWind(seat: SeatIndex): string {
  return windLabels[((seat + 4 - props.state.dealerSeat) % 4) as SeatIndex]
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`
}
</script>

<template>
  <Transition name="sheet">
    <div
      v-if="state.phase === 'ROUND_SETTLEMENT' && settlement && !peek && isDelayElapsed"
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/55 sm:items-center sm:p-5 short:items-center short:p-2"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settle-title"
    >
      <div
        class="sheet-card panel flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-[28px] text-[var(--ivory)] sm:rounded-[28px] short:max-h-[96dvh] short:rounded-[20px]"
      >
        <div class="scroll-thin flex-1 overflow-y-auto px-4 pb-4 pt-5 sm:px-7 sm:pt-7 short:pt-3">
          <!-- 標題 -->
          <div class="flex items-start gap-4">
            <div
              class="stamp grid shrink-0 place-items-center font-serif font-black"
              :class="settlement.isExhaustiveDraw ? 'stamp-draw' : 'stamp-win'"
              aria-hidden="true"
            >
              {{ settlement.isExhaustiveDraw ? '流' : settlement.isTsumo ? '自摸' : '胡' }}
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-[11px] font-bold tracking-[0.3em] text-[var(--muted)]">本局結算</p>
              <h2 id="settle-title" class="brass-text truncate font-serif text-2xl font-black sm:text-4xl">{{ headline }}</h2>
              <p class="mt-0.5 text-xs text-[var(--muted)] sm:text-sm">{{ subline }}</p>
            </div>
            <div v-if="!settlement.isExhaustiveDraw" class="shrink-0 text-right">
              <p class="font-serif text-4xl font-black leading-none tabular-nums text-[var(--brass-hi)] sm:text-6xl">
                {{ settlement.totalTai }}
              </p>
              <p class="mt-1 text-[11px] font-bold tracking-widest text-[var(--muted)]">台</p>
            </div>
          </div>

          <!-- 胡牌牌型 -->
          <div v-if="winner" class="hand-strip mt-5 rounded-2xl p-3 sm:p-4 short:mt-3 short:p-2">
            <div class="flex flex-wrap items-end gap-x-1 gap-y-2">
              <img
                v-for="(t, i) in winnerHand.concealed"
                :key="`c${i}`"
                :src="tileSrc(t)"
                :alt="tileLabel(t)"
                class="h-9 w-auto drop-shadow sm:h-12 short:h-8"
              />
              <template v-for="(meld, m) in winner.melds" :key="`m${m}`">
                <span class="mx-1 h-8 w-px self-center bg-white/15 sm:h-10" />
                <img
                  v-for="(t, i) in meld.tiles"
                  :key="`m${m}-${i}`"
                  :src="meld.type === 'ankan' && (i === 0 || i === 3) ? 'assets/tiles/tile_back.png' : tileSrc(t)"
                  :alt="tileLabel(t)"
                  class="h-8 w-auto drop-shadow sm:h-11 short:h-7"
                />
              </template>
              <span v-if="winnerHand.winTile !== null" class="flex shrink-0 items-end">
                <span class="mx-1 h-8 w-px self-center bg-white/15 sm:h-10" />
                <span class="flex flex-col items-center">
                  <img
                    :src="tileSrc(winnerHand.winTile)"
                    :alt="`胡張 ${tileLabel(winnerHand.winTile)}`"
                    class="win-tile h-10 w-auto sm:h-14 short:h-9"
                  />
                  <span class="mt-1 text-[10px] font-bold text-[var(--cinnabar-hi)]">胡張</span>
                </span>
              </span>
            </div>
            <div v-if="winner.flowers.length" class="mt-3 flex items-center gap-1.5 border-t border-white/10 pt-2.5">
              <span class="mr-1 text-[11px] font-bold text-[var(--muted)]">花</span>
              <img v-for="(f, i) in winner.flowers" :key="`f${i}`" :src="tileSrc(f)" :alt="tileLabel(f)" class="h-7 w-auto sm:h-8" />
            </div>
          </div>

          <!-- 台數明細 -->
          <ul v-if="settlement.taiItems.length" class="mt-4 short:mt-2 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
            <li v-for="(item, i) in settlement.taiItems" :key="i" class="flex items-baseline gap-2 text-sm">
              <span class="shrink-0 font-bold">{{ item.name }}</span>
              <span class="leader flex-1" aria-hidden="true" />
              <span class="shrink-0 font-serif font-black tabular-nums text-[var(--brass-hi)]">{{ item.tai }} 台</span>
            </li>
          </ul>

          <!-- 四家輸贏 -->
          <p v-if="settlement.notCounted" class="mt-4 text-[11px] font-bold text-[var(--brass-hi)] short:mt-2">
            本局曾降級，不計分：以下輸贏僅供參考，未加進累計分數
          </p>
          <div class="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 short:mt-3 short:grid-cols-4">
            <div
              v-for="seat in state.seats"
              :key="seat.seat"
              class="rounded-2xl border p-3 short:px-2.5 short:py-1.5"
              :class="
                settlement.scoreDeltas[seat.seat] > 0
                  ? 'border-[var(--jade)]/50 bg-[var(--jade)]/10'
                  : settlement.scoreDeltas[seat.seat] < 0
                    ? 'border-[var(--cinnabar)]/35 bg-[var(--cinnabar)]/[0.07]'
                    : 'border-white/8 bg-white/[0.03]'
              "
            >
              <div class="flex items-center gap-2">
                <span
                  class="grid size-6 shrink-0 place-items-center rounded-md font-serif text-xs font-black"
                  :class="seat.seat === state.dealerSeat ? 'bg-[var(--cinnabar)] text-white' : 'bg-white/10 text-[var(--ivory)]'"
                >
                  {{ seatWind(seat.seat) }}
                </span>
                <span class="truncate text-xs font-bold">{{ seat.name }}</span>
              </div>
              <p
                class="mt-2 font-serif text-xl font-black tabular-nums sm:text-2xl short:mt-0.5 short:text-lg"
                :class="[
                  settlement.notCounted && 'line-through opacity-50',
                  settlement.scoreDeltas[seat.seat] > 0
                    ? 'text-[var(--jade-hi)]'
                    : settlement.scoreDeltas[seat.seat] < 0
                      ? 'text-[#ff9c85]'
                      : 'text-[var(--faint)]',
                ]"
              >
                {{ signed(settlement.scoreDeltas[seat.seat]) }}
              </p>
              <p class="text-[11px] tabular-nums text-[var(--muted)]">共 {{ seat.score }}</p>
            </div>
          </div>
        </div>

        <!-- 底部 -->
        <div
          class="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-black/25 px-4 pb-[max(0.9rem,env(safe-area-inset-bottom))] pt-3 sm:px-7"
        >
          <p
            class="text-[11px]"
            :class="
              auditStatus === 'ok'
                ? 'text-[var(--jade-hi)]'
                : auditStatus === 'pending'
                  ? 'text-[var(--muted)]'
                  : auditStatus === 'degraded'
                    ? 'text-[var(--brass-hi)]'
                    : 'text-[#ff9c85]'
            "
            aria-live="polite"
          >
            {{ auditNote || (state.auditVerified ? '✓ 牌山承諾驗證通過' : '⚠ 牌山承諾異常') }}
            <span class="text-[var(--faint)]">· 底 {{ state.rules.basePoints }} / 台 {{ state.rules.taiPoints }}</span>
          </p>
          <div class="flex w-full gap-2 sm:w-auto short:w-auto">
            <button type="button" class="btn-ghost h-11 shrink-0 rounded-2xl px-4 text-sm font-bold" @click="peek = true">
              看牌
            </button>
            <button
              v-if="canExport"
              type="button"
              class="btn-ghost h-11 shrink-0 rounded-2xl px-4 text-sm font-bold"
              title="下載本機保存的簽章紀錄，可交給第三方驗證"
              @click="emit('exportEvidence')"
            >
              紀錄
            </button>
            <button type="button" class="btn-ghost h-11 flex-1 rounded-2xl px-5 text-sm font-bold sm:flex-none" @click="emit('backToLobby')">
              返回大廳
            </button>
            <button
              type="button"
              class="btn-brass h-11 flex-[2] rounded-2xl px-6 font-serif text-base font-black tracking-wider disabled:opacity-60 sm:flex-none"
              :disabled="!canAdvance"
              @click="emit('nextRound')"
            >
              {{ canAdvance ? `下一局 · ${keepsDealer ? '連莊' : '換莊'}` : '等待房主開下一局...' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
  <button
    v-if="state.phase === 'ROUND_SETTLEMENT' && settlement && peek && isDelayElapsed"
    type="button"
    class="btn-brass fixed left-1/2 top-1/2 z-50 h-11 -translate-x-1/2 -translate-y-1/2 rounded-full px-6 font-serif text-sm font-black tracking-wider shadow-2xl"
    @click="peek = false"
  >
    回到結算
  </button>
</template>

<style scoped>
@reference '../../../style.css';

.stamp {
  @apply size-14 rotate-[-8deg] rounded-xl text-lg sm:size-20 sm:text-2xl;
  box-shadow:
    inset 0 0 0 2px rgba(255, 255, 255, 0.35),
    0 10px 24px -8px rgba(0, 0, 0, 0.7);
}
.stamp-win {
  background: linear-gradient(180deg, var(--cinnabar-hi), var(--cinnabar) 60%, #a8291a);
  color: #fff;
}
.stamp-draw {
  background: #2a1b12;
  color: var(--muted);
  box-shadow: inset 0 0 0 2px rgba(212, 166, 74, 0.35);
}
.hand-strip {
  background: radial-gradient(circle at 50% 30%, var(--felt-in), var(--felt-out));
  box-shadow:
    inset 0 0 0 1px rgba(212, 166, 74, 0.3),
    inset 0 8px 20px rgba(0, 0, 0, 0.4);
}
.win-tile {
  filter: drop-shadow(0 0 8px rgba(224, 72, 47, 0.8));
  transform: translateY(-4px);
}
.leader {
  border-bottom: 1px dotted rgba(212, 166, 74, 0.35);
  transform: translateY(-4px);
}
.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.22s ease;
}
.sheet-enter-active .sheet-card,
.sheet-leave-active .sheet-card {
  transition: transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from .sheet-card,
.sheet-leave-to .sheet-card {
  transform: translateY(40px);
}
</style>
