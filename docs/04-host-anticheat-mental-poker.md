# 防房主作弊：Mental Poker 牌山協定計畫 (04-host-anticheat-mental-poker.md)

> 狀態：**Phase 5 完成**（WP-5.1～5.6）：密碼核心（[`mental_poker.rs`](../crates/mahjong-core/src/mental_poker.rs)）、Wasm 綁定、身分握手與安全碼、簽章信封、牌山協定、去全知化的牌桌與結算重播稽核、斷線降級與作廢、證據檔下載與第三方驗證。已用兩個瀏覽器經 PeerJS 公共信令實機打完一局，並實測中途關閉客機分頁後降級打完。
> 適用範圍：**兩位以上真人**的連線房間。單機與「1 真人 + 3 電腦」維持現行流程。

---

## 1. 目標

現行協定（`d908add`，見 [`02-architecture-and-rules.md`](./02-architecture-and-rules.md) §4）由房主產生牌山，再以 hash 承諾鎖定：

- ✅ 房主開局後**改牌、換牌序**：結算時稽核抓得到。
- ❌ 房主**偷看**：房主產生牌山，自然知道整副牌、所有人的手牌與接下來要摸的牌。

本計畫的目標是在**純前端 + 公開信令伺服器（`0.peerjs.com`）**的前提下，讓房主（以及任何單一玩家）**在開局後無法得知別人的暗牌與未摸的牌山**，並維持「結算時可完整稽核」。

## 2. 為什麼只靠 hash 承諾不夠

| 做法 | 下一張牌無法預知 | 手牌保密 | 不重複 |
|---|---|---|---|
| 房主產生牌山 + hash 承諾（現行） | ❌ 房主知道 | ❌ 房主知道 | ✅ |
| 每家逐步密鑰 + hash 承諾，**公開**揭露 | ✅ | ❌ 全員明牌 | ✅ |
| 每家逐步密鑰 + hash 承諾，**私下**揭露 | ✅ | ✅ | ❌ 不知道別人摸走哪張，會抽到重複的牌 |
| **可交換加密洗牌 + 逐張金鑰 + hash 承諾**（本計畫） | ✅ | ✅ | ✅ |

hash 只能「鎖住」一個值，不能在看不到內容時對它運算。要同時做到保密與不重複，排列就必須在**開局時一次決定、但沒人知道**。這需要每家各加一道「可交換的鎖」，也就是 Mental Poker（SRA 方案，實作在橢圓曲線上）。

## 3. 威脅模型

| 威脅 | 現行 | 本計畫 | 說明 |
|---|---|---|---|
| 房主開局後改牌、換牌序 | 結算時偵測 | **結算時偵測** | 每家的洗牌與換鑰在結算時全部重算 |
| 房主偷看客機手牌、未摸的牌山 | ❌ | ✅ **擋住** | 任何人缺一層金鑰都解不開（§6 測試） |
| 房主轉送時竊聽或竄改金鑰分享 | — | ✅ **擋住** | 分享以 `crypto_box` 端對端加密並驗證 |
| 房主冒充客機（中間人） | — | ✅ **可偵測** | 開局前四家比對「房間安全碼」（§4.3） |
| 任一玩家謊報打出的牌、副露 | 房主權威 | ✅ **即時驗證** | 公開牌時附上所有層金鑰 |
| 玩家違規動作（過水、詐胡、藏花） | 房主權威 | **結算時偵測** | 結算公開全部金鑰後，用現有規則引擎逐步重播 |
| 斷線、拒絕送出金鑰、拖延 | ❌ | ❌ | 降級為房主發牌繼續打（防作弊失效），並記錄是誰（§4.8） |
| 電腦座位的手牌 | — | ❌ 房主看得到 | Bot 由房主執行，必須知道自己的牌 |
| 真人玩家場外串通 | ❌ | ❌ | 任何協定都擋不住 |

**安全假設**：至少一位玩家誠實，則沒有人能事先得知牌山排列；每位玩家的手牌只有自己知道（Bot 座位則房主也知道）。

