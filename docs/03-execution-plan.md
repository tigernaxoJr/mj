# Subagent 執行與派發計畫 (03-execution-plan.md)

本文件將專案拆解為高內聚、低耦合的最小工作包（Work Packages, `WP-1.1` ~ `WP-4.3`），每個工作包皆鎖定明確的目標檔案與自動驗收指令，可直接派發給 Subagent 獨立實作。

---

## 派發執行守則
1. **一次一包 (One Work Package per Subagent)**：Subagent 僅能新增/修改該工作包指定的 `目標檔案`，禁止跨切片隨意更改契約。
2. **硬性驗收門檻**：Subagent 回報完成前，必須親自執行該工作包的 `驗收指令` 並確保 0 錯誤。
3. **契約先行**：若發現 `src/shared/kernel/types.ts` 需要補充欄位，須先向主 Agent 回報或由主 Agent 更新後再派發。

---

## Phase 1：Rust Wasm 核心演算法 (`crates/mahjong-core` & `src/shared/wasm`)

- [x] **WP-1.0：專案骨架與 144 張牌基礎編碼**（已完成）
  - **目標檔案**：`crates/mahjong-core/src/tile.rs`、`crates/mahjong-core/src/lib.rs`、`src/shared/kernel/types.ts`
  - **驗收指令**：`pnpm test:rust && pnpm test`

- [x] **WP-1.1：確定性洗牌、牌山游標與承諾雜湊驗證 (`wall.rs`)**
  - **目標檔案**：`crates/mahjong-core/src/wall.rs`
  - **任務內容**：
    1. 實作 `SplitMix64` / `ChaCha` 確定性 PRNG 與 `Wall::from_seed(seed_hex: &str)` 洗出 144 張 `TileId (0..144)`。
    2. 實作正序摸牌游標 `draw_head()`、嶺上補花/補槓游標 `draw_tail()`，以及 `remaining() == 16`（鐵八墩）流局檢查。
    3. 實作輕量 SHA-256（或 FNV/SipHash + SHA-256）葉子雜湊產生與 `verify_tile_leaf(index, tile_id, salt, expected_hash)`，並補齊單元測試。
  - **驗收指令**：`pnpm test:rust`

- [x] **WP-1.2：手牌結構、理牌與副露管理 (`hand.rs` & `meld_check.rs`)**
  - **目標檔案**：`crates/mahjong-core/src/hand.rs`、`crates/mahjong-core/src/meld_check.rs`
  - **任務內容**：
    1. 實作 `Hand`（暗牌 `concealed: Vec<TileId>`、副露 `melds: Vec<Meld>`、花牌 `flowers: Vec<TileId>`）與自動理牌排序。
    2. 實作對他人捨牌的 `check_discard_claims(hand, discard_tile, is_next_seat)`（回傳可執行的吃組、碰、明槓）與自家摸牌後的暗槓/加槓檢查。
    3. 實作 `ClaimWindow` 優先序裁決函式（`胡 > 槓/碰 > 吃` + 逆時針攔胡順位）。
  - **驗收指令**：`pnpm test:rust`

- [x] **WP-1.3：17 張胡牌檢驗、聽牌與向聽數計算 (`win_check.rs`)**
  - **目標檔案**：`crates/mahjong-core/src/win_check.rs`
  - **任務內容**：
    1. 實作標準 17 張（$k$ 組暗面子 + $(5-k)$ 組副露 + 1 雀頭）遞迴回溯胡牌判定與面子拆解枚舉（供後續算台取最大台數拆法）。
    2. 實作特殊胡牌型：嚦咕嚦咕（8 對半：7 對 + 1 刻）、八仙過海（8 花）、七搶一。
    3. 實作 `waiting_tiles(hand_16)`（列出所有聽牌 `TileKind`）與 `shanten(hand_16)`（向聽數計算）。
    4. 撰寫單元測試覆蓋清一色多面聽、嚦咕嚦咕、單吊等邊界案例。
  - **驗收指令**：`pnpm test:rust`

