# NekoChat

語喵的 LINE 群聊元件，透過 [LINE.js 機器人 API `/api/ws`](https://github.com/JS-PACKAGE/LINE.js#機器人-apiapiws) 連線，不修改 LINE.js 本體，也不是 LINE Messaging API webhook。

## 啟動

需要 Node.js ≥ 22、npm、已登入的 LINE.js，以及可使用指定模型的 Anthropic API key。應用程式與測試皆使用 strict TypeScript，編譯後由 Node.js 執行。`start.sh` 會自動安裝缺少的依賴；若要手動安裝：

```sh
npm ci --include=dev --ignore-scripts
```

本機已有 `config.yaml` 時直接編輯，不要覆蓋。全新安裝且尚無設定檔時，從 `config.example.yaml` 複製為 `config.yaml` 並將檔案權限設為 `600`。啟動與檢查預設皆讀取 `config.yaml`。

1. 在 LINE.js 的 `config.yaml` 啟用 `api.enabled: true`，將要授權的聊天室 ID 加入 `api.chats`，重啟 LINE.js。
2. 在 **LINE.js 專案目錄**執行 `npm run cli -- token`，取得僅顯示一次的 Bot Token。
3. 填入 NekoChat `config.yaml` 的 `line.token` 與 `line.chats`。這是 LINE.js Token，**不是** Claude API key。本機設定已寫入指定的 Claude key；範本則不含任何金鑰。
4. 啟動：

```sh
./start.sh --check
./start.sh
```

`start.sh` 可從任意工作目錄執行，會先檢查 Node.js ≥ 22、執行依賴及 TypeScript 工具鏈；缺少或無法載入時自動執行 `npm ci --include=dev --ignore-scripts`，依照 lockfile 重建 `node_modules`，不執行套件安裝腳本，也不會覆蓋設定。即使 `NODE_ENV=production` 也會安裝編譯所需的開發依賴。每次啟動先編譯至 `dist/`；安裝、依賴載入或編譯失敗時停止，不啟動舊產物。`--check` 只驗證本機設定，不連線 LINE 或 Anthropic，但缺少依賴時仍會觸發安裝，可能連線 npm registry。指定其他設定檔可使用 `./start.sh --config /path/to/config.yaml`，相對設定路徑以專案目錄為基準；按 Ctrl+C 停止。修改設定後須重啟。`npm start`、`npm run check` 也會先編譯，但不會自動安裝依賴。

`line.chats` 不得留空；只有同時在 LINE.js 與 NekoChat 白名單內的聊天室會被處理。初次只在引用回覆語喵、LINE @ 標記語喵，或文字包含「語喵」時接話。接話後由 Claude 判斷後續訊息是否延續與語喵的對話，無關或不確定時保持安靜。請確認群組成員同意將訊息送往 Anthropic；建議先用測試群與次要 LINE 帳號驗證。

## 設定

| 欄位 | 用途 |
| --- | --- |
| `line.url` | 預設 `ws://127.0.0.1:3789/api/ws`；遠端連線要求 `wss://` |
| `line.token` | LINE.js 產生的 Bearer Token |
| `line.chats` | 要回覆的聊天室 ID 陣列 |
| `line.ownMemberIds` | 選填，聊天室 ID 對應自己在社群的成員 ID；未填時以 `chat:admins:get` 查詢，無法確認自身身分便不回覆該社群 |
| `line.textMaxLength` | 每段 LINE 文字的 UTF-16 長度上限，預設 8000；須不超過 LINE.js 設定 |
| `line.sendsPerMinute` | 本元件所有聊天室共用的滾動 60 秒發送上限，預設 20；不得高於 LINE.js 上限，多個機器人須自行分配額度 |
| `claude.apiKey` | Anthropic API key，僅供伺服器使用 |
| `claude.model` | `claude-haiku-5-5`，不會自動換用其他模型 |
| `claude.contextTokens` | 100000；可降低，不可提高 |
| `claude.maxOutputTokens` | 預設 4096，包含在上下文總額內 |
| `claude.timeoutMs` | 每輪計數與生成合計的逾時，預設 60000ms |
| `personalityFile` | 個性 Markdown 路徑，預設 `personality.md`；相對路徑以設定檔所在目錄為基準 |

直接編輯 `personality.md` 即可調整完整語喵個性，重啟後生效。檔案包含多人群聊規則與能力邊界：依 `sender.id` 區分成員，不把每個人都叫小語，不混淆不同成員的立場；名稱與文字以 JSON 資料送入，而非當成系統指令。這個元件沒有上網、操作檔案或執行指令等工具。個性檔案不存在或為空白時會拒絕啟動。

## 對話與斷線行為

- 每個聊天室使用獨立的記憶體上下文，同一聊天室依序回答，包含已成功發送的問答；不保存聊天紀錄到磁碟。
- 引用回覆語喵、有效 @ 標記或文字提到「語喵」都走直接回答，不受後續關聯度篩選影響；即使只是叫名字或換話題，也要求模型簡短回應。只有沒有直接觸發的後續訊息才判斷是否接話。
- 尚未接話的聊天室，沒有直接觸發條件的文字不送往 Claude。完整回答成功發送後才啟用後續關聯度判斷；後續即使決定不回覆仍會產生 Claude API 用量，不會把被忽略的訊息寫入對話上下文。無關訊息不關閉對話，之後仍依關聯度逐則判斷；不設固定時間逾時。
- 標記必須是 LINE 提供、指向自己帳號／社群成員 ID 的有效 mention，`@All` 或標記其他人不算。引用先比對已觀察或取得發送確認的自己訊息 ID（全域最多記住 10000 筆）；若不認得，透過 LINE.js `history:fetch` 分頁查詢該聊天室，確認被引用訊息的作者。因此重啟、重連前的引用，只要 LINE 歷史仍可取得也能觸發；查不到、作者不是自己或已收回時不視為直接觸發。歷史只用於辨識作者，不重播訊息、不將歷史正文送給 Claude。
- 後續判斷與回答在同一次模型生成完成，內部決策資料不傳送到 LINE。只是相同話題、其他成員彼此交談或關聯不明時不接話；判斷屬模型推論，並非保證零誤判。
- 每輪先呼叫 Anthropic 的 [token 計數 API](https://platform.claude.com/docs/en/api/messages/count_tokens)，確保人格、對話輸入、直接回答或關聯度決策提示與 schema、預留輸出合計不超過 100K tokens。超限時移除最舊的完整問答並重新計數，不裁切人格或最新訊息；只剩最新訊息仍超限便不生成，後續訊息若已無保留對話可判斷則保持安靜。
- 生成請求啟用 Anthropic [5 分鐘自動 prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)，重用相同人格與歷史前綴的計算，不是快取整份回答，也不省略 token 計數。首次寫入按官方快取寫入費率計價，命中後按較低讀取費率計價；快取可能到期或因直接回答／關聯度判斷的提示與工具不同而失效。快取由 Anthropic 管理，清除本機對話不代表立即刪除上游快取；不保證短對話每輪都更快。
- 模型出錯、計數失敗或回答因輸出額度截斷時，不傳送不完整回答，終端機記錄安全錯誤代碼，不輸出金鑰或訊息原文。
- 長回答分段發送，不拆開 Unicode surrogate pair；所有段落取得 `sent` 確認後，才將完整問答納入上下文。部分發送失敗不回滾已送出的段落，也不自動重送。
- 已準備好的回答在有額度時可每 250ms 發送一段，不再將每分鐘額度平均攤成固定等待。所有聊天室共用滾動 60 秒總量上限；額度耗盡才等待最早一次發送到期，斷線不會重設這份限流紀錄。等待中被取消的回答不會在稍後自動補送。Claude 生成與 LINE 確認仍需各自的網路時間。
- 依 [LINE.js 文字訊息轉換](https://github.com/JS-PACKAGE/LINE.js/blob/db2a0cd0add41f3a36d3fb2fccd52b09e9ca2183/src/line/provider.ts)，文字訊息的 `contentType` 是 `NONE`（不是 `TEXT`）。不回覆自己的訊息、歷史 snapshot、已收回或解密失敗的訊息、非文字訊息；保留最近 10000 個訊息 ID 去重。
- 與 LINE.js 斷線、初次連線失敗、心跳失敗時，**每次失敗後等待 10 秒重連**。WebSocket handshake 最多等待 10 秒；連線後每 30 秒 ping，10 秒未收到 pong 即重連。關閉程式會取消重連。
- 斷線或登出會取消待處理回答、清空上下文與身分資訊。重連後重新等待登入狀態，只處理新事件；不補抓斷線期間的訊息，也不重送結果不明的發送請求。去重資料跨重連保留、程式重啟則清除。
- 訊息被編輯、收回或聊天室被移出授權範圍時，清除該聊天室上下文並取消尚未完成的回覆，避免繼續使用已撤回的內容；不能撤回已送至 Anthropic 或 LINE 的內容。
- 上述上下文清理也會重設接話狀態，必須再次直接叫到語喵才會開始回答。斷線、登出或換帳號也會清除引用辨識資料；編輯訊息不改變原作者，但收回的訊息不能再用來觸發引用回覆。

## 安全與驗證

`config.yaml` 已被 `.gitignore` 排除，包含金鑰時必須維持權限 `600`；載入器拒絕符號連結與群組／其他使用者可讀的設定檔。範本不含金鑰。已在對話中貼出的金鑰建議撤銷後更換，切勿提交到 Git。

```sh
npm run typecheck
npm run build
npm test
```

`npm run typecheck` 僅檢查型別，`npm run build` 將 `src/` 與 `test/` 的 TypeScript 編譯至已忽略的 `dist/`；`npm test` 會先編譯，再以 Node.js test runner 執行測試。測試使用本機 WebSocket 與隔離的 Claude 回應，不消耗 API 額度，涵蓋上下文邊界、群聊隔離、自我回覆排除、取消、分段、發送確認及 10 秒重連。

開發驗證另曾以真實 `claude-haiku-5-5` 配合本機 `/api/ws` 測試伺服器執行實際 CLI，確認群聊辨識、完整收發及斷線重連。尚未以真實 LINE.js Bot Token／聊天室驗證 LINE 端收發。
選擇性回覆另以真實 Claude 與本機 `/api/ws` 執行驗證：未呼叫語喵時不生成、名字／標記／引用三種觸發可用、相關追問會回答、無關閒聊與其他成員之間的同主題對話保持安靜。

TypeScript 遷移另以全新隔離副本驗證 `start.sh` 自動安裝（含 `NODE_ENV=production`）、編譯及設定檢查；以本機 WebSocket 與模擬 Anthropic 回應啟動實際編譯後 CLI，確認選擇性觸發、收發確認、斷線重連及 Ctrl+C 關閉。編譯失敗時拒絕啟動舊產物；此驗證未呼叫真實 LINE 或 Anthropic 服務。

文字類型修正：先前測試錯用 `contentType: "TEXT"`，未能發現真實 LINE 文字會被忽略。現已對齊 `NONE`，回歸涵蓋 `＠語喵`、有效 mention 與後續關聯度判斷；本機 `/api/ws` 搭配模擬 Anthropic 的實際 CLI 驗證確認，顯示名稱不含「語喵」的有效 @ 標記也能觸發回覆。尚未在真實 LINE 群組驗證此修正。

直接觸發修正：68 項測試通過，涵蓋舊引用分頁辨識、作者與聊天室隔離、收回取消，以及無關閒聊後再次提名／標記／引用仍直接回應。實際 CLI 搭配本機 `/api/ws` 與模擬 Anthropic 已驗證上述收發流程；未在真實 LINE 群組或以真實 Claude 驗證本次修改。
