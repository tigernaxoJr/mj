import {
  DEFAULT_RULE_CONFIG,
  isFlowerKind,
  kindOf,
  type MeldGroup,
  type PlayerActionCommand,
  type RoomSeatSlot,
  type RuleConfig,
  type SeatIndex,
  type SettlementSummary,
  type TileId,
  type TileKind,
  type TurnPhase,
  type WindName,
} from '@/shared/kernel/types'
import {
  canWinWithHand,
  chooseBotDiscard,
  createCommittedWall,
  evaluateTaiwanWin,
  findAnkanKinds,
  findChiiOptions,
  findKakanOptions,
  findMinkanTiles,
  findPonTiles,
  getWaitingKinds,
} from '@/shared/wasm'

export const DEAD_WALL_SIZE = 16 // 台灣 16 張麻將鐵八墩（海底留 16 張）

// ---- 防作弊牌局（Mental Poker）的部分資訊 ----
// 牌山位置尚未經持有者宣告時為 WALL_UNKNOWN；已宣告但本機看不到牌面時，以 hiddenTileAt(位置) 佔位。
// 佔位值為負數：不是花牌、不屬任何牌種，規則引擎把它當成「一張不知道是什麼的牌」。
export const WALL_UNKNOWN = -10_000

export function hiddenTileAt(wallIndex: number): TileId {
  return -(wallIndex + 1)
}

export function hiddenTileWallIndex(tile: TileId): number {
  return -tile - 1
}

/** 引擎需要讀取尚未宣告的牌山位置：由呼叫端取得持有者宣告後重跑同一步 */
export class WallPending extends Error {
  constructor(readonly positions: { wallIndex: number; seat: SeatIndex }[]) {
    super(`wall positions pending: ${positions.map((p) => p.wallIndex).join(',')}`)
  }
}

export interface PlayerSeatState {
  seat: SeatIndex
  name: string
  isBot: boolean
  concealed: TileId[]
  melds: MeldGroup[]
  flowers: TileId[]
  discards: TileId[]
  isMigi: boolean
  isTenhouMigi: boolean
  /** 同巡過水鎖定（放棄胡牌或碰牌後，在下次自己摸牌前不可胡/碰） */
  passLock: boolean
  score: number
  /** 本局是否尚未打出過任何牌（用於判定天地人胡與天聽） */
  firstTurnUnbroken: boolean
}

export interface SeatClaimOption {
  seat: SeatIndex
  canRon: boolean
  ponTiles: [TileId, TileId] | null
  minkanTiles: [TileId, TileId, TileId] | null
  chiiOptions: [TileId, TileId][]
  responded: boolean
  chosenAction: PlayerActionCommand | null
}

export interface SelfTurnOptions {
  canTsumo: boolean
  ankanOptions: { kind: TileKind; tiles: [TileId, TileId, TileId, TileId] }[]
  kakanOptions: { meldIndex: number; kind: TileKind; tileId: TileId }[]
  /** 若宣告聽牌 (MIGI)，可打出的手牌 ID 列表 */
  migiDiscardableTiles: TileId[]
}

export interface ActionCallout {
  id: number
  seat: SeatIndex
  label: '吃' | '碰' | '槓' | '聽' | '胡' | '自摸' | '補花'
}

export interface TableState {
  phase: TurnPhase
  roundWind: WindName
  dealerSeat: SeatIndex
  dealerStreak: number
  currentSeat: SeatIndex
  wallTiles: TileId[]
  wallSalts: string[]
  wallLeafHashes: string[]
  roundSeed: string
  hostSecret: string
  headCursor: number
  tailCursor: number
  remainingTiles: number
  /** 最近摸進的牌（供 UI 將剛摸到的第 17 張牌稍微拉開顯示） */
  lastDrawnTile: { seat: SeatIndex; tileId: TileId; isRinshan: boolean } | null
  lastDiscard: { seat: SeatIndex; tileId: TileId; isChankanTarget?: boolean } | null
  claimWindow: SeatClaimOption[]
  seats: [PlayerSeatState, PlayerSeatState, PlayerSeatState, PlayerSeatState]
  rules: RuleConfig
  settlement: SettlementSummary | null
  lastCallout: ActionCallout | null
  calloutSeq: number
  anyMeldHappened: boolean
  auditVerified: boolean
  /**
   * 防作弊牌局：沒有人知道別家手牌，所以每次打牌後其餘三家「一律」進入回應窗（沒得吃碰胡就自動過），
   * 宣告吃碰槓胡時再公開所用的牌，由各家自行驗證。
   */
  openClaims: boolean
}

