import type { SeatIndex } from '@/shared/kernel/types'
import type { TableState } from './tableState'

/** 他家被蓋住的手牌以此佔位（牌面種類無意義，畫面只依張數畫牌背） */
export const HIDDEN_TILE = -1

/**
 * 產生某位玩家「看得到的」牌桌狀態：去掉牌山與密鑰、蓋住他家手牌與其宣告意圖。
 * 結算後（ROUND_SETTLEMENT）四家手牌公開。房主廣播與客機稽核重播共用此函式，
 * 兩邊對同一局面必得相同結果。
 */
export function maskStateFor(state: TableState, viewer: SeatIndex): TableState {
  const view = JSON.parse(JSON.stringify(state)) as TableState
  const settled = view.phase === 'ROUND_SETTLEMENT'

  view.wallTiles = []
  view.wallSalts = []
  view.hostSecret = ''
  view.auditVerified = true

  if (!settled) {
    for (const s of view.seats) {
      if (s.seat !== viewer) s.concealed = s.concealed.map(() => HIDDEN_TILE)
    }
    if (view.lastDrawnTile && view.lastDrawnTile.seat !== viewer) {
      view.lastDrawnTile.tileId = HIDDEN_TILE
    }
    view.claimWindow = view.claimWindow.map((c) =>
      c.seat === viewer
        ? c
        : {
            seat: c.seat,
            canRon: false,
            ponTiles: null,
            minkanTiles: null,
            chiiOptions: [],
            responded: c.responded,
            chosenAction: null,
          },
    )
  }
  return view
}

/** 鍵排序後的 JSON，抵銷序列化往返造成的欄位順序／undefined 差異 */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, x]) => [k, norm(x)]),
      )
    }
    return v
  }
  return JSON.stringify(norm(value))
}
