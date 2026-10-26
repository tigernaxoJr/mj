// Vitest（Node）沒有 fetch file:// 的能力：先以位元組同步載入 Rust/Wasm 核心，測試與正式環境走同一份規則
import { readFileSync } from 'node:fs'
import { initSync } from '@/shared/wasm/pkg/mahjong_core.js'
import { initMahjongWasm } from '@/shared/wasm'

initSync({ module: readFileSync(new URL('../shared/wasm/pkg/mahjong_core_bg.wasm', import.meta.url)) })
await initMahjongWasm()
