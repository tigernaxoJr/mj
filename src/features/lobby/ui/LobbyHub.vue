<script setup lang="ts">
import { reactive } from 'vue'
import type { SeatIndex } from '@/shared/kernel/types'
import {
  addBotToSeat,
  createRoomSession,
  fillEmptySeatsWithBots,
  isRoomReadyToStart,
  removeBotFromSeat,
} from '../domain/roomSession'

const emit = defineEmits<{
  startSolo: []
}>()

const room = reactive(createRoomSession('玩家本家', true))
const windLabels: Record<SeatIndex, string> = { 0: '東', 1: '南', 2: '西', 3: '北' }

function toggleBot(seat: SeatIndex): void {
  const slot = room.seats[seat]
  if (slot.occupant === 'bot') {
    removeBotFromSeat(room, seat)
  } else if (slot.occupant === 'empty') {
    addBotToSeat(room, seat)
  }
}
</script>

<template>
  <div class="fixed inset-0 w-full h-[100dvh] bg-emerald-950 flex flex-col items-center justify-center p-6">
    <div class="max-w-lg w-full rounded-2xl border border-amber-400/40 bg-emerald-900/80 p-6 text-center shadow-2xl">
      <h1 class="text-3xl font-extrabold tracking-wider text-amber-300">台灣 16 張麻將</h1>
      <p class="mt-1 text-xs text-emerald-100/80">Phaser 3 · Rust Wasm · WebRTC P2P · 支援電腦玩家補位</p>

      <div class="mt-5 grid grid-cols-2 gap-3 text-left">
        <div
          v-for="slot in room.seats"
          :key="slot.seat"
          class="flex items-center justify-between rounded-xl border border-emerald-700/80 bg-emerald-950/70 px-3 py-2.5"
        >
          <div>
            <span class="inline-block rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-bold text-amber-300">
              {{ windLabels[slot.seat] }}家
            </span>
            <p class="mt-1 text-sm font-semibold text-amber-50">{{ slot.name }}</p>
          </div>
          <button
            v-if="slot.seat !== 0"
            type="button"
            class="rounded-lg border px-2.5 py-1 text-xs font-semibold transition cursor-pointer"
            :class="
              slot.occupant === 'bot'
                ? 'border-rose-400/50 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
                : 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
            "
            @click="toggleBot(slot.seat)"
          >
            {{ slot.occupant === 'bot' ? '移除電腦' : '+ 加入電腦' }}
          </button>
        </div>
      </div>

      <div class="mt-5 flex gap-3">
        <button
          type="button"
          class="rounded-xl border border-amber-400/40 bg-emerald-800/70 px-4 py-3 text-sm font-semibold text-amber-200 transition hover:bg-emerald-800 cursor-pointer"
          @click="fillEmptySeatsWithBots(room)"
        >
          電腦補滿空位
        </button>
        <button
          type="button"
          :disabled="!isRoomReadyToStart(room)"
          class="flex-1 rounded-xl bg-amber-500 px-5 py-3 font-bold text-emerald-950 transition hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          @click="emit('startSolo')"
        >
          開局打牌（滿 4 家）
        </button>
      </div>
    </div>
  </div>
</template>