- [x] **WP-1.4：台灣 16 張台數結算引擎 (`yaku.rs`)**
  - **目標檔案**：`crates/mahjong-core/src/yaku.rs`
  - **任務內容**：
    1. 依據 [`02-architecture-and-rules.md`](./02-architecture-and-rules.md) §3 實作完整台數判定（莊家連拉、圈門風、門清一摸三、正花/花槓、三元、平胡、碰碰胡、混/清/字一色、三/四/五暗刻、小/大三元、小/大四喜、獨聽、全求、海底/槓上/搶槓等）。
    2. 自動走訪所有合法面子拆解，回傳最高總台數之 `SettlementBreakdown`（含台數明細列表與各家應付分差）。
    3. 撰寫完整單元測試。
  - **驗收指令**：`pnpm test:rust`

- [x] **WP-1.5：單機啟發式 Bot AI 與 Wasm 綁定橋接 (`bot.rs`, `lib.rs`, `src/shared/wasm/index.ts`)**
  - **目標檔案**：`crates/mahjong-core/src/bot.rs`、`crates/mahjong-core/src/lib.rs`、`src/shared/wasm/index.ts`
  - **任務內容**：
    1. 在 `bot.rs` 實作依向聽數進張最大化與字牌/孤張優先捨出的單機 Bot 決策（含吃/碰/槓/胡反應決策）。
    2. 在 `lib.rs` 匯出 `wasm-bindgen` JSON/TypedArray 介面，並在 `src/shared/wasm/index.ts` 完成前端同步調用封裝與 Vitest 測試。
  - **驗收指令**：`pnpm test:rust && pnpm test && pnpm build`

---

## Phase 2：向量牌面烘焙與 Phaser 3 單機牌桌 (`tools/` & `src/features/table`)

- [x] **WP-2.1：程式化 SVG 麻將牌面烘焙管線 (`tools/paint_tiles.mjs`)**
  - **目標檔案**：`tools/paint_tiles.mjs`
  - **任務內容**：
    1. 使用 SVG + `@resvg/resvg-js` 程式化生成 42 種清晰高對比台灣麻將牌面（萬、筒、條、東南西北、中發白、春夏秋冬、梅蘭竹菊）與牌背/倒牌基底，輸出至 `public/assets/tiles/`。
  - **驗收指令**：`node tools/paint_tiles.mjs`

- [x] **WP-2.2：牌桌確定性狀態機與單機回合調度 (`table/domain` & `table/application`)**
  - **目標檔案**：`src/features/table/domain/tableState.ts`、`src/features/table/application/useTableSession.ts`
  - **任務內容**：
    1. 實作開門補花、摸打循環、鐵八墩流局、過水鎖定、`ClaimWindow` 攔胡裁決與連莊/換莊狀態轉移。
    2. 串接 3 個單機 Bot 自動回應與出牌，並補齊狀態機單元測試。
  - **驗收指令**：`pnpm test && pnpm build`

- [x] **WP-2.3：Phaser 3 牌桌渲染場景 (`table/engine/TableScene.ts`)**
  - **目標檔案**：`src/features/table/engine/TableScene.ts`
  - **任務內容**：
    1. 渲染綠色絨布桌面、中央風圈/門風/剩餘牌數羅盤、四家手牌（本家可點擊選牌出牌、三家立牌）、四家牌海（每排 6 張整齊排列）、花牌區與吃碰槓副露區。
    2. 實作摸牌、補花、出牌入海的流暢 Tween 動畫與最後捨牌高亮標記。
  - **驗收指令**：`pnpm build`

