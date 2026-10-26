# 台灣 16 張麻將 Web — 文件中心 (Documentation Index)

本目錄統一收納專案的所有規劃、架構、台灣 16 張麻將規則與 Subagent 派發規格文件。

## 文件清單

1. **[plan.md](./plan.md)**  
   核心開發計畫摘要：技術棧、電腦玩家（Bot）自由補位與斷線託管機制、文件快速索引。
2. **[01-project-proposal.md](./01-project-proposal.md)**  
   專案開發計畫書：技術棧選型（Vue 3 + Phaser 3 + PeerJS + Rust/Wasm）、VSA 垂直切片目錄結構與 4 階段路線圖。
3. **[02-architecture-and-rules.md](./02-architecture-and-rules.md)**  
   架構契約與麻將規則規格：VSA 跨切片邊界、144 張牌編碼規格、台灣 16 張麻將完整狀態機（開門補花、摸打、鐵八墩、攔胡優先序、過水限制）、電腦玩家席位規則、標準台數表、P2P `Co-Seeded Commit-Reveal` 防作弊協議訊息格式。
4. **[03-execution-plan.md](./03-execution-plan.md)**  
   Subagent 工作包派發計畫：將 Phase 1 ~ Phase 4 拆解為鎖定單一檔案/模組的 Work Packages (`WP-1.1` ~ `WP-4.2`)，附帶明確的輸入/輸出契約與自動驗收指令。
5. **[04-host-anticheat-mental-poker.md](./04-host-anticheat-mental-poker.md)**  
   防房主作弊計畫（Phase 5）：Mental Poker 可交換加密洗牌 + 逐張金鑰承諾，讓房主也看不到別人的牌；含威脅模型、函式庫選型、原型測試與效能數據、工作包 `WP-5.1` ~ `WP-5.6`。

## 待辦清單與協作守則
- 尚未完成的工作與 Subagent 任務進度統一維護於根目錄 [`todo.md`](../todo.md)。
- AI Agent 開發守則與技術棧清單維護於根目錄 [`AGENTS.md`](../AGENTS.md)。
