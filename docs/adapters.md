**繁體中文** | [English](adapters.en.md)

# 擴充 CLI 與 API

AI Roundtable 內建 Claude Code、Codex CLI、Cursor CLI 與 GitHub Copilot CLI。其他 AI 可以用擴充接進來,不需要改原始碼:

| 類型 | 適合 | 能修改檔案 | 檔案 |
| --- | --- | --- | --- |
| CLI | 有非互動模式的 AI CLI,例如 Grok CLI、Kimi Code CLI、Gemini CLI | 可以 | `.json`,`"type": "cli"` |
| API | OpenAI 相容的 Chat Completions API,例如 DeepSeek、Kimi、Grok、OpenRouter、Ollama | 預設不行；明確啟用受限檔案工具並通過 reviewer 閘門後才可改檔 | `.json`,`"type": "openai"` |
| JS 外掛 | JSON 描述不了的情況 | 自己決定 | `.js` |

## 快速開始

1. 左下角「⚙ 設定」→「AI 連接」按「+ 新增」,選一個範本。
2. 範本會複製到你的擴充資料夾並打開編輯器,改好後按「儲存並載入」。
3. 設定有錯時,編輯器與設定頁會直接顯示原因。
4. 到成員設定的「AI CLI」選單選擇新的擴充。

擴充資料夾位於 `~/Library/Application Support/AI Roundtable/adapters/`,在「設定 → 資料與紀錄」可以直接打開。也可以直接在資料夾裡新增或修改檔案,再到「設定 → AI 連接」按 ↻ 重新載入。

開發時可以用環境變數 `AI_ROUNDTABLE_ADAPTERS_DIR` 指定其他資料夾。

