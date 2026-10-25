# TODO — 台灣 16 張麻將實作與 Subagent 派發清單

本清單對應 [`docs/03-execution-plan.md`](./docs/03-execution-plan.md) 的工作包（Work Packages），方便主 Agent 與 Subagent 追蹤實作進度。每完成一項工作包並通過驗收指令後，請勾選對應項目。

---

## Phase 1：Rust Wasm 核心演算法 (`crates/mahjong-core` & `src/shared/wasm`)

- [x] **WP-1.0：專案架構初始化、文件中心 (`docs/`)、電腦玩家席位管理與 GitHub Actions 部署設定**
  - 目標：`docs/plan.md`、`docs/01~03`、`.github/workflows/deploy.yml`、`crates/mahjong-core/src/tile.rs`、`src/features/lobby/domain/roomSession.ts`
  - 驗收：`pnpm test:rust && pnpm test && pnpm build`
- [ ] **WP-1.1：確定性洗牌、牌山游標（含鐵八墩/嶺上補牌）與承諾雜湊驗證**
  - 目標檔案：[`crates/mahjong-core/src/wall.rs`](./crates/mahjong-core/src/wall.rs)
  - 規格參考：[`docs/02-architecture-and-rules.md`](./docs/02-architecture-and-rules.md) §2, §4
  - 驗收：`pnpm test:rust`
- [ ] **WP-1.2：手牌結構、自動理牌、吃碰槓合法性與 `ClaimWindow` 優先序裁決**
  - 目標檔案：[`crates/mahjong-core/src/hand.rs`](./crates/mahjong-core/src/hand.rs)、[`crates/mahjong-core/src/meld_check.rs`](./crates/mahjong-core/src/meld_check.rs)
  - 規格參考：[`docs/02-architecture-and-rules.md`](./docs/02-architecture-and-rules.md) §2.3, §2.4
  - 驗收：`pnpm test:rust`
- [ ] **WP-1.3：17 張胡牌檢驗（5 面子 + 1 雀頭 / 嚦咕嚦咕 / 八仙過海 / 七搶一）、聽牌與向聽數計算**
  - 目標檔案：[`crates/mahjong-core/src/win_check.rs`](./crates/mahjong-core/src/win_check.rs)
  - 規格參考：[`docs/02-architecture-and-rules.md`](./docs/02-architecture-and-rules.md) §2, §3
  - 驗收：`pnpm test:rust`
- [ ] **WP-1.4：台灣 16 張完整台數與底台結算引擎**
  - 目標檔案：[`crates/mahjong-core/src/yaku.rs`](./crates/mahjong-core/src/yaku.rs)
  - 規格參考：[`docs/02-architecture-and-rules.md`](./docs/02-architecture-and-rules.md) §3
  - 驗收：`pnpm test:rust`
- [ ] **WP-1.5：電腦玩家 (Bot AI) 向聽數決策與 Wasm 綁定橋接**
  - 目標檔案：[`crates/mahjong-core/src/bot.rs`](./crates/mahjong-core/src/bot.rs)、[`crates/mahjong-core/src/lib.rs`](./crates/mahjong-core/src/lib.rs)、[`src/shared/wasm/index.ts`](./src/shared/wasm/index.ts)
  - 任務重點：實作電腦玩家的摸打捨牌、暗槓/加槓與對他人捨牌的吃/碰/胡自動決策，供單機與 P2P 房間內的電腦席位調用
  - 驗收：`pnpm test:rust && pnpm test && pnpm build`

---

## Phase 2：向量牌面烘焙與 Phaser 3 單機牌桌 (`tools/` & `src/features/table`)

- [ ] **WP-2.1：程式化 SVG 麻將牌面烘焙腳本（42 種牌面 + 牌背輸出至 `public/assets/tiles/`）**
  - 目標檔案：[`tools/paint_tiles.mjs`](./tools/paint_tiles.mjs)
  - 驗收：`node tools/paint_tiles.mjs`
- [ ] **WP-2.2：牌桌確定性狀態機（開門補花、摸打、鐵八墩、過水、攔胡）與電腦玩家自動代打調度**
  - 目標檔案：[`src/features/table/domain/tableState.ts`](./src/features/table/domain/tableState.ts)、[`src/features/table/application/useTableSession.ts`](./src/features/table/application/useTableSession.ts)
  - 任務重點：根據房間 `RoomSeatSlot.occupant === 'bot'` 自動觸發電腦玩家摸打與 `ClaimWindow` 回應
  - 驗收：`pnpm test && pnpm build`
- [ ] **WP-2.3：Phaser 3 牌桌渲染場景（四家手牌、副露、牌海、中央風圈羅盤與出牌 Tween 動畫）**
  - 目標檔案：[`src/features/table/engine/TableScene.ts`](./src/features/table/engine/TableScene.ts)
  - 驗收：`pnpm build`
- [ ] **WP-2.4：`100dvh` 疊加操作 HUD（吃碰槓聽胡面板、聽牌提示）與台數結算明細彈窗**
  - 目標檔案：[`src/features/table/ui/TableArena.vue`](./src/features/table/ui/TableArena.vue)、[`src/features/table/ui/ActionHud.vue`](./src/features/table/ui/ActionHud.vue)、[`src/features/table/ui/SettlementModal.vue`](./src/features/table/ui/SettlementModal.vue)
  - 驗收：`pnpm build`

---

## Phase 3：PeerJS 零伺服器 P2P 連線與防作弊同步 (`src/features/lobby` & `table/application`)

- [ ] **WP-3.1：PeerJS 星狀連線介面卡（`twmj-<6碼房號>`、撞號重試、`lockRoom()`）與真人/電腦混合席位同步**
  - 目標檔案：[`src/features/lobby/infra/peerAdapter.ts`](./src/features/lobby/infra/peerAdapter.ts)、[`src/features/lobby/domain/roomSession.ts`](./src/features/lobby/domain/roomSession.ts)
  - 任務重點：支援房主在 P2P 房間任意空席加入/移除電腦玩家，真人斷線時自動轉為電腦玩家接手
  - 驗收：`pnpm test && pnpm build`
- [ ] **WP-3.2：大廳配對 UI 與 P2P `Co-Seeded Commit-Reveal` 牌山鎖定 / 私密摸牌驗證 / 終局稽核**
  - 目標檔案：[`src/features/lobby/ui/LobbyHub.vue`](./src/features/lobby/ui/LobbyHub.vue)、[`src/features/table/application/useTableSession.ts`](./src/features/table/application/useTableSession.ts)、[`src/App.vue`](./src/App.vue)
  - 驗收：`pnpm test && pnpm build`

---

## Phase 4：音效語音、特效手感與視覺打磨 (`src/features/audio` & `table/engine`)

- [ ] **WP-4.1：Web Audio 程序化麻將碰撞聲與吃/碰/槓/胡/自摸語音合成**
  - 目標檔案：[`src/features/audio/index.ts`](./src/features/audio/index.ts)
  - 驗收：`pnpm build`
- [ ] **WP-4.2：吃碰槓胡書法印章粒子特效與鏡頭震動反饋**
  - 目標檔案：[`src/features/table/engine/TableScene.ts`](./src/features/table/engine/TableScene.ts)
  - 驗收：`pnpm test:rust && pnpm test && pnpm build`