const WIND_ORDER: readonly WindName[] = ['east', 'south', 'west', 'north']

export function sortTiles(tiles: TileId[]): TileId[] {
  return [...tiles].sort((a, b) => {
    const ka = kindOf(a)
    const kb = kindOf(b)
    return ka !== kb ? ka - kb : a - b
  })
}

export function createInitialTableState(
  rules: RuleConfig = DEFAULT_RULE_CONFIG,
  roomSeats?: readonly RoomSeatSlot[],
): TableState {
  const defaultNames = ['玩家東家', '電腦南風', '電腦西風', '電腦北風']
  const makeSeat = (seat: SeatIndex): PlayerSeatState => {
    const slot = roomSeats?.[seat]
    return {
      seat,
      name: slot?.name ?? defaultNames[seat],
      isBot: slot ? slot.occupant === 'bot' : seat !== 0,
      concealed: [],
      melds: [],
      flowers: [],
      discards: [],
      isMigi: false,
      isTenhouMigi: false,
      passLock: false,
      score: 10000,
      firstTurnUnbroken: true,
    }
  }
  return {
    phase: 'IDLE',
    roundWind: 'east',
    dealerSeat: 0,
    dealerStreak: 0,
    currentSeat: 0,
    wallTiles: [],
    wallSalts: [],
    wallLeafHashes: [],
    roundSeed: '',
    hostSecret: '',
    headCursor: 0,
    tailCursor: 144,
    remainingTiles: 128,
    lastDrawnTile: null,
    lastDiscard: null,
    claimWindow: [],
    seats: [makeSeat(0), makeSeat(1), makeSeat(2), makeSeat(3)],
    rules: { ...rules },
    settlement: null,
    lastCallout: null,
    calloutSeq: 0,
    anyMeldHappened: false,
    auditVerified: true,
    openClaims: false,
  }
}

function updateRemainingCount(state: TableState): void {
  const raw = Math.max(0, state.tailCursor - state.headCursor - DEAD_WALL_SIZE)
  state.remainingTiles = raw
}

function wallAt(state: TableState, wallIndex: number, seat: SeatIndex): TileId {
  const tile = state.wallTiles[wallIndex]
  if (tile === WALL_UNKNOWN) throw new WallPending([{ wallIndex, seat }])
  return tile
}

function drawFromHead(state: TableState, seat: SeatIndex): TileId | null {
  updateRemainingCount(state)
  if (state.remainingTiles <= 0) return null
  const tile = wallAt(state, state.headCursor, seat)
  state.headCursor++
  updateRemainingCount(state)
  return tile
}

function drawFromTail(state: TableState, seat: SeatIndex): TileId | null {
  updateRemainingCount(state)
  if (state.remainingTiles <= 0) return null
  const tile = wallAt(state, state.tailCursor - 1, seat)
  state.tailCursor--
  updateRemainingCount(state)
  return tile
}

/** 開局配牌順序：位置 0..64 各發給哪一家（4 輪 × 4 家 × 4 張，莊家再補第 17 張） */
export function dealPositionOwners(dealerSeat: SeatIndex): SeatIndex[] {
  const owners: SeatIndex[] = []
  for (let round = 0; round < 4; round++) {
    for (let offset = 0; offset < 4; offset++) {
      const seat = ((dealerSeat + offset) % 4) as SeatIndex
      for (let c = 0; c < 4; c++) owners.push(seat)
    }
  }
  owners.push(dealerSeat)
  return owners
}

function pushCallout(state: TableState, seat: SeatIndex, label: ActionCallout['label']): void {
  state.calloutSeq++
  state.lastCallout = { id: state.calloutSeq, seat, label }
}

/** 替指定座位執行連續嶺上補花，直到該座位手牌中無任何花牌 */
function replaceFlowersForSeat(state: TableState, seat: SeatIndex): boolean {
  const player = state.seats[seat]
  let hadFlower = false
  while (true) {
    const flowerIds = player.concealed.filter((id) => isFlowerKind(kindOf(id)))
    if (flowerIds.length === 0) break
    hadFlower = true
    player.concealed = player.concealed.filter((id) => !isFlowerKind(kindOf(id)))
    player.flowers.push(...flowerIds)
    player.flowers = sortTiles(player.flowers)

    for (let i = 0; i < flowerIds.length; i++) {
      if (player.flowers.length === 8) {
        // 八仙過海直接滿花胡牌
        settleWin(state, [seat], null, true, flowerIds[flowerIds.length - 1], true, false, false)
        return true
      }
      const rep = drawFromTail(state, seat)
      if (rep === null) break
      player.concealed.push(rep)
    }
  }
  player.concealed = sortTiles(player.concealed)
  if (hadFlower) {
    pushCallout(state, seat, '補花')
  }
  return false
}

