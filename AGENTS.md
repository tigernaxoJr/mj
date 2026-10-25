# AGENTS.md — 專案開發與規則演進守則

本文件為 AI Agent 在 `mj`（台灣 16 張麻將 Web）專案中協作時的最高指導原則。

## 1. 專案核心架構與設計守則
詳細規範請見 [`docs/02-architecture-and-rules.md`](./docs/02-architecture-and-rules.md)：
1. **VSA 垂直切片 + 務實 DDD**：
   - 功能依 `src/features/<slice>`（`table`、`lobby`、`audio`）垂直隔離，跨切片僅能透過 [`src/shared/kernel/types.ts`](./src/shared/kernel/types.ts) 或各 Slice 的 `index.ts` 互動。
   - 中大型模組分層（`domain/`、`application/`、`engine/`、`infra/`、`ui/`），小型模組（如 `audio`）維持單檔實作，禁止過度設計（YAGNI）。
2. **Rust/Wasm 核心單一真相來源 (`crates/mahjong-core`)**：
   - 144 張牌編碼（`0..=143`）、確定性洗牌、17 張（5 面子 + 1 雀頭）胡牌檢驗、台灣 16 張台數計算與向聽數 Bot AI 一律收斂於 `crates/mahjong-core`。
3. **台灣 16 張麻將確定性狀態機**：
   - 嚴格遵守「開門補花 → 摸打循環（手牌數強制鎖定 $3n+1 / 3n+2$ 杜絕相公）→ 鐵八墩（剩 16 張流局）→ `ClaimWindow` 收集全體回應後依 `胡 > 槓/碰 > 吃` + 逆時針攔胡裁決 → 過水限制」。
4. **全畫面街機駕駛艙 HUD 與零捲動守則**：
   - 牌桌畫面必須以 `100dvh`（`fixed inset-0`）全視窗呈現，禁止網頁捲動軸；吃/碰/槓/聽/胡操作鈕與結算明細直接疊加於 Phaser 3 牌桌畫布之上。
5. **Subagent 工作包隔離守則**：
   - 派發 Subagent 時以 [`docs/03-execution-plan.md`](./docs/03-execution-plan.md) 的單一 `WP-*` 為單位，鎖定目標檔案並強制執行驗收指令（`pnpm test:rust`、`pnpm test`、`pnpm build`）。
6. **Git Commit 鐵律**：
   - 在使用者給出明確的 commit 指令前，**絕對禁止**自行執行 `git commit`。

## 2. 技術棧 (Tech Stack)
| 領域 | 技術 |
|---|---|
| 前端框架 | Vue 3 + TypeScript (`vue-tsc`) |
| 建置工具 | Vite 6 + pnpm 10 |
| 樣式 | Tailwind CSS 4 (`@tailwindcss/vite`) |
| 遊戲引擎／渲染 | Phaser 3 (`phaser@3.90.x`) |
| 測試 | Vitest (`pnpm test`) + Rust `cargo test` (`pnpm test:rust`) |
| 連線 | PeerJS (`peerjs@1.5.x`, WebRTC P2P 星狀拓撲，`0.peerjs.com` 零伺服器直連) |
| 核心運算與防作弊 | Rust → WebAssembly (`crates/mahjong-core`, `wasm-pack`, `Co-Seeded Commit-Reveal`) |
| 美術資產管線 | 程式化向量麻將牌面烘焙 (`tools/paint_tiles.mjs`, `@resvg/resvg-js`) + AI 生圖去背切片 (`tools/slice_ui.py`) |