## 4. 協定設計

### 4.1 參與者

- **層（layer）持有者**：每個真人座位各持有一層鎖。2～4 層都成立（§6 測試 `two_humans_are_enough`）。
- **房主**：仍負責轉送訊息、執行 Bot、推進公開的狀態機，但**不再是全知裁判**。
- **Bot 座位**：不持有鎖。輪到 Bot 摸牌時，各真人把金鑰分享封裝給房主。

### 4.2 密碼學元件與函式庫選型

原則：**只用可信賴的現成函式庫，不自己實作密碼學原語**。

| 用途 | 函式庫 | 說明 |
|---|---|---|
| 可交換加密（牌的鎖） | `curve25519-dalek` 4.x（Ristretto255） | `E_k(P) = k·P`，加解鎖順序可交換 |
| 牌面編碼 | `RistrettoPoint::hash_from_bytes::<Sha512>` | **必須用 hash-to-curve**；若用 `s·G` 這類已知離散對數的點，同一層金鑰下的密文比例會洩漏排列 |
| 洗牌亂數 | `rand` 0.9 `SliceRandom::shuffle` + `rand_chacha::ChaCha20Rng` | 種子取自玩家本局秘密 |
| 雜湊、承諾 | `sha2`（RustCrypto） | 同時把 `wall.rs` 手寫的 SHA-256 換掉 |
| 金鑰分享的端對端加密 | `crypto_box` 0.9（RustCrypto，NaCl box：X25519 + XSalsa20Poly1305） | 房主轉送也解不開、改不了 |
| 訊息簽章、身分 | `ed25519-dalek` 2.x | 每則協定訊息都簽章，可證明誰送了什麼 |
| 本局秘密 | Web Crypto `crypto.getRandomValues` | 在 TS 端產生後傳入 Wasm，Wasm 不需要 `getrandom` |

**評估過但不採用的現成 Mental Poker crate**：`mental-poker` 0.1.0、`ziffle` 0.1.0（Bayer-Groth 洗牌證明）。兩者都是 0.1 版、沒有安全稽核、使用者很少，不符合「可信賴」的標準。因此只有 **SRA 的分層組合（約 100 行）需要我們自己寫**，底層原語全部來自上表的函式庫。若日後有成熟、經稽核的 Mental Poker 函式庫，應優先換用。

### 4.3 身分與房間安全碼（大廳階段）

1. 每位玩家進房時產生 `ed25519` 簽章金鑰與 `crypto_box` 金鑰，但**先只送出承諾** `IDENTITY_COMMIT = sha256(公鑰)`。
2. 房主按開局時鎖定名冊 `IDENTITY_ROSTER`（四家承諾），之後各家才 `IDENTITY_REVEAL` 公開公鑰；房主驗證後以 `IDENTITY_KEYS` 下發。客機檢查每把公鑰都對得上名冊、自己那把沒被替換。
3. 每台裝置**在本機自行計算** **房間安全碼** = `sha256(房號 ‖ 依座位排序的四家公鑰)`（`mental_poker::room_fingerprint`），取 24 位元顯示成 4 個 emoji（64 選 1）。安全碼本身從不經網路傳送，所以房主無法替任何人「指定」安全碼。
4. 玩家開局前口頭或用聊天軟體比對安全碼。若房主對某位客機冒充他人（中間人），兩邊看到的公鑰不同，安全碼就會不一致。
5. **強制比對**：每位客機都要在自己的畫面按「一致」（`IDENTITY_CONFIRM`）；房主要等所有人確認才能開局。真正的把關在客機本機：沒按「一致」前，客機不會進入任何簽章牌局，就算房主不等確認就開局也一樣。按「不一致」會直接離開房間。