/** 開啟新牌局：洗牌、抓牌（閒 16 莊 17）、開門補花 */
export function startRound(
  state: TableState,
  roundSeed = `seed-${Date.now()}`,
  hostSecret = `secret-${Math.random().toString(36).slice(2)}`,
): void {
  const committed = createCommittedWall(roundSeed, hostSecret)
  state.roundSeed = roundSeed
  state.hostSecret = hostSecret
  state.wallSalts = committed.salts
  state.wallLeafHashes = committed.leafHashes
  state.openClaims = false
  dealRound(state, committed.tiles)
}

/**
 * 防作弊牌局開局：`wall` 為本機已知的牌山（未宣告位置為 WALL_UNKNOWN）。
 * 配牌位置尚未宣告時一次丟出全部 65 個位置，讓各家批次送出金鑰分享。
 */
export function startSecureRound(state: TableState, wall: readonly TileId[]): void {
  const owners = dealPositionOwners(state.dealerSeat)
  const pending = owners
    .map((seat, wallIndex) => ({ wallIndex, seat }))
    .filter(({ wallIndex }) => wall[wallIndex] === WALL_UNKNOWN)
  if (pending.length > 0) throw new WallPending(pending)
  state.roundSeed = ''
  state.hostSecret = ''
  state.wallSalts = []
  state.wallLeafHashes = []
  state.openClaims = true
  dealRound(state, [...wall])
}

function dealRound(state: TableState, wallTiles: TileId[]): void {
  state.wallTiles = wallTiles
  state.headCursor = 0
  state.tailCursor = 144
  state.settlement = null
  state.claimWindow = []
  state.lastDiscard = null
  state.lastDrawnTile = null
  state.anyMeldHappened = false
  state.auditVerified = true

  for (const s of state.seats) {
    s.concealed = []
    s.melds = []
    s.flowers = []
    s.discards = []
    s.isMigi = false
    s.isTenhouMigi = false
    s.passLock = false
    s.firstTurnUnbroken = true
  }

  state.phase = 'DEALING'
  // 4 家各抓 16 張，莊家開門多抓第 17 張
  for (const seat of dealPositionOwners(state.dealerSeat)) {
    const t = drawFromHead(state, seat)
    if (t !== null) state.seats[seat].concealed.push(t)
  }

  // 開門補花階段：由莊家起逆時針依序補花
  state.phase = 'FLOWER_REPLACEMENT'
  for (let offset = 0; offset < 4; offset++) {
    const seat = ((state.dealerSeat + offset) % 4) as SeatIndex
    const ended = replaceFlowersForSeat(state, seat)
    if (ended) return
  }

  // 將莊家最後一張牌設為 lastDrawnTile 方便視覺區隔
  const dealerHand = state.seats[state.dealerSeat].concealed
  if (dealerHand.length > 0) {
    state.lastDrawnTile = {
      seat: state.dealerSeat,
      tileId: dealerHand[dealerHand.length - 1],
      isRinshan: false,
    }
  }

  state.currentSeat = state.dealerSeat
  state.phase = 'TURN_ACTION_OR_DISCARD'
}

/** 計算當前行動座位（已摸牌或已吃碰，手牌 $3n+2$）可執行的自身動作 */
export function getSelfTurnOptions(state: TableState, seat: SeatIndex): SelfTurnOptions {
  if (state.phase !== 'TURN_ACTION_OR_DISCARD' || state.currentSeat !== seat) {
    return { canTsumo: false, ankanOptions: [], kakanOptions: [], migiDiscardableTiles: [] }
  }
  const player = state.seats[seat]
  const expectedLen = (5 - player.melds.length) * 3 + 2
  const hasFullHand = player.concealed.length === expectedLen

  // 剛吃或碰完不可自摸、暗槓或加槓（必須先打出一張牌；唯有摸牌或嶺上補牌後才可自摸/槓）
  const justDrew = state.lastDrawnTile?.seat === seat
  const canTsumo =
    justDrew &&
    hasFullHand &&
    (canWinWithHand(player.concealed, player.melds.length) || player.flowers.length === 8)

  const ankanOptions = justDrew && !player.isMigi ? findAnkanKinds(player.concealed) : []
  const kakanOptions =
    justDrew && !player.isMigi ? findKakanOptions(player.concealed, player.melds) : []

  const migiDiscardableTiles: TileId[] = []
  if (!player.isMigi && player.melds.every((m) => m.type === 'ankan') && hasFullHand) {
    for (const tileId of player.concealed) {
      const idx = player.concealed.indexOf(tileId)
      const rem = [...player.concealed.slice(0, idx), ...player.concealed.slice(idx + 1)]
      if (getWaitingKinds(rem, player.melds.length).length > 0) {
        migiDiscardableTiles.push(tileId)
      }
    }
  }

  return { canTsumo, ankanOptions, kakanOptions, migiDiscardableTiles }
}