- [x] **WP-2.4：100dvh 街機駕駛艙 HUD 與結算面板 (`table/ui/`)**
  - **目標檔案**：`src/features/table/ui/TableArena.vue`、`src/features/table/ui/ActionHud.vue`、`src/features/table/ui/SettlementModal.vue`
  - **任務內容**：
    1. 實作本家手牌上方的吃（支援多組順子選擇）/碰/槓/聽/胡/過浮動按鈕列與聽牌提示徽章。
    2. 實作胡牌/流局結算彈窗（展示胡牌手牌、逐條台數明細、連莊數、四家籌碼增減與「下一局」按鈕）。
  - **驗收指令**：`pnpm build`

---

## Phase 3：PeerJS 零伺服器 P2P 連線與防作弊同步 (`src/features/lobby` & `table/application`)

- [x] **WP-3.1：PeerJS 星狀連線介面卡與房間狀態 (`lobby/infra` & `lobby/domain`)**
  - **目標檔案**：`src/features/lobby/infra/peerAdapter.ts`、`src/features/lobby/domain/roomSession.ts`
  - **任務內容**：
    1. 實作 `twmj-<6碼房號>` 公開信令開房、撞號重試、入房連線、開局 `lockRoom()` 與斷線偵測。
    2. 支援 4 人星狀房間（東/南/西/北座位分配、底台設定、缺人由 Bot 補位、中途斷線無縫切換 Bot 代打）。
  - **驗收指令**：`pnpm test && pnpm build`

- [x] **WP-3.2：大廳配對 UI 與 P2P `Co-Seeded Commit-Reveal` 牌局同步 (`lobby/ui` & `table/application`)**
  - **目標檔案**：`src/features/lobby/ui/LobbyHub.vue`、`src/features/table/application/useTableSession.ts`、`src/App.vue`
  - **任務內容**：
    1. 實作大廳「單機立即開打 / 建立房間 / 輸入 6 碼房號加入」零捲動 UI。
    2. 在 `useTableSession.ts` 串接 `SEED_COMMIT` / `SEED_REVEAL`、`WALL_LOCKED`、`TILE_DRAWN_PRIVATE` 驗證與終局 `ROUND_AUDIT` 全盤稽核。
  - **驗收指令**：`pnpm test && pnpm build`

---

## Phase 4：音效語音、特效手感與 CI 部署 (`src/features/audio` & `.github/workflows`)

- [x] **WP-4.1：Web Audio 程序化麻將音效與語音提示 (`src/features/audio/index.ts`)**
  - **目標檔案**：`src/features/audio/index.ts`
  - **任務內容**：
    1. 單檔實作麻將理牌聲、摸牌聲、捨牌清脆碰撞聲、吃/碰/槓/胡/自摸合成音效（或 Web Speech API 國/台語發音）與靜音開關。
  - **驗收指令**：`pnpm build`

- [x] **WP-4.2：吃碰槓胡大字印章特效與 GitHub Pages 自動部署**
  - **目標檔案**：`src/features/table/engine/TableScene.ts`、`.github/workflows/deploy.yml`
  - **任務內容**：
    1. 加入吃/碰/槓/胡/自摸畫面微震動、閃光與書法印章動畫。
    2. 建立 GitHub Actions 自動執行 `cargo test`、`wasm-pack`、`vitest` 與靜態網頁部署。
  - **驗收指令**：`pnpm test:rust && pnpm test && pnpm build`

---

## Phase 5：防房主作弊 Mental Poker 牌山協定（規劃中）

完整設計、威脅模型、原型驗證結果與各工作包的目標檔案、驗收指令，見 [`04-host-anticheat-mental-poker.md`](./04-host-anticheat-mental-poker.md) §7。

- [x] **WP-5.1：Rust 密碼核心 (`mental_poker.rs`)**
- [ ] **WP-5.2：Wasm 綁定與 TS 封裝**
- [ ] **WP-5.3：身分、安全碼與簽章信封**
- [ ] **WP-5.4：開局洗牌與摸牌協定**
- [ ] **WP-5.5：牌桌狀態機去全知化**
- [ ] **WP-5.6：斷線降級、UI 與文件**