> **為什麼要先承諾**：若直接交換公鑰，房主可在看到真實公鑰後反覆產生假公鑰，直到兩邊的 24 位元安全碼相同（生日攻擊只需約 2¹² 次，瞬間完成）。先鎖定名冊後，房主給每個人看的內容在得知任何真實公鑰前就已固定，冒充成功的機率只剩 2⁻²⁴，而且每次失敗都會被看到。
>
> 實作：[`identityHandshake.ts`](../src/features/lobby/domain/identityHandshake.ts)（承諾、名冊檢查、安全碼）、[`LobbyHub.vue`](../src/features/lobby/ui/LobbyHub.vue)（握手流程與顯示）。成員變動時房主送出 `IDENTITY_RESET` 重新比對。

**簽章信封與證據紀錄**（[`secureChannel.ts`](../src/features/table/application/secureChannel.ts)）：開局後所有協定訊息都包成 `SignedEnvelope {seat, n, body, sig}`，簽的是 `twmj/msg/v1|房號|seat|n|body`，`n` 遞增防重放。房主是唯一的排序者：客機訊息送到房主、驗證後**原封不動**轉送給全部客機（含發送者），每台裝置以相同順序套用。每台裝置都保存收到的全部原始信封，可匯出成證據檔，第三方用其中的公鑰即可自行驗簽並重跑稽核，不必相信下載者或房主。

> 安全碼比對是「防房主偷看」的必要前提。不比對時，仍可擋住被動偷看，但擋不住主動冒充的房主。

### 4.4 開局：洗牌輪與換鑰輪

```
T = [T₀ … T₁₄₃]                                   # 144 張牌面點，公開且固定
洗牌輪：依座位順序，每位真人 p：deck ← shuffle(k_p · deck)        → 廣播 DECK_SHUFFLED
換鑰輪：依座位順序，每位真人 p：deck[i] ← k_{p,i} · k_p⁻¹ · deck[i] → 廣播 DECK_REKEYED + 144 筆 hash(k_{p,i})
```

- 洗牌輪結束後牌山是 `(∏k_p)·T_π(i)`，**沒有任何人知道 π**。
- 換鑰輪把「每家一把全域鎖」換成「每個位置一把獨立的鎖」。如此揭露某個位置的金鑰，不會連帶洩漏其他位置。
- 每一輪的輸出都廣播並由所有人保存，作為結算稽核的依據。
- 所有金鑰都由玩家的本局秘密推導（`Scalar::hash_from_bytes`），結算時只需公開一個秘密。

### 4.5 摸牌（含配牌、補花、嶺上）

1. 誰摸哪個牌山位置由**公開狀態**決定（`headCursor` / `tailCursor`），每家都算得出來。實作上，規則引擎讀到尚未宣告的位置（`WALL_UNKNOWN`）就丟出 `WallPending {位置, 摸牌座位}`，每台裝置都在同一步遇到同一組位置。
2. 輪到座位 d 摸位置 i 時，其他每位真人自動以 `crypto_box` 把 `k_{p,i}` 封裝給 d（電腦座位則封給房主），經房主轉送（`KEY_SHARE`）。
3. d 先比對每份分享與承諾 `hash(k_{p,i})` 是否相符，不符就**立即**知道是誰送錯；再用自己的 `k_{d,i}` 一起開鎖，查表得到牌。
4. d 送出 `TILE_RESOLVE`：花牌附上全部金鑰公開（補花是公開動作），其餘位置只宣告「不是花」。各家把該位置記為「不明牌」佔位（`hiddenTileAt(i)`，負值），然後重跑同一步。
5. 開局配牌時 65 個位置**批次**處理：每家一則 `KEY_SHARE`、每位持有者一則 `TILE_RESOLVE`。

### 4.6 公開牌（打出、亮花、吃碰槓）

所有動作都是 `SECURE_ACTION {seat, action, reveals}`，`reveals` 為 `{wallIndex, keys: 所有層的 k_{·,i}}`。每家驗證承諾並開鎖，把該座位手牌中的佔位換成真牌，再套用動作：