/** 輪到指定座位摸牌（從牌山正面摸 1 張，若為花牌自動嶺上補花） */
export function drawTileForCurrentSeat(state: TableState, isRinshan = false): void {
  const seat = state.currentSeat
  const player = state.seats[seat]
  player.passLock = false

  const drawn = isRinshan ? drawFromTail(state, seat) : drawFromHead(state, seat)
  if (drawn === null) {
    // 鐵八墩流局（臭莊）
    settleExhaustiveDraw(state)
    return
  }

  player.concealed.push(drawn)
  let actualRinshan = isRinshan

  // 若摸到花牌，持續從嶺上補牌直到非花牌
  while (player.concealed.some((id) => isFlowerKind(kindOf(id)))) {
    const flowers = player.concealed.filter((id) => isFlowerKind(kindOf(id)))
    player.concealed = player.concealed.filter((id) => !isFlowerKind(kindOf(id)))
    player.flowers.push(...flowers)
    player.flowers = sortTiles(player.flowers)
    pushCallout(state, seat, '補花')
    actualRinshan = true

    if (player.flowers.length === 8) {
      settleWin(state, [seat], null, true, flowers[flowers.length - 1], true, false, false)
      return
    }

    const rep = drawFromTail(state, seat)
    if (rep === null) {
      settleExhaustiveDraw(state)
      return
    }
    player.concealed.push(rep)
  }

  const newestTile = player.concealed[player.concealed.length - 1]
  // 將前 16 張排序，最新摸到的第 17 張放在最右側方便辨識
  const prefix = sortTiles(player.concealed.slice(0, -1))
  player.concealed = [...prefix, newestTile]
  state.lastDrawnTile = { seat, tileId: newestTile, isRinshan: actualRinshan }
  state.phase = 'TURN_ACTION_OR_DISCARD'
}

/** 執行玩家回合動作或副露回應 */
export function applyPlayerAction(
  state: TableState,
  seat: SeatIndex,
  action: PlayerActionCommand,
): boolean {
  if (state.phase === 'TURN_ACTION_OR_DISCARD' && state.currentSeat === seat) {
    const player = state.seats[seat]
    switch (action.type) {
      case 'TSUMO': {
        const opts = getSelfTurnOptions(state, seat)
        if (!opts.canTsumo) return false
        const winTile =
          state.lastDrawnTile?.tileId ?? player.concealed[player.concealed.length - 1]
        const isRinshan = state.lastDrawnTile?.isRinshan ?? false
        player.concealed.splice(player.concealed.lastIndexOf(winTile), 1)
        pushCallout(state, seat, '自摸')
        settleWin(
          state,
          [seat],
          null,
          true,
          winTile,
          isRinshan,
          false,
          state.remainingTiles === 0,
        )
        return true
      }

      case 'ANKAN': {
        const opts = getSelfTurnOptions(state, seat)
        const found = opts.ankanOptions.find((o) => o.kind === action.kind)
        if (!found) return false
        player.concealed = player.concealed.filter((id) => kindOf(id) !== action.kind)
        player.melds.push({
          type: 'ankan',
          tiles: sortTiles([...found.tiles]),
        })
        state.anyMeldHappened = true
        player.firstTurnUnbroken = false
        pushCallout(state, seat, '槓')
        drawTileForCurrentSeat(state, true)
        return true
      }

      case 'KAKAN': {
        const opts = getSelfTurnOptions(state, seat)
        const found = opts.kakanOptions.find((o) => o.kind === action.kind)
        if (!found) return false
        const idx = player.concealed.indexOf(found.tileId)
        if (idx >= 0) player.concealed.splice(idx, 1)
        const meld = player.melds[found.meldIndex]
        meld.type = 'kakan'
        meld.tiles.push(found.tileId)
        state.anyMeldHappened = true
        player.firstTurnUnbroken = false
        pushCallout(state, seat, '槓')

        // 檢查其他三家是否可搶槓胡
        const chankanClaims: SeatClaimOption[] = []
        for (let offset = 1; offset <= 3; offset++) {
          const otherSeat = ((seat + offset) % 4) as SeatIndex
          const opt = claimOptionFor(state, otherSeat, found.tileId, seat, true)
          if (opt.canRon || state.openClaims) chankanClaims.push(opt)
        }
        if (chankanClaims.length > 0) {
          state.lastDiscard = { seat, tileId: found.tileId, isChankanTarget: true }
          state.claimWindow = chankanClaims
          state.phase = 'CLAIM_WINDOW'
          return true
        }

        drawTileForCurrentSeat(state, true)
        return true
      }

      case 'DECLARE_MIGI': {
        const opts = getSelfTurnOptions(state, seat)
        // 防作弊牌局看不到別家整手牌，聽牌是否成立留到結算重播驗證
        const unverifiable = state.openClaims && player.concealed.some((t) => t < 0)
        if (!unverifiable && !opts.migiDiscardableTiles.includes(action.discardTileId)) return false
        player.isMigi = true
        if (player.firstTurnUnbroken && !state.anyMeldHappened) {
          player.isTenhouMigi = true
        }
        pushCallout(state, seat, '聽')
        return executeDiscardInternal(state, seat, action.discardTileId)
      }

      case 'DISCARD': {
        return executeDiscardInternal(state, seat, action.tileId)
      }

      default:
        return false
    }
  }

  if (state.phase === 'CLAIM_WINDOW') {
    return submitClaimResponse(state, seat, action)
  }

  return false
}

