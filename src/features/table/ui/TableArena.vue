<script setup lang="ts">
import { useTableSession } from '../application/useTableSession'
import ActionHud from './ActionHud.vue'
import SettlementModal from './SettlementModal.vue'

const { state } = useTableSession()
</script>

<template>
  <div class="relative fixed inset-0 w-full h-[100dvh] bg-emerald-950 flex flex-col justify-between p-4">
    <header class="flex items-center justify-between text-sm text-amber-200/90">
      <span>台灣 16 張麻將 · {{ state.roundWind.toUpperCase() }} 風圈</span>
      <span>剩餘牌山：{{ state.remainingTiles }} 張（鐵八墩留 16 張）</span>
    </header>
    <main class="flex-1 flex items-center justify-center">
      <div class="rounded-xl border border-amber-500/30 bg-emerald-900/60 px-8 py-6 text-center shadow-xl">
        <p class="text-lg font-bold text-amber-300">牌桌渲染區 (Phaser 3 TableScene)</p>
        <p class="mt-1 text-xs text-emerald-200/80">見 todo.md 派發 WP-1.1 ~ WP-4.2 逐步實作</p>
      </div>
    </main>
    <footer class="flex justify-center">
      <ActionHud />
    </footer>
    <SettlementModal />
  </div>
</template>