## 共用欄位

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `id` | 是 | 唯一代號,英數字與 `. _ -`。成員設定會存這個值。和內建的 `claude`、`codex` 相同時會覆寫內建 |
| `type` | JSON 必填 | `cli` 或 `openai` |
| `label` | 否 | 顯示名稱 |
| `description` | 否 | 範本與成員設定裡的說明 |
| `models` | 否 | 模型清單,見下方;`openai` 類型可以寫 `"auto"` |
| `efforts` | 否 | 手動輸入模型、或模型沒限制強度時可選的強度 |
| `timeoutMs` | 否 | 單回合模型逾時,預設 20 分鐘；模型下載等背景工作不套用此值。擴充編輯器的「每回合逾時上限」以分鐘設定同一個欄位;逾時的錯誤訊息會提示在那裡調高 |
| `usageShape` | 否 | 用量欄位的慣例,見[用量正規化](#用量正規化)。不填時依欄位特徵自動判斷 |
| `capabilities` | 否 | 附件能力,格式見下方 |
| `docsUrl` | 否 | 安裝或設定說明頁。這個 CLI / 服務不在時,介面顯示「打開安裝說明」 |

### 出問題時的下一步

偵測到環境問題時(沒安裝、沒登入、連不上、缺 key),介面一律用同一張卡片:照實說一句話,
再給一個可照做的動作。JS 外掛的 `check()` / `testConnection()` 與 `run()` 都可以在回傳值裡帶 `fix`:

```js
return { ok: false, state: 'unauthenticated', hint: '請先執行 my-cli login', fix: { command: 'my-cli login' } };
```

`fix` 三選一,由具體到一般:`command`(一行指令,會填進內建終端但**不會自動執行**)、
`settingsTab`(要在 app 裡做的事,例如填 API key 用 `'clis'`)、`url`(官方說明頁)。
JSON 範本不寫 `fix`,改用 `fixCommand` 與 `docsUrl` 兩個欄位。
`run()` 沒帶 `fix` 時,回合失敗後 app 會自己問一次 `check()` 補上——所以多數擴充什麼都不必做。

### 附件能力

```json
"capabilities": {
  "attachments": ["filePath"],
  "attachmentsNeedCwd": false
}
```

`attachments` 可包含 `filePath`、`imageInline`、`textInline`。CLI 通常使用 `filePath`;OpenAI 相容 API 不宣告時只用 `textInline`,確定模型收圖片才加上 `imageInline`(端點以 400/415/422 拒絕圖片時會自動略過圖片改用純文字重送)。只有確定 CLI 無法讀取工作目錄外的絕對路徑時才將 `attachmentsNeedCwd` 設為 `true`。

### 模型清單

可以寫字串,也可以寫物件:

```json
"models": [
  "simple-model",
  { "id": "pro-model", "label": "Pro", "description": "說明", "aliases": ["pro"], "efforts": ["low", "high"], "defaultEffort": "high" }
]
```

- 有寫 `efforts` 的模型,選到不支援的強度時會自動降到最接近的等級,並在對話中標示。
- `efforts` 寫空陣列代表不支援強度,不會傳強度參數。
- 沒寫 `efforts` 代表不限制,照使用者選的送出。

## 用量正規化

各家 CLI / API 回報的用量欄位名稱與語意都不一樣,`src/usage.ts` 會在 `runTurn` 出口統一成同一種形狀,介面與匯出才能安全地跨成員加總:

| 正規化欄位 | 意義 |
| --- | --- |
| `inputTokens` | **含快取命中與快取寫入的完整輸入總量** |
| `cachedInputTokens` | 其中命中快取的部分(`inputTokens` 的子集) |
| `cacheWriteTokens` | 其中寫入快取的部分(`inputTokens` 的子集,與 `cachedInputTokens` 互斥) |
| `outputTokens` | 輸出 |
| `costUsd` | 金額,只有部分來源會回報 |
| `shape` | 實際採用的慣例,或 `unknown` |
| `raw` | 原始物件,永遠原樣保留 |

**沒有回報的欄位是 `null`,不是 `0`。**「這個來源沒給這個數字」和「這個數字確定是零」在加總時意義完全不同,消費端只會加總實際有值的紀錄,並顯示每一欄涵蓋了幾位成員、幾個回合。

### 各慣例的欄位對應

| `usageShape` | 來源 | `inputTokens` | `cachedInputTokens` | `cacheWriteTokens` |
| --- | --- | --- | --- | --- |
| `anthropic` | Claude Code | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` |
| `codex` | Codex CLI | `input_tokens`(本來就含快取) | `cached_input_tokens` | 不回報(`null`) |
| `cursor` | Cursor CLI | `inputTokens` + `cacheReadTokens` + `cacheWriteTokens` | `cacheReadTokens` | `cacheWriteTokens` |
| `openai` | OpenAI 相容 API | `prompt_tokens`(本來就含快取) | `prompt_tokens_details.cached_tokens` | 不回報(`null`) |

Anthropic 的三個欄位互斥,**相加才是完整的 prompt**。只取 `input_tokens + cache_read_input_tokens` 會在寫入快取的回合嚴重少報 —— 實測一筆真實資料是 38058 對 28099,少了 26%。

`total_cost_usd` 目前只有 Claude Code 會回報。已實測確認它是**單次 invocation 的成本**而非 session 累計(同一 session 跑兩回合,第二回合 `--resume` 的金額 0.020398 小於第一回合的 0.113749;若是累計就不可能遞減),所以逐則相加是正確的。

### 沒填 `usageShape` 時

依欄位特徵自動判斷,只在簽名沒有歧義時才下結論:

1. 有 `cache_read_input_tokens` 或 `cache_creation_input_tokens` → `anthropic`
2. 有 `prompt_tokens` 或 `completion_tokens` → `openai`
3. 有 `cached_input_tokens` → `codex`
4. 有 `cacheReadTokens` 或 `cacheWriteTokens` → `cursor`
5. 只有 `input_tokens` 與 `output_tokens`、完全沒有任何快取欄位 → `codex`(此時快取為零,「含快取」與「不含快取」兩種解讀會收斂到同一個數字,所以這不是猜測)
6. 都不符合 → `unknown`

`unknown` 的紀錄會保留 `raw` 並在介面與匯出中逐項顯示原始欄位,但**不會納入跨來源總計**,總計會標明有幾則未納入。錯誤推定比不加總更危險,所以認不得就不猜。

## CLI 類型

```json
{
  "id": "grok",
  "label": "Grok CLI",
  "type": "cli",
  "bin": "grok",
  "input": "arg",
  "systemPrompt": "prepend",
  "args": [
    "-p", "{prompt}",
    "--output-format", "streaming-json",
    "--cwd", "{cwd}",
    ["-m", "{model}"],
    ["--effort", "{effort}"],
    ["--resume", "{sessionId}"],
    { "if": "canEdit", "then": ["--always-approve"] }
  ],
  "output": {
    "format": "jsonl",
    "rules": [
      { "match": { "type": "text" }, "text": "data" },
      { "match": { "type": "end" }, "sessionId": "sessionId" },
      { "match": { "type": "error" }, "error": "message" }
    ]
  }
}
```

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `bin` | 必填 | 指令名稱或完整路徑 |
| `args` | `[]` | 參數,見下方 |
| `input` | `stdin` | 提示詞送法:`stdin`、`arg`(用 `{prompt}`)、`file`(寫成暫存檔,用 `{promptFile}`)、`none` |
| `systemPrompt` | `prepend` | 角色設定送法:`prepend` 在沒有續接時接在提示詞前面;`arg` 用 `{systemPrompt}`;`none` 不送 |
| `output.format` | `text` | `text` 每行都是回覆;`jsonl` 每行一個 JSON 事件;`json` 結束後解析整段輸出 |
| `output.rules` | `[]` | 從 JSON 事件取出內容的規則,見下方 |
| `output.sessionIdPattern` | 無 | 從 stdout 與 stderr 用正規表示式抓 session id,取第一個群組 |
| `output.nonJsonLines` | `ignore` | `jsonl` 模式遇到非 JSON 行:`ignore` 或 `text` |
| `supportsResume` | 自動 | 有 `sessionId` 規則或 `sessionIdPattern` 時為 true。不支援續接時,每回合會送完整對話紀錄 |
| `supportsEdit` | `true` | false 時成員不能開啟「允許修改檔案」 |
| `env` | 無 | 額外環境變數,值可用佔位 |
| `shell` | `false` | 用 shell 執行 |
| `successExitCodes` | `[0]` | 視為成功的結束代碼 |
| `versionArgs` | `["--version"]` | 檢查是否安裝時用的參數;`null` 只確認指令存在;`false` 不檢查 |

### 參數與佔位

可用佔位:`{prompt}`、`{promptFile}`、`{systemPrompt}`、`{model}`、`{effort}`、`{sessionId}`、`{cwd}`、`{canEdit}`、`{agentName}`。要輸出大括號本身時寫 `{{` 與 `}}`。

`args` 的每個元素可以是:

| 寫法 | 行為 |
| --- | --- |
| `"--flag"` 或 `"{model}"` | 單一參數;含佔位且值為空時略過 |
| `["-m", "{model}"]` | 參數群組;任一佔位為空就整組略過 |
| `{ "if": "canEdit", "then": [...], "else": [...] }` | 依條件選擇 |

條件寫法:`"name"` 有值、`"!name"` 沒值、`"name=value"` 相等、`"name!=value"` 不相等,陣列代表全部成立。

### 輸出規則

每個 JSON 事件會依序套用所有符合 `match` 的規則。

| 欄位 | 說明 |
| --- | --- |
| `match` | 比對條件,key 是點號路徑。值可以是字面值、陣列(其中之一),或 `{"$exists": true}`、`{"$startsWith": "x"}`、`{"$regex": "..."}`、`{"$ne": x}`、`{"$in": [...]}` |
| `each` | 對事件中的陣列逐項套用,之後的路徑相對於每一項;`$event` 指整個事件 |
| `text` | 回覆文字的路徑 |
| `mode` | `append` 串接片段(預設)、`message` 當成新段落、`replace` 取代全部 |
| `thinking` / `thinkingMode` | 思考過程的路徑與模式 |
| `sessionId` | session id 的路徑 |
| `usage` | 用量物件的路徑 |
| `error` | 錯誤訊息的路徑 |
| `activity` | 顯示成工具動作:`id`、`title`、`detail`、`result`、`status`(`running`、`done`、`error`)。值是範本字串,例如 `"工具:{function.name}"`;相同 `id` 會更新同一筆 |

## API 類型(OpenAI 相容)

```json
{
  "id": "deepseek",
  "label": "DeepSeek API",
  "type": "openai",
  "baseUrl": "https://api.deepseek.com",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "models": [{ "id": "deepseek-v4-pro", "efforts": ["low", "high", "max"] }],
  "effortBody": { "thinking": { "type": "enabled" }, "reasoning_effort": "{effort}" }
}
```

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `baseUrl` | 必填 | API 根網址 |
| `secretRef` | 無 | 「設定 → AI 連接」安全儲存 API key 後自動寫入的參照;不要手動放入 key |
| `apiKeyEnv` | 無 | 讀取 API key 的環境變數名稱;安全儲存未設定時使用 |
| `headers` | 無 | 額外 HTTP header |
| `path` | `/chat/completions` | 對話端點 |
| `models` | 無 | 模型清單,或 `"auto"` 從 `modelsPath` 取得(每 10 分鐘更新) |
| `modelsPath` | `/models` | 模型清單端點 |
| `modelFilter` | 無 | 自動清單的正規表示式篩選 |
| `defaultModel` | 無 | 成員沒選模型時使用 |
| `body` | 無 | 額外請求欄位,字串可用 `{model}`、`{effort}` |
| `effortBody` | `{"reasoning_effort": "{effort}"}` | 有選強度時合併進請求 |
| `systemRole` | `system` | 角色設定使用的 role |
| `reasoningFields` | `["reasoning_content", "reasoning"]` | 串流中思考內容的欄位 |
| `stream` | `true` | 是否串流 |
| `streamUsage` | `true` | 串流時要求回傳用量;不支援的服務設 false |
| `history` | `true` | 在記憶體保留對話歷史來續接;關閉後每回合送完整紀錄 |
| `maxHistoryMessages` | `80` | 保留的歷史訊息數,必須是正整數；`0`、負數或非整數會驗證失敗 |
| `unreachableHint` | 通用提示 | 免金鑰 HTTP 端點連不上時顯示的處理方式,例如 `請先執行 ollama serve` |
| `fixCommand` | 無 | 照著跑就能修好的一行指令,例如 `ollama serve`。介面會在狀態旁放一顆「在終端執行」,按下去會把指令填進內建終端(不會自動執行) |
| `docsUrl` | 無 | 安裝或設定說明頁。這個 CLI / 服務不在時,介面顯示「打開安裝說明」 |
| `supportsEdit` | `false` | 必須明確設為 `true`，且同時設定 `fileTools.enabled: true` 才宣告可改檔；仍需執行流程通過 reviewer 閘門 |
| `fileTools.enabled` | `false` | 啟用受限的 `read_file`、`replace_text`、`write_file` 工具；不提供 shell 或 `apply_patch` |

### Ollama 與 Qwen3.8

內建的 `ollama-api.json` 範本已針對約 18GB、27.3B 參數的多模態模型 `qwen3.8:27b-mlx` 設好 OpenAI 相容端點、20 分鐘逾時與最多 16 則歷史訊息，建議至少 32GB 記憶體。範本固定送出 `reasoning_effort: "none"` 關閉 thinking，並停用強度覆寫，以縮短等待時間並避免推理內容干擾 `[ASK]` / `[AGREED]` 控制標記。

真機對照中，同一個短題目未帶參數時產生 118 字元的獨立 `reasoning`、82 個 completion tokens，耗時 5709ms；帶 `reasoning_effort: "none"` 時沒有 reasoning、只產生 6 個 tokens，耗時 856ms。Ollama 會把 thinking 放在獨立的 `reasoning` 欄位，不會混進正文，因此也不會誤觸正文中的 `[ASK]` / `[AGREED]` 解析。

```bash
ollama pull qwen3.8:27b-mlx
ollama serve
```

接著在「設定 → AI 連接」加入 Ollama 範本，並在成員設定選擇 `qwen3.8:27b-mlx`。模型清單來自 `http://localhost:11434/v1/models`;若 app 顯示端點無法連線，先確認 `ollama serve` 正在執行。此範本會把 png / jpeg / webp / gif 圖片以 OpenAI `image_url` data URI 傳給模型；其他附件仍以文字處理。

簡易設定介面可直接呼叫同一個後端方法，不必顯示端點或 JSON：先以 `registry.quickSetupOllama()` 取得 `{ models, recommendedModel }`，讓使用者只選模型；再以 `registry.quickSetupOllama({ model })` 建立或更新設定。回傳的 `adapterId` 與 `selectedModel` 可直接寫入成員設定。偵測會使用既有設定的 `baseUrl`；更新時保留端點、認證、逾時與歷史上限等環境偏好，但模型能力、thinking 與附件支援會套用最新範本，避免舊設定讓選項失效或圖片無法送出。模型清單中的 `name:latest` 也會自動接受裸名 `name`，但其他 tag 不會被猜測或替換。

內建的 OpenAI 相容範本（Ollama、DeepSeek、OpenRouter、Grok、Kimi，以及空白 API 範本）都已明確宣告 `supportsEdit: true` 與 `fileTools.enabled: true`，adapter 端提供三個受限工具：`read_file`、以精確且唯一原文為主的 `replace_text`，以及建立小檔／整檔覆寫用的 `write_file`。第一版刻意不提供 shell 與 `apply_patch`。所有路徑都必須位於工作目錄內，並一律禁止讀寫 `.git`、`.hg`、`.svn` 等版本控制內部檔案，避免透過 hook 或設定間接執行指令；symlink 別名也會在 realpath 後再次檢查。此外，會被自動執行的路徑一律**禁止寫入但允許讀取**（讀 `package.json` 是理解專案的正當需求，寫進去才會讓程式碼真的跑起來）：路徑含 `.husky`、`.vscode`、`.idea`、`.claude`、`.github`、`.devcontainer`、`node_modules` 任一層，根層的 `package.json`、`.npmrc`、`.yarnrc*`、`.pnpmfile.cjs`、`Makefile`、`lefthook.*`、`.pre-commit-config.*`，以及任何已帶執行權限（mode `0o111`）的既有檔案。`.husky/pre-commit` 與 `.git/hooks/pre-commit` 效果完全相同，只擋後者沒有意義。既有檔案修改前必須先讀取並帶回 SHA-256；檔案在兩次操作間改變就會拒絕寫入。單檔上限 256KB，`read_file` 單次回傳上限 65536 個字元（UTF-16 code units；`limit` 超過就夾到上限，不因此失敗，只有內容未完整回傳才標 `truncated`），`replace_text.oldText` 至少 24 個字元，工具呼叫與回傳量也有每回合硬上限。成功與失敗結果都會產生可寫入 transcript 的紀錄，供另一位 reviewer 檢查。增刪行數採逐行 shortest-edit diff；病態的大型重排超過運算保護值時會標示為近似值，reviewer 應以紅綠 diff 為準。

工具不會只因範本或成員勾選「允許修改檔案」就送給模型。三個條件必須同時成立：範本明確啟用 `supportsEdit` 與 `fileTools.enabled`、成員允許改檔、divide 流程存在另一位合格 reviewer。orchestrator 只有在事前確認 reviewer 可用時才傳入 `RunContext.fileToolsEnabled: true`；同一位執行者不能審自己的改動。工具成功與失敗會以 `tool-audit` 系統訊息進入 transcript，讓 reviewer 看到實際操作而不只看模型的文字報告；完整 `read_file` 內容不會重複寫入。事前有人可審不代表事後一定成功，若審查逾時、崩潰或空白，執行訊息會標示「尚未審查」，使用者應開啟紅綠 diff 自行確認。

**模型能力。**範本支援工具，不代表成員選的模型支援（同一個 Ollama 範本可以選到會呼叫工具的 qwen，也可以選到不會的 gemma3）。app 會用免費的來源確認：Ollama 的 `POST /api/show` 直接回報 `capabilities`；端點的模型清單若附帶能力資料（例如 OpenRouter 的 `supported_parameters` 與 `architecture.input_modalities`）就直接採用。付費端點不會自動發出對話請求：使用者在成員設定按「測試」時才送出 3 個很小的請求（先確認基準請求成功，再分別帶工具、帶圖片），結果存在 `model-capabilities.json`。已知不能呼叫工具的模型會被當成唯讀成員（`effectiveCanEdit` 為 false），審查時直接附上檔案內容而不送工具；已知不能看圖的模型不會收到圖片，附件區塊照實告訴它看不到那些圖，送出前的提醒也會點名它。

交叉審查回合是例外：審查者若是啟用檔案工具的 API 範本，會拿到**唯讀**的 `read_file`（`RunContext.readOnlyFileTools`）。讀取不改變任何東西，所以不需要成員允許改檔，也不需要 reviewer 閘門；即使模型自己呼叫 `write_file` 或 `replace_text` 也會被擋下。範本支援工具不代表成員選的模型支援，因此要審的檔案內容 orchestrator 一律同時附在提示詞裡；端點以 HTTP 400、404 或 422 拒絕帶工具的請求時，adapter 會不帶工具重送一次，並告訴模型這次沒有工具可用。附上的內容只用於那一回合，存進對話記憶時會換成一行說明。

遠端 API 成員與本機 Ollama 走同一條路徑：模型只送出工具參數，實際的路徑解析與寫檔一律在使用者機器上由 app 執行，因此同一組沙箱限制（工作目錄邊界、`.git` 等版控內部封鎖、寫入前的 SHA-256 檢查）對遠端供應商同樣成立。反過來說，工具參數此時來自遠端模型，必須當成不可信輸入看待——沙箱是唯一的邊界，不要依賴模型自己守規矩。

### 設定 API key

一般使用者可在「設定 → AI 連接」的 API key 欄位輸入,app 會用作業系統安全儲存加密,不會把明文寫進擴充 JSON。也可以在 `~/.zshrc` 加上:

```bash
export DEEPSEEK_API_KEY="sk-..."
```

重開 app 後會自動讀到,從 Finder 或 Dock 開啟也可以。

## JS 外掛

JSON 描述不了時,寫一個 `.js` 檔。範例見 [adapters/templates/aider-plugin.js](../adapters/templates/aider-plugin.js)。

```js
module.exports = {
  id: 'my-agent',
  label: 'My Agent',
  bin: 'my-agent',          // 有寫就會自動檢查是否安裝
  supportsResume: false,
  supportsEdit: true,
  // 附件能力,格式同 JSON;不寫時依 supportsEdit 判斷(可改檔案 → filePath + textInline,否則 textInline)
  capabilities: { attachments: ['filePath'], attachmentsNeedCwd: false },
  models: ['a', 'b'],       // 或 listModels(kit) / refreshModels(kit)
  async run(agent, ctx, kit) {
    // agent:model、effort、canEdit、name…
    // ctx:prompt、systemPrompt、sessionId、cwd、timeoutMs、attachments(附件 metadata 與可讀路徑)
    //      onText(全文)、onThinking(全文)、onActivity(動作)、onSession(id)、onProc(可停止的行程)
    return { text: '回覆', thinking: '', sessionId: null, usage: null, error: null };
  },
};
```

也可以匯出 `(kit) => ({ ... })`。`kit` 提供 `runProcess`、`buildArgs`、`render`、`getPath`、`matches`、`truncate`、`createStopHandle`、`resolveEffort` 等工具,定義在 [src/adapters/kit.ts](../src/adapters/kit.ts)。

長時間的工作請把行程或 `kit.createStopHandle(() => abort())` 傳給 `ctx.onProc`,使用者按「停止」時才停得下來。

## 安全

- 擴充會以你的帳號權限執行指令。JS 外掛在 app 主程序中執行,擁有完整的 Node.js 權限。只安裝你看得懂、信任的擴充。
- CLI 擴充在成員開啟「允許修改檔案」時,通常會帶上自動核准的參數,例如 `--yolo` 或 `--always-approve`。
- API key 請在擴充編輯器的 API key 欄位填入(加密儲存),或使用環境變數,不要寫進擴充檔。擴充檔裡的明文 `apiKey` 欄位已停用,載入時會自動搬到安全儲存;無法搬移時該擴充會載入失敗並顯示原因。

## 分享擴充

擴充就是一個檔案,可以直接分享。歡迎把好用的設定送 pull request 到 `adapters/templates/`。

範本裡的 Grok CLI、Kimi Code CLI、Gemini CLI 是依官方文件撰寫,作者沒有實際安裝測試。如果參數或輸出格式不同,歡迎回報或修正。