function executeDiscardInternal(state: TableState, seat: SeatIndex, tileId: TileId): boolean {
  const player = state.seats[seat]
  const pos = player.concealed.indexOf(tileId)
  if (pos < 0) return false

  player.concealed.splice(pos, 1)
  player.concealed = sortTiles(player.concealed)
  player.discards.push(tileId)
  state.lastDrawnTile = null
  state.lastDiscard = { seat, tileId, isChankanTarget: false }

  // 檢查其餘三家是否有吃、碰、明槓、榮胡
  const claims: SeatClaimOption[] = []
  for (let offset = 1; offset <= 3; offset++) {
    const opt = claimOptionFor(state, ((seat + offset) % 4) as SeatIndex, tileId, seat, false)
    if (state.openClaims || opt.canRon || opt.ponTiles || opt.minkanTiles || opt.chiiOptions.length > 0) {
      claims.push(opt)
    }
  }

  player.firstTurnUnbroken = false

  if (claims.length > 0) {
    state.claimWindow = claims
    state.phase = 'CLAIM_WINDOW'
    return true
  }

  // 無人可吃碰槓胡：若牌山已達鐵八墩（0 張可摸）則流局，否則下家摸牌
  if (state.remainingTiles <= 0) {
    settleExhaustiveDraw(state)
    return true
  }

  state.currentSeat = ((seat + 1) % 4) as SeatIndex
  drawTileForCurrentSeat(state, false)
  return true
}

/** 某家對打出（或加槓）的牌可做的回應；防作弊牌局中別家手牌未知，算出來就是「沒有選項」 */
function claimOptionFor(
  state: TableState,
  seat: SeatIndex,
  tileId: TileId,
  discarderSeat: SeatIndex,
  chankan: boolean,
): SeatClaimOption {
  const other = state.seats[seat]
  const canRon = !other.passLock && canWinWithHand(other.concealed, other.melds.length, tileId)
  const open = !chankan && !other.isMigi
  const ponTiles = open && !other.passLock ? findPonTiles(other.concealed, tileId) : null
  const minkanTiles =
    open && !other.passLock && state.remainingTiles > 0 ? findMinkanTiles(other.concealed, tileId) : null
  const isNextSeat = (discarderSeat + 1) % 4 === seat
  const chiiOptions = open ? findChiiOptions(other.concealed, tileId, isNextSeat) : []
  return { seat, canRon, ponTiles, minkanTiles, chiiOptions, responded: false, chosenAction: null }
}

function claimPriorityOf(action: PlayerActionCommand | null): number {
  if (!action) return 0
  switch (action.type) {
    case 'CLAIM_RON':
      return 3
    case 'CLAIM_MINKAN':
    case 'CLAIM_PON':
      return 2
    case 'CLAIM_CHII':
      return 1
    default:
      return 0
  }
}