- 打出、宣告聽牌：公開打出的那張。
- 吃、碰、明槓：公開所用的手牌；各家依公開的牌重算選項後驗證。
- 暗槓、加槓：公開所用的牌（與現行一樣，暗槓的牌對其他人可見，畫面上兩張蓋著）。
- 自摸、胡：公開整手。

**回應窗一律開給三家**：因為沒人知道別家手牌，每次打牌後其餘三家都要回應；沒得吃碰胡的一方由本機自動送出「過」，畫面不會出現操作鈕。宣告聽牌時別家無法驗證是否真的聽牌，留到結算重播。

### 4.7 胡牌與結算稽核

1. 胡牌或流局時，每位真人廣播 `ROUND_REVEAL {seat, secret}`。
   牌局中途發現任何違規（送錯金鑰、公開無效的牌、輪到他卻送出不合法的動作）時，本局立即作廢並提早公開秘密；別家收到秘密也會跟著公開，大家一起稽核，找出根本原因（例如洗牌時複製了某張牌，表面症狀可能出現在別家）。
2. 每家從秘密推導出所有金鑰，然後：
   - 驗證每一輪洗牌：輸出是 `k_p · 輸入` 的一個排列（集合相等）。
   - 驗證每一輪換鑰：逐位置相等。
   - 解出完整牌山，**用現有規則引擎從頭重播整局**，逐步比對「公開投影」（[`secureAudit.ts`](../src/features/table/domain/secureAudit.ts)：張數、牌海、副露、花、游標、回應狀態、結算）。過水、詐胡、藏花、假聽牌都會在這一步抓到。
3. 稽核失敗時指出**是哪個座位、哪一步**，顯示在 `SettlementModal`；牌局中途作廢時牌桌上方也會出現提示。

### 4.8 斷線與拒絕合作

真人斷線後，他的那層鎖就打不開，未摸的牌山與他的手牌都無法解密。此時改為**降級繼續**，讓休閒玩家能打完這一局：

1. 房主送出 `DEGRADE {seat, reason}`。牌桌明確提示「○○ 斷線，本局防作弊已失效，改由房主發牌」，並由 Bot 接手該座位。
2. 剩下的真人把自己的暗牌證明（全部層的金鑰）**加密給房主**（`DEGRADE_HAND`，以 `crypto_box` 封裝，其他客機看不到）。房主逐張驗證承諾，且必須剛好是他手上那幾張。從這一刻起，房主知道所有人的牌，也就是回到房主可信的模型。
3. 房主計算未知牌池 = 144 張 − 已公開的牌（牌海、副露、花牌）− 已知的手牌（剩下的真人與電腦座位）。這些牌原本分布在斷線者手上和未摸的牌山裡；已宣告但還沒摸進手牌的位置也一併收回。
4. 以 Co-Seeded Commit-Reveal **重新洗牌**：房主先 `DEGRADE_COMMIT` 承諾秘密，再收剩下真人的 `DEGRADE_SEED`，依 `createCommittedWall(種子, 秘密)` 的排列排序牌池。代打座位拿前 n 張**非花牌**當新手牌（代打者手上不能有花），其餘依序放回未摸的位置；`DEGRADE_WALL` 公開每個位置對應的承諾索引。
5. 之後房主私下發牌（`DEGRADE_DEAL`，加密給持有者），公開的牌附承諾葉節點 `{tile, salt}`，各家即時驗證。降級前已摸的牌仍用原本的金鑰證明。
6. 結算時房主 `DEGRADE_REVEAL` 公開秘密，各家驗證承諾、自己的種子確實被採用、葉節點、以及「依重洗順序發牌」的規則。降級前的洗牌因為缺一層秘密而無法完整稽核，結算畫面標示「本局防作弊已失效」。

其他情況：

