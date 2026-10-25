<script setup lang="ts">
import { ref } from 'vue'
import { LobbyHub } from '@/features/lobby'
import { TableArena } from '@/features/table'

const inTable = ref(false)
</script>

<template>
  <TableArena v-if="inTable" />
  <LobbyHub v-else @start-solo="inTable = true" />
</template>