function submitClaimResponse(
  state: TableState,
  seat: SeatIndex,
  action: PlayerActionCommand,
): boolean {
  const entry = state.claimWindow.find((c) => c.seat === seat)
  if (!entry || entry.responded) return false

  // 防作弊牌局：宣告者已公開所用的牌，依目前已知的手牌重算選項再驗證
  if (state.openClaims && state.lastDiscard && action.type !== 'CLAIM_PASS') {
    const d = state.lastDiscard
    Object.assign(entry, claimOptionFor(state, seat, d.tileId, d.seat, Boolean(d.isChankanTarget)))
  }

  // 驗證動作合法性
  if (action.type === 'CLAIM_RON' && !entry.canRon) return false
  if (action.type === 'CLAIM_PON' && !entry.ponTiles) return false
  if (action.type === 'CLAIM_MINKAN' && !entry.minkanTiles) return false
  if (action.type === 'CLAIM_CHII') {
    const valid = entry.chiiOptions.some(
      (pair) =>
        (pair[0] === action.meldTiles[0] && pair[1] === action.meldTiles[1]) ||
        (pair[0] === action.meldTiles[1] && pair[1] === action.meldTiles[0]),
    )
    if (!valid) return false
  }

  // 若可胡或可碰卻選擇放棄（或選擇低階動作），設定同巡過水鎖定
  if ((entry.canRon || entry.ponTiles) && action.type === 'CLAIM_PASS') {
    state.seats[seat].passLock = true
  }

  entry.responded = true
  entry.chosenAction = action

  if (state.claimWindow.every((c) => c.responded)) {
    resolveAllSubmittedClaims(state)
  }
  return true
}

function resolveAllSubmittedClaims(state: TableState): void {
  const discardInfo = state.lastDiscard
  if (!discardInfo) return

  const discarderSeat = discardInfo.seat
  const discardTile = discardInfo.tileId
  const isChankan = Boolean(discardInfo.isChankanTarget)

  const turnDist = (claimer: SeatIndex): number => (claimer + 4 - discarderSeat) % 4

  const maxPrio = Math.max(...state.claimWindow.map((c) => claimPriorityOf(c.chosenAction)), 0)

  if (maxPrio === 0) {
    state.claimWindow = []
    if (isChankan) {
      // 無人搶槓胡，加槓者從嶺上補牌
      drawTileForCurrentSeat(state, true)
      return
    }
    if (state.remainingTiles <= 0) {
      settleExhaustiveDraw(state)
      return
    }
    state.currentSeat = ((discarderSeat + 1) % 4) as SeatIndex
    drawTileForCurrentSeat(state, false)
    return
  }

  const topClaims = state.claimWindow
    .filter((c) => claimPriorityOf(c.chosenAction) === maxPrio)
    .sort((a, b) => turnDist(a.seat) - turnDist(b.seat))

  state.claimWindow = []

  // 1. 榮胡裁決（攔胡 vs 一炮多響）
  if (maxPrio === 3) {
    const winners = state.rules.allowMultiRon
      ? topClaims.map((c) => c.seat)
      : [topClaims[0].seat]
    // 從捨牌者牌海移除被胡的那張牌
    const discarder = state.seats[discarderSeat]
    if (!isChankan && discarder.discards[discarder.discards.length - 1] === discardTile) {
      discarder.discards.pop()
    }
    pushCallout(state, winners[0], '胡')
    settleWin(
      state,
      winners,
      discarderSeat,
      false,
      discardTile,
      false,
      isChankan,
      state.remainingTiles === 0 && !isChankan,
    )
    return
  }

  // 2. 碰 / 明槓 / 吃 裁決（取最高優先序第一人）
  const winnerEntry = topClaims[0]
  const claimer = state.seats[winnerEntry.seat]
  const action = winnerEntry.chosenAction!

  const discarder = state.seats[discarderSeat]
  if (discarder.discards[discarder.discards.length - 1] === discardTile) {
    discarder.discards.pop()
  }

  state.anyMeldHappened = true
  for (const s of state.seats) {
    s.firstTurnUnbroken = false
  }
  state.lastDiscard = null
  state.currentSeat = winnerEntry.seat

  if (action.type === 'CLAIM_MINKAN' && winnerEntry.minkanTiles) {
    for (const t of winnerEntry.minkanTiles) {
      const idx = claimer.concealed.indexOf(t)
      if (idx >= 0) claimer.concealed.splice(idx, 1)
    }
    claimer.melds.push({
      type: 'minkan',
      tiles: sortTiles([...winnerEntry.minkanTiles, discardTile]),
      fromSeat: discarderSeat,
      calledTile: discardTile,
    })
    pushCallout(state, winnerEntry.seat, '槓')
    drawTileForCurrentSeat(state, true)
    return
  }

  if (action.type === 'CLAIM_PON' && winnerEntry.ponTiles) {
    for (const t of winnerEntry.ponTiles) {
      const idx = claimer.concealed.indexOf(t)
      if (idx >= 0) claimer.concealed.splice(idx, 1)
    }
    claimer.melds.push({
      type: 'pon',
      tiles: sortTiles([...winnerEntry.ponTiles, discardTile]),
      fromSeat: discarderSeat,
      calledTile: discardTile,
    })
    claimer.concealed = sortTiles(claimer.concealed)
    state.lastDrawnTile = null
    pushCallout(state, winnerEntry.seat, '碰')
    state.phase = 'TURN_ACTION_OR_DISCARD'
    return
  }

  if (action.type === 'CLAIM_CHII') {
    for (const t of action.meldTiles) {
      const idx = claimer.concealed.indexOf(t)
      if (idx >= 0) claimer.concealed.splice(idx, 1)
    }
    claimer.melds.push({
      type: 'chii',
      tiles: sortTiles([action.meldTiles[0], action.meldTiles[1], discardTile]),
      fromSeat: discarderSeat,
      calledTile: discardTile,
    })
    claimer.concealed = sortTiles(claimer.concealed)
    state.lastDrawnTile = null
    pushCallout(state, winnerEntry.seat, '吃')
    state.phase = 'TURN_ACTION_OR_DISCARD'
  }
}

