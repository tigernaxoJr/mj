<script setup lang="ts">
import { shallowRef } from 'vue'
import { LobbyHub, type StartMatchPayload } from '@/features/lobby'
import { TableArena } from '@/features/table'

const activeMatch = shallowRef<StartMatchPayload | null>(null)

function handleStartMatch(payload: StartMatchPayload): void {
  activeMatch.value = payload
}

function handleLeaveTable(): void {
  activeMatch.value?.transport?.disconnect()
  activeMatch.value = null
}
</script>

<template>
  <TableArena
    v-if="activeMatch"
    :local-seat="activeMatch.localSeat"
    :is-host="activeMatch.isHost"
    :rules="activeMatch.rules"
    :room-seats="activeMatch.roomSeats"
    :transport="activeMatch.transport"
    :initial-round="activeMatch.initialRound"
    @leave-table="handleLeaveTable"
  />
  <LobbyHub v-else @start-match="handleStartMatch" />
</template>
