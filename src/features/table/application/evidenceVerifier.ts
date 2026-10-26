/**
 * WP-5.6: 第三方驗證證據檔
 *
 * 證據檔是某位玩家依序收到的全部簽章信封。驗證者不必相信下載者或房主：
 *   1. 用檔案內的公鑰重新驗每一則簽章與遞增序號（被改過一個字就會失敗）。
 *   2. 每一局用公開的秘密重算洗牌與換鑰（mpAuditRound），解出完整牌山。
 *   3. 以完整資訊從第一局起重播所有動作，找出違規的座位並重算每局分數。
 * 降級的局只能驗證房主的重洗承諾，之後各局的分數無法從頭重算（牌山稽核仍照做）。
 */
import { DEFAULT_RULE_CONFIG, type PlayerActionCommand, type SeatIndex } from '@/shared/kernel/types'
import { base64ToBytes, mpAuditRound } from '@/shared/wasm'
import { seatHasDuty } from '../domain/secureAudit'
import { applyPlayerAction, createInitialTableState, rotateDealer, startSecureRound } from '../domain/tableState'
import { verifyDegradedWall, type DegradeWall } from './degradeProtocol'
import { openEnvelope, type EvidenceLog } from './secureChannel'

export interface RoundReport {
  round: number
  status: 'ok' | 'fault' | 'degraded' | 'void' | 'incomplete'
  detail: string
  /** 能從頭重算時的分數變化 */
  scoreDeltas?: number[]
}

export interface EvidenceReport {
  ok: boolean
  roomCode: string
  recordedBySeat: number
  envelopes: number
  badSignatures: number
  rounds: RoundReport[]
  errors: string[]
}

interface RoundLog {
  round: number
  shuffled: { seat: SeatIndex; deck: string }[]
  rekeyed: { seat: SeatIndex; deck: string; commits: string }[]
  secrets: Map<SeatIndex, string>
  actions: { seat: SeatIndex; action: PlayerActionCommand }[]
  degraded: string | null
  voided: string | null
  degradeCommit?: string
  degradeWall?: DegradeWall
  degradeSecret?: string
}