function settleExhaustiveDraw(state: TableState): void {
  state.phase = 'ROUND_SETTLEMENT'
  state.settlement = {
    winnerSeats: [],
    loserSeat: null,
    isTsumo: false,
    isExhaustiveDraw: true,
    winningTile: null,
    taiItems: [{ name: '鐵八墩流局（臭莊連莊）', tai: 0 }],
    totalTai: 0,
    scoreDeltas: [0, 0, 0, 0],
  }
}

function settleWin(
  state: TableState,
  winnerSeats: SeatIndex[],
  loserSeat: SeatIndex | null,
  isTsumo: boolean,
  winningTile: TileId,
  isRinshan: boolean,
  isChankan: boolean,
  isLastTile: boolean,
): void {
  const primaryWinner = winnerSeats[0]
  const winnerState = state.seats[primaryWinner]
  const roundWindIdx = WIND_ORDER.indexOf(state.roundWind) as SeatIndex

  const isTenhou =
    isTsumo &&
    primaryWinner === state.dealerSeat &&
    winnerState.firstTurnUnbroken &&
    !state.anyMeldHappened &&
    winnerState.discards.length === 0
  const isChiihou =
    isTsumo &&
    primaryWinner !== state.dealerSeat &&
    winnerState.firstTurnUnbroken &&
    !state.anyMeldHappened &&
    winnerState.discards.length === 0
  const isRenhou =
    !isTsumo &&
    winnerState.firstTurnUnbroken &&
    !state.anyMeldHappened &&
    winnerState.discards.length === 0

  const scoreDeltas: [number, number, number, number] = [0, 0, 0, 0]
  let primaryBreakdown = { items: [] as { name: string; tai: number }[], totalTai: 0, totalPoints: 0 }

  for (const wSeat of winnerSeats) {
    const wPlayer = state.seats[wSeat]
    const wSeatWind = ((wSeat + 4 - state.dealerSeat) % 4) as SeatIndex

    if (isTsumo) {
      // 自摸：其餘三家各付（若胡牌者是莊家，三家皆付莊家連拉台；若胡牌者是閒家，僅莊家那一家多付莊家連拉台）
      for (const payer of [0, 1, 2, 3] as const) {
        if (payer === wSeat) continue
        const involvesDealer = wSeat === state.dealerSeat || payer === state.dealerSeat
        const evalRes = evaluateTaiwanWin({
          concealed: wPlayer.concealed,
          melds: wPlayer.melds,
          flowers: wPlayer.flowers,
          winningTile,
          isTsumo: true,
          roundWind: roundWindIdx,
          seatWind: wSeatWind,
          involvesDealer,
          dealerStreak: state.dealerStreak,
          isMigi: wPlayer.isMigi,
          isTenhouMigi: wPlayer.isTenhouMigi,
          isTenhou,
          isChiihou,
          isRenhou: false,
          isLastTile,
          isRinshan,
          isChankan: false,
          isSevenRobOne: false,
          basePoints: state.rules.basePoints,
          taiPoints: state.rules.taiPoints,
        })
        if (wSeat === primaryWinner && (payer === state.dealerSeat || primaryBreakdown.items.length === 0)) {
          primaryBreakdown = evalRes
        }
        scoreDeltas[payer] -= evalRes.totalPoints
        scoreDeltas[wSeat] += evalRes.totalPoints
      }
    } else if (loserSeat !== null) {
      const involvesDealer = wSeat === state.dealerSeat || loserSeat === state.dealerSeat
      const evalRes = evaluateTaiwanWin({
        concealed: wPlayer.concealed,
        melds: wPlayer.melds,
        flowers: wPlayer.flowers,
        winningTile,
        isTsumo: false,
        roundWind: roundWindIdx,
        seatWind: wSeatWind,
        involvesDealer,
        dealerStreak: state.dealerStreak,
        isMigi: wPlayer.isMigi,
        isTenhouMigi: wPlayer.isTenhouMigi,
        isTenhou: false,
        isChiihou: false,
        isRenhou,
        isLastTile,
        isRinshan: false,
        isChankan,
        isSevenRobOne: false,
        basePoints: state.rules.basePoints,
        taiPoints: state.rules.taiPoints,
      })
      if (wSeat === primaryWinner) {
        primaryBreakdown = evalRes
      }
      scoreDeltas[loserSeat] -= evalRes.totalPoints
      scoreDeltas[wSeat] += evalRes.totalPoints
    }
  }

  for (const s of [0, 1, 2, 3] as const) {
    state.seats[s].score += scoreDeltas[s]
  }
  // 將胡牌張加回贏家手牌尾端以便結算展示
  for (const wSeat of winnerSeats) {
    if (!isFlowerKind(kindOf(winningTile))) {
      state.seats[wSeat].concealed.push(winningTile)
    }
  }

  state.phase = 'ROUND_SETTLEMENT'
  state.settlement = {
    winnerSeats,
    loserSeat,
    isTsumo,
    isExhaustiveDraw: false,
    winningTile,
    taiItems: primaryBreakdown.items,
    totalTai: primaryBreakdown.totalTai,
    scoreDeltas,
  }
}

