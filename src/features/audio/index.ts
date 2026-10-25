// WP-4.1: Web Audio 程序化麻將音效與語音合成
export type SoundEffectId = 'draw' | 'discard' | 'chii' | 'pon' | 'kan' | 'ron' | 'tsumo'

let muted = false

export function setAudioMuted(value: boolean): void {
  muted = value
}

export function isAudioMuted(): boolean {
  return muted
}

export function playSfx(_id: SoundEffectId): void {
  if (muted) return
}