- **逾時**（房主每 2 秒檢查）：洗牌、金鑰分享、宣告、公開秘密等協定步驟 15 秒沒有進展時，指出卡住的座位；輪到某位真人出牌或回應卻 60 秒毫無動靜，也比照斷線處理。事件記錄在牌桌與證據檔中。
- 實測中直接關閉瀏覽器分頁時，WebRTC 的關閉事件不一定即時送達，此時由逾時機制在 15 秒內接手。
- 降級交接過程中又有人不回應：直接作廢本局。
- 已結算、只差公開秘密時有人離開：分數照算，標示未完整驗證。
- 房主若攔截不轉送，客機無法分辨是房主還是另一位客機的問題。房主會把卡住的座位判為逾時，雙方的證據檔都留著。
- 房主本人斷線：星狀拓撲下整個房間都會中斷，客機牌桌顯示「與房主的連線中斷」。
- 想維持嚴格模式的房間，可在大廳開啟「斷線即作廢」：改送 `ROUND_VOID`，本局不計分（比照流局連莊），下一局由剩下的真人繼續防作弊。

實作：[`degradeProtocol.ts`](../src/features/table/application/degradeProtocol.ts)（`DegradeSession`、`HostDeck`、`layoutDegradedWall`、`verifyDegradedWall`）。

**證據檔驗證**（[`evidenceVerifier.ts`](../src/features/table/application/evidenceVerifier.ts)）：大廳「驗證對局紀錄檔」匯入任何一位玩家下載的 JSON，重新驗每一則簽章與序號，逐局重算洗牌與換鑰，再以完整資訊從第一局起重播所有動作、重算分數；違規時指出座位。降級或作廢的局只驗證房主的重洗承諾，之後各局仍做牌山稽核，但分數無法從頭重算。

### 4.9 協定訊息草案（`src/shared/kernel/types.ts`）

身分握手（大廳，未簽章）：`IDENTITY_COMMIT`、`IDENTITY_ROSTER`、`IDENTITY_REVEAL`、`IDENTITY_KEYS`、`IDENTITY_RESET`（§4.3）。

牌局訊息一律包在 `SignedEnvelope {seat, n, body, sig}` 內：

```ts
| { type: 'ROUND_START'; round: number }                                     // 只有房主
| { type: 'DECK_SHUFFLED'; round: number; seat: SeatIndex; deck: string /* 144 × 32 bytes, base64 */ }
| { type: 'DECK_REKEYED'; round: number; seat: SeatIndex; deck: string; keyCommits: string }
| { type: 'KEY_SHARE'; round: number; from: SeatIndex; to: SeatIndex; wallIndices: number[]; sealed: string[] }
| { type: 'TILE_RESOLVE'; round: number; seat: SeatIndex; wallIndices: number[]; flowers: TileRevealProof[] }
| { type: 'SECURE_ACTION'; round: number; seat: SeatIndex; action: PlayerActionCommand; reveals: TileRevealProof[] }
| { type: 'ROUND_REVEAL'; round: number; seat: SeatIndex; secret: string }
```

實作：[`deckProtocol.ts`](../src/features/table/application/deckProtocol.ts)（洗牌、換鑰、金鑰分享、宣告、稽核）、[`secureTable.ts`](../src/features/table/application/secureTable.ts)（本機牌局流程）、[`useTableSession.ts`](../src/features/table/application/useTableSession.ts)（自動過、電腦座位、UI）。

每副牌山約 4.6 KB，WebRTC DataChannel 一則訊息就能送完。

## 5. 對牌桌狀態機的影響

兩位以上真人的房間不再由房主送出各家視角（`STATE_SYNC`），而是每台裝置用自己看得到的資訊跑同一套規則引擎（`TableState.openClaims = true`）：

- **所有人（包括房主）的狀態都是部分資訊**：別家的暗牌是負值佔位 `-(位置+1)`，引擎把它當成不是花、不屬任何牌種的「不明牌」。
- **房主是唯一的排序者**：所有訊息經房主轉送，每台裝置依相同順序套用；客機自己的動作也要等房主回送才套用。
- **吃、碰、槓、胡的選項由各家在本機計算**；宣告時公開所用的牌，各家依公開的牌重算後驗證。
- **只能事後驗證的動作**（宣告聽牌、過水）延到 §4.7 的重播稽核。
- 四家的「公開投影」必定一致（測試在每次網路靜止時逐一比對）。
- 原本的房主權威流程（`SEED_COMMIT`、`STATE_SYNC`、`ROUND_AUDIT`）保留在程式中供相容與測試；實際的連線房間都走 Mental Poker 牌局。