/** 電腦玩家在當前狀態下的自動決策 */
export function decideBotActionForSeat(
  state: TableState,
  seat: SeatIndex,
): PlayerActionCommand | null {
  const player = state.seats[seat]
  if (state.phase === 'TURN_ACTION_OR_DISCARD' && state.currentSeat === seat) {
    const opts = getSelfTurnOptions(state, seat)
    if (opts.canTsumo) {
      return { type: 'TSUMO' }
    }
    if (opts.ankanOptions.length > 0) {
      return { type: 'ANKAN', kind: opts.ankanOptions[0].kind }
    }
    if (opts.kakanOptions.length > 0) {
      return { type: 'KAKAN', kind: opts.kakanOptions[0].kind }
    }
    if (opts.migiDiscardableTiles.length > 0) {
      const bestMigiDiscard = chooseBotDiscard(player.concealed, player.melds, false, opts.migiDiscardableTiles)
      return { type: 'DECLARE_MIGI', discardTileId: bestMigiDiscard }
    }
    const discardTileId = chooseBotDiscard(player.concealed, player.melds, player.isMigi)
    return { type: 'DISCARD', tileId: discardTileId }
  }

  if (state.phase === 'CLAIM_WINDOW') {
    const entry = state.claimWindow.find((c) => c.seat === seat && !c.responded)
    if (!entry) return null
    if (entry.canRon) {
      return { type: 'CLAIM_RON' }
    }
    if (entry.ponTiles && player.melds.length <= 3) {
      // 電腦玩家擁有字牌對子或三元對子時積極碰牌
      const k = kindOf(entry.ponTiles[0])
      if (k >= 27 || player.concealed.length <= 10) {
        return { type: 'CLAIM_PON' }
      }
    }
    return { type: 'CLAIM_PASS' }
  }

  return null
}

/** 結算後進入下一局（莊家胡牌或臭莊則連莊 `dealerStreak + 1`，否則下家接莊） */
export function prepareNextRound(
  state: TableState,
  roundSeed = `seed-${Date.now()}`,
  hostSecret = `secret-${Math.random().toString(36).slice(2)}`,
): void {
  rotateDealer(state)
  startRound(state, roundSeed, hostSecret)
}

/** 依上一局結算決定連莊或換莊（防作弊牌局另行發牌時單獨呼叫） */
export function rotateDealer(state: TableState): void {
  const settlement = state.settlement
  if (settlement) {
    const dealerRetained =
      settlement.isExhaustiveDraw || settlement.winnerSeats.includes(state.dealerSeat)
    if (dealerRetained) {
      state.dealerStreak += 1
    } else {
      state.dealerStreak = 0
      const nextDealer = ((state.dealerSeat + 1) % 4) as SeatIndex
      if (nextDealer === 0) {
        const nextWindIdx = (WIND_ORDER.indexOf(state.roundWind) + 1) % 4
        state.roundWind = WIND_ORDER[nextWindIdx]
      }
      state.dealerSeat = nextDealer
    }
  }
  // 避免重複換莊
  state.settlement = null
}
