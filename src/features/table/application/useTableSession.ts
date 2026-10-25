import { ref } from 'vue'
import { createInitialTableState, type TableState } from '../domain/tableState'

export function useTableSession() {
  const state = ref<TableState>(createInitialTableState())
  return {
    state,
  }
}