## 6. 原型驗證結果（2026-10-26）

原型為獨立 crate（`curve25519-dalek` 4、`crypto_box` 0.9、`rand_chacha` 0.9、`sha2` 0.10），沒有改動專案程式碼。

**測試（`cargo test --release`，8/8 通過）**

| 測試 | 驗證內容 |
|---|---|
| `full_round_deals_a_permutation_of_144_tiles` | 四家洗牌、換鑰後，144 個位置各解出一張牌，剛好是 0～143 的排列，而且確實洗亂了 |
| `missing_any_one_layer_reveals_nothing` | 對每個摸牌者、每個位置：只有另外三層金鑰（模擬房主收集到的資訊）都無法辨識任何一張牌 |
| `two_humans_are_enough` | 只有兩位真人時一樣成立 |
| `wrong_key_share_is_rejected_immediately` | 送錯金鑰：承諾比對立即抓到，開鎖結果也不是合法的牌 |
| `audit_passes_for_honest_round` | 誠實的一局通過稽核 |
| `audit_catches_a_shuffler_who_duplicates_a_tile` | 房主洗牌時多塞一張重複的牌，稽核指出座位 0 |
| `audit_catches_a_bad_rekey` | 換鑰輪竄改，稽核指出正確座位 |
| `sealed_share_relayed_by_host_stays_private` | 房主轉送的分享解不開；換位置重放、竄改一個位元都會被拒絕 |

**效能（4 位真人、144 張）**

| 項目 | 原生（release） | Wasm（Node，wasm-opt） |
|---|---|---|
| 開局：4 輪洗牌 + 4 輪換鑰（全部合計） | 32 ms | 82 ms |
| 開鎖 144 張（每張約） | 5.4 ms（0.04 ms） | ≈14 ms（0.1 ms） |
| 結算稽核 | 34 ms | ≈88 ms |
| Wasm 檔案大小 | — | 129 KB（專案整合時會與現有模組共用） |

結論：**運算成本可以忽略**，手機慢 3～5 倍也在半秒內。實際延遲主要來自網路：開局約 8 次依序轉送（< 1 秒），每次摸牌約多 1.5 個往返（經房主轉送，約 100～300 ms）。

尚未驗證：`ed25519-dalek` 簽章（標準用法，風險低）、實機 WebRTC 下的延遲、與現有狀態機的整合。

## 7. 工作包（Phase 5）

各工作包依 [`03-execution-plan.md`](./03-execution-plan.md) 的派發守則執行。

- [x] **WP-5.1：Rust 密碼核心 (`mental_poker.rs`)**
  - **目標檔案**：`crates/mahjong-core/Cargo.toml`、`crates/mahjong-core/src/mental_poker.rs`、`crates/mahjong-core/src/wall.rs`
  - **任務內容**：
    1. 加入 §4.2 的依賴；把 `wall.rs` 手寫的 SHA-256 換成 `sha2`（`leafHashes` 輸出必須不變，以既有測試把關）。
    2. 移植原型：牌面點、秘密推導、`shuffle_pass`、`rekey_pass`、承諾、`unlock`、`audit`（回傳作弊座位與步驟）、`seal_share` / `open_share`、`ed25519` 簽章與驗證。
    3. 移植 §6 的 8 個測試，並補上簽章測試。
  - **驗收指令**：`pnpm test:rust`