export function verifyEvidence(log: EvidenceLog): EvidenceReport {
  const report: EvidenceReport = {
    ok: false,
    roomCode: String(log?.roomCode ?? ''),
    recordedBySeat: Number(log?.recordedBySeat ?? -1),
    envelopes: 0,
    badSignatures: 0,
    rounds: [],
    errors: [],
  }
  if (!log || log.version !== 1 || !Array.isArray(log.envelopes) || !Array.isArray(log.members)) {
    report.errors.push('不是本遊戲的紀錄檔')
    return report
  }
  report.envelopes = log.envelopes.length

  // 1. 簽章與序號
  const lastN = new Map<number, number>()
  const rounds = new Map<number, RoundLog>()
  let current: RoundLog | null = null
  for (const env of log.envelopes) {
    const msg = openEnvelope(env, log.roomCode, log.members)
    if (!msg || env.n <= (lastN.get(env.seat) ?? 0)) {
      report.badSignatures++
      continue
    }
    lastN.set(env.seat, env.n)
    const signer = env.seat
    if (msg.type === 'ROUND_START' && signer === 0) {
      current = { round: msg.round, shuffled: [], rekeyed: [], secrets: new Map(), actions: [], degraded: null, voided: null }
      rounds.set(msg.round, current)
      continue
    }
    if (!current || !('round' in msg) || msg.round !== current.round) continue
    switch (msg.type) {
      case 'DECK_SHUFFLED':
        if (signer === msg.seat) current.shuffled.push({ seat: msg.seat, deck: msg.deck })
        break
      case 'DECK_REKEYED':
        if (signer === msg.seat) current.rekeyed.push({ seat: msg.seat, deck: msg.deck, commits: msg.keyCommits })
        break
      case 'ROUND_REVEAL':
        if (signer === msg.seat) current.secrets.set(msg.seat, msg.secret)
        break
      case 'SECURE_ACTION':
        current.actions.push({ seat: msg.seat, action: msg.action })
        break
      case 'DEGRADE':
        if (signer === 0) current.degraded = `座位 ${msg.seat} ${msg.reason}`
        break
      case 'ROUND_VOID':
        if (signer === 0) current.voided = `座位 ${msg.seat} ${msg.reason}`
        break
      case 'DEGRADE_COMMIT':
        if (signer === 0) current.degradeCommit = msg.commit
        break
      case 'DEGRADE_WALL':
        if (signer === 0) {
          current.degradeWall = { roundSeed: msg.roundSeed, leafHashes: msg.leafHashes, slots: new Map(msg.slots) }
        }
        break
      case 'DEGRADE_REVEAL':
        if (signer === 0) current.degradeSecret = msg.secret
        break
    }
  }
  if (report.badSignatures > 0) report.errors.push(`${report.badSignatures} 則訊息簽章或序號不符，紀錄可能被竄改`)

  // 2–3. 逐局稽核與重播（分數鏈一旦因降級中斷，之後只做牌山稽核）
  const state = createInitialTableState({ ...DEFAULT_RULE_CONFIG, ...log.rules })
  let chain = true
  for (const r of [...rounds.values()].sort((a, b) => a.round - b.round)) {
    if (r.voided) {
      report.rounds.push({ round: r.round, status: 'void', detail: `本局作廢：${r.voided}` })
      chain = false
      continue
    }
    if (r.degraded) {
      let detail = `本局曾降級（${r.degraded}），未完整驗證`
      if (r.degradeWall && r.degradeCommit && r.degradeSecret) {
        const err = verifyDegradedWall(r.degradeWall, r.degradeCommit, r.degradeSecret, null)
        detail += err ? `；重洗驗證失敗：${err}` : '；房主重洗承諾驗證通過'
      }
      report.rounds.push({ round: r.round, status: 'degraded', detail })
      chain = false
      continue
    }
    const layers = r.shuffled.map((s) => s.seat)
    if (layers.length === 0 || r.secrets.size < layers.length) {
      report.rounds.push({ round: r.round, status: 'incomplete', detail: '紀錄中沒有全部玩家的本局秘密' })
      chain = false
      continue
    }
    const audit = mpAuditRound({
      shuffled: r.shuffled.map((s) => base64ToBytes(s.deck)),
      rekeyed: r.rekeyed.map((s) => base64ToBytes(s.deck)),
      commits: r.rekeyed.map((s) => base64ToBytes(s.commits)),
      secrets: layers.map((s) => base64ToBytes(r.secrets.get(s) ?? '')),
    })
    if (!audit.ok) {
      const seat = audit.layer !== undefined ? layers[audit.layer] : null
      report.rounds.push({ round: r.round, status: 'fault', detail: `牌山稽核失敗（${audit.fault}）${seat !== null ? `：座位 ${seat}` : ''}` })
      chain = false
      continue
    }
    if (!chain) {
      report.rounds.push({ round: r.round, status: 'ok', detail: '牌山稽核通過（先前有降級，分數無法從頭重算）' })
      continue
    }
    if (r.round > 0) rotateDealer(state)
    const before = state.seats.map((s) => s.score)
    startSecureRound(state, audit.wall)
    let violation: string | null = null
    for (const { seat, action } of r.actions) {
      if (state.phase === 'ROUND_SETTLEMENT') break
      if (!applyPlayerAction(state, seat, action) && seatHasDuty(state, seat)) {
        violation = `座位 ${seat} 的動作違規（${action.type}）`
        break
      }
    }
    if (violation || state.phase !== 'ROUND_SETTLEMENT') {
      report.rounds.push({ round: r.round, status: violation ? 'fault' : 'incomplete', detail: violation ?? '紀錄在結算前就結束' })
      chain = false
      continue
    }
    report.rounds.push({
      round: r.round,
      status: 'ok',
      detail: '牌山稽核與重播通過',
      scoreDeltas: state.seats.map((s, i) => s.score - before[i]),
    })
  }
  report.ok = report.badSignatures === 0 && report.rounds.length > 0 && report.rounds.every((x) => x.status === 'ok')
  return report
}
