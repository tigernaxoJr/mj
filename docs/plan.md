# 台灣 16 張麻將遊戲開發計畫書 (plan.md)

本專案架構對齊 [`tank`](file:///C:/workspace/tank) 專案模式，採「**100% 零伺服器純前端優先、Phaser 3 牌桌渲染、WebRTC P2P 直連、Rust/Wasm 同構規則核心、向量程序化牌面 + AI 美術管線**」實作標準台灣 16 張麻將（閒家 16 張、摸牌 17 張成胡），並支援**單機／連線房間自由增減電腦玩家（Bot）補滿四家開局**。

---

## 1. 技術棧選型與規格對齊 (Tech Stack)

| 領域 | 技術選型 | 角色職責 |
|---|---|---|
| **前端應用層** | **Vue 3 + TypeScript (`vue-tsc`)** | 大廳介面、房號配對、四家席位管理（可隨時加入/移除電腦玩家）、疊加操作 HUD（吃/碰/槓/聽/胡/過面板）、台數結算單 |
| **建置工具** | **Vite 6 + pnpm 10** | 極速 HMR、Wasm 打包與靜態資源管理 |
| **樣式系統** | **Tailwind CSS 4 (`@tailwindcss/vite`)** | 全視窗 `100dvh` (`fixed inset-0`) 零捲動街機駕駛艙佈局、牌桌四角資訊區與彈窗面板 |
| **遊戲引擎** | **Phaser 3 (`phaser@3.90.x`)** | 2.5D 俯視牌桌、手牌立牌/倒牌渲染、摸打拋物線 Tween、牌海（River）排列、吃碰槓胡粒子特效 |
| **P2P 連線層** | **PeerJS (`peerjs@1.5.x`)** | 星狀拓撲（1 Host + 最多 3 Guests，空位可配置電腦玩家），預設直連官方公共信令池 (`0.peerjs.com`)，開局 `lockRoom()` 防亂入 |
| **核心演算與防作弊** | **Rust → Wasm (`wasm-pack`, `crates/mahjong-core`)** | 144 張牌定義、確定性洗牌與雜湊承諾驗證、吃碰槓胡合法性與優先序裁決、台灣 16 張台數引擎、向聽數電腦玩家 AI |
| **測試與 CI/CD** | **Vitest + `cargo test` + GitHub Actions** | Rust 核心與前端單元測試，`.github/workflows/deploy.yml` 自動編譯 Wasm 並部署 GitHub Pages |
| **美術管線** | **程式化向量繪製 (`@resvg/resvg-js`) + AI 生圖切片** | 42 種麻將牌面採 SVG 腳本精準烘焙；牌桌絨布、角色立繪與 UI 框採 AI 生圖 + 洋紅去背切割腳本 |

---

## 2. 電腦玩家 (Bot) 席位與託管機制

1. **房間席位自由配置（1～4 人皆可開局）**：
   - 房間固定為東、南、西、北四席（`SeatIndex: 0..3`）。
   - **單機模式**：預設本家坐東席，其餘三席自動填入電腦玩家（1 人 + 3 電腦）。
   - **P2P 連線模式**：房主可於任意空席點擊「加入電腦玩家」（`addBotToSeat`）或「移除電腦」，亦可一鍵「電腦補滿空位」（`fillEmptySeatsWithBots`），支援 2 真人 + 2 電腦、3 真人 + 1 電腦或 4 真人對戰。
2. **斷線無縫代打**：
   - 對局中若遠端真人斷線，房主端自動將該座位標記為 `isBot: true`，由 Rust Wasm 向聽數 AI 接手摸打與副露回應，牌局不中斷。

---

## 3. 詳細規格索引
- [README.md](./README.md)：文件中心總覽
- [01-project-proposal.md](./01-project-proposal.md)：完整目錄結構與階段規劃
- [02-architecture-and-rules.md](./02-architecture-and-rules.md)：144 張牌編碼、台灣 16 張麻將狀態機、台數表與 P2P 協議
- [03-execution-plan.md](./03-execution-plan.md)：Subagent 工作包（`WP-1.1` ~ `WP-4.2`）拆解與驗收標準