- [x] **WP-5.2：Wasm 綁定與 TS 封裝**
  - **目標檔案**：`crates/mahjong-core/src/lib.rs`、`src/shared/wasm/index.ts`
  - **任務內容**：匯出 WP-5.1 的介面（Wasm 邊界以 `Uint8Array` 傳遞點與純量，上線傳輸用 `bytesToBase64`），並用 `crypto.getRandomValues` 產生本局秘密；補上 Vitest 往返測試（`src/test/mentalPoker.test.ts`）。綁定為無狀態函式，秘密只留在 JS 端。加入密碼函式庫後 `.wasm` 由 206 KB 增為 438 KB（gzip 185 KB）。
  - **驗收指令**：`pnpm test:rust && pnpm test && pnpm build`

- [x] **WP-5.3：身分、安全碼與簽章信封**
  - **目標檔案**：`src/shared/kernel/types.ts`、`src/features/lobby/infra/peerAdapter.ts`、`src/features/lobby/ui/LobbyHub.vue`
  - **任務內容**：`IDENTITY_ANNOUNCE`、公鑰隨 `ROOM_SNAPSHOT` 下發、房間安全碼（4 個 emoji）顯示在大廳；所有協定訊息加上簽章，收到時驗證。
  - **驗收指令**：`pnpm test && pnpm build`

- [x] **WP-5.4：開局洗牌與摸牌協定**
  - **目標檔案**：`src/features/table/application/deckProtocol.ts`（新）、`src/shared/kernel/types.ts`
  - **任務內容**：§4.4～§4.6 的訊息流程（依序洗牌、換鑰、批次配牌、自動送出金鑰分享、公開牌）。測試使用 4 位真人的 `FakeTransport`。
  - **驗收指令**：`pnpm test && pnpm build`

- [x] **WP-5.5：牌桌狀態機去全知化**
  - **目標檔案**：`src/features/table/domain/tableState.ts`、`src/features/table/domain/stateView.ts`、`src/features/table/application/useTableSession.ts`
  - **任務內容**：§5 的部分資訊狀態、本機計算選項、以公開金鑰驗證宣告、§4.7 的結算公開與重播稽核（指出作弊座位）；兩位以上真人的房間啟用，其餘維持現行流程。
  - **驗收指令**：`pnpm test && pnpm build`
  - **必要測試**：房主端狀態看不到客機暗牌；洗牌作弊被抓到並指出座位；送錯金鑰立即被拒；違規動作在結算重播被抓到；完整打完兩局稽核通過。

- [x] **WP-5.6：斷線降級、UI 與文件**
  - **目標檔案**：`src/features/table/application/useTableSession.ts`、`src/features/table/ui/TableArena.vue`、`src/features/table/ui/SettlementModal.vue`、`docs/02-architecture-and-rules.md`
  - **任務內容**：§4.8 的斷線降級（交出暗牌、重洗未知牌池、Bot 接手、防作弊失效提示）與嚴格模式作廢選項；逾時責任紀錄；**證據檔下載與匯入驗證畫面**（`SecureChannel.exportEvidence()` 已就緒）；更新 `02` §4 的協定規格。（牌桌顯示安全碼、結算顯示稽核結果與責任方已在 WP-5.5 完成。）
  - **必要測試**：4 位真人中途 1 人斷線，降級後能打完並通過降級段稽核；重洗後的牌池與斷線前的公開牌、剩餘真人暗牌沒有重複。
  - **驗收指令**：`pnpm test && pnpm build`，並以兩個瀏覽器實機連線打完一局。

## 8. 待決問題

1. ~~**安全碼是否強制比對**~~：已決定強制（§4.3 第 5 點）。
2. **降級後的計分**：目前降級局照常計分，結算標示未完整驗證；是否不計入戰績待定（嚴格模式「斷線即作廢」則不計分）。
3. **Bot 座位**：接受房主看得到 Bot 的牌（建議接受，這等同多一位跟房主串通的玩家）。
4. **零知識洗牌證明**（Bayer-Groth）：可以把「洗牌作弊」從結算時偵測提前到開局時偵測，但目前沒有可信賴的函式庫，暫不納入。
