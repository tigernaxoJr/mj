/**
 * WP-4.1: Web Audio 程序化麻將音效與語音提示
 * 單檔實作零外部音檔依賴之 Web Audio API 合成器 + Web Speech API 國/台語唱牌語音
 */
export type SoundEffectId =
  | 'shuffle'
  | 'draw'
  | 'discard'
  | 'flower'
  | 'chii'
  | 'pon'
  | 'kan'
  | 'migi'
  | 'ron'
  | 'tsumo'

let muted = false
let voiceEnabled = true
let sharedCtx: AudioContext | null = null

const VOICE_CALLOUTS: Partial<Record<SoundEffectId, string>> = {
  flower: '補花',
  chii: '吃',
  pon: '碰',
  kan: '槓',
  migi: '聽牌',
  ron: '胡啦',
  tsumo: '自摸',
}

export function setAudioMuted(value: boolean): void {
  muted = value
  if (muted && typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel()
    } catch {
      // Ignore speechSynthesis errors in restricted environments
    }
  }
}

export function isAudioMuted(): boolean {
  return muted
}

export function setVoiceEnabled(value: boolean): void {
  voiceEnabled = value
}

export function isVoiceEnabled(): boolean {
  return voiceEnabled
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctx =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  if (!sharedCtx) {
    sharedCtx = new Ctx()
  }
  if (sharedCtx.state === 'suspended') {
    void sharedCtx.resume().catch(() => {})
  }
  return sharedCtx
}

function playTone(
  ctx: AudioContext,
  freq: number,
  endFreq: number,
  startTime: number,
  duration: number,
  gainPeak: number,
  type: OscillatorType = 'triangle',
): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, startTime)
  if (endFreq !== freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), startTime + duration)
  }

  gain.gain.setValueAtTime(0.0001, startTime)
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + Math.min(0.008, duration * 0.25))
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)

  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(startTime)
  osc.stop(startTime + duration + 0.01)
}

function playNoiseBurst(
  ctx: AudioContext,
  startTime: number,
  duration: number,
  bandFreq: number,
  q: number,
  gainPeak: number,
): void {
  const sampleCount = Math.max(1, Math.floor(ctx.sampleRate * duration))
  const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < sampleCount; i++) {
    channel[i] = (Math.random() * 2 - 1) * Math.exp((-i / sampleCount) * 4)
  }

  const source = ctx.createBufferSource()
  source.buffer = buffer

  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(bandFreq, startTime)
  filter.Q.setValueAtTime(q, startTime)

  const gain = ctx.createGain()
  gain.gain.setValueAtTime(gainPeak, startTime)
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)

  source.connect(filter)
  filter.connect(gain)
  gain.connect(ctx.destination)
  source.start(startTime)
  source.stop(startTime + duration + 0.01)
}

function speakCallout(text: string): void {
  if (!voiceEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return
  try {
    const synth = window.speechSynthesis
    synth.cancel()
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'zh-TW'
    utter.rate = 1.15
    utter.pitch = 1.05
    utter.volume = 0.85
    synth.speak(utter)
  } catch {
    // Ignore speech synthesis failures on headless/unsupported browsers
  }
}

export function playSfx(id: SoundEffectId): void {
  if (muted || typeof window === 'undefined') return

  const callout = VOICE_CALLOUTS[id]
  if (callout) {
    speakCallout(callout)
  }

  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime

  switch (id) {
    case 'shuffle': {
      // 洗牌搓麻將碰撞聲：連續多顆高頻木石短促敲擊
      for (let i = 0; i < 7; i++) {
        const offset = i * 0.042
        const base = 950 + (i % 3) * 240
        playNoiseBurst(ctx, now + offset, 0.032, base * 1.6, 5, 0.14)
        playTone(ctx, base, base * 0.72, now + offset, 0.035, 0.1, 'triangle')
      }
      break
    }
    case 'draw': {
      // 摸牌輕巧指尖摩娑聲
      playNoiseBurst(ctx, now, 0.025, 1800, 4, 0.08)
      playTone(ctx, 520, 680, now, 0.045, 0.08, 'sine')
      break
    }
    case 'discard': {
      // 捨牌落桌清脆碰撞聲（象牙竹骨牌拍擊桌面）
      playNoiseBurst(ctx, now, 0.035, 2400, 6, 0.28)
      playTone(ctx, 1380, 420, now, 0.055, 0.22, 'triangle')
      playTone(ctx, 2760, 880, now + 0.004, 0.03, 0.12, 'sine')
      break
    }
    case 'flower': {
      // 補花清亮雙音鈴聲
      playTone(ctx, 880, 880, now, 0.09, 0.14, 'sine')
      playTone(ctx, 1318.5, 1318.5, now + 0.065, 0.14, 0.16, 'sine')
      break
    }
    case 'chii': {
      // 吃：輕快上揚雙連音
      playTone(ctx, 587.33, 659.25, now, 0.08, 0.16, 'triangle')
      playTone(ctx, 783.99, 880, now + 0.07, 0.11, 0.18, 'triangle')
      break
    }
    case 'pon': {
      // 碰：厚實有力雙擊聲
      playNoiseBurst(ctx, now, 0.04, 1900, 5, 0.26)
      playTone(ctx, 440, 330, now, 0.09, 0.22, 'square')
      playTone(ctx, 660, 660, now + 0.05, 0.12, 0.18, 'triangle')
      break
    }
    case 'kan': {
      // 槓：三連擊鏗鏘聲
      playNoiseBurst(ctx, now, 0.045, 2200, 5, 0.28)
      playTone(ctx, 523.25, 523.25, now, 0.07, 0.18, 'triangle')
      playTone(ctx, 659.25, 659.25, now + 0.06, 0.07, 0.2, 'triangle')
      playTone(ctx, 1046.5, 1046.5, now + 0.12, 0.16, 0.22, 'triangle')
      break
    }
    case 'migi': {
      // 聽牌 (Migi)：緊張警戒高音共鳴
      playTone(ctx, 740, 1108.73, now, 0.12, 0.18, 'sawtooth')
      playTone(ctx, 1480, 1480, now + 0.09, 0.18, 0.16, 'sine')
      break
    }
    case 'ron':
    case 'tsumo': {
      // 胡 / 自摸：喜慶大三和弦琶音 + 鑼響泛音
      const notes = id === 'tsumo' ? [523.25, 659.25, 783.99, 1046.5, 1318.5] : [440, 554.37, 659.25, 880]
      notes.forEach((freq, idx) => {
        playTone(ctx, freq, freq, now + idx * 0.055, 0.24, 0.18, 'triangle')
      })
      playNoiseBurst(ctx, now, 0.08, 1600, 3, 0.22)
      break
    }
  }
}
