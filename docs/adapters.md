# 擴充 CLI 與 API

AI Roundtable 內建 Claude Code 與 Codex CLI。其他 AI 可以用擴充接進來,不需要改原始碼:

| 類型 | 適合 | 能修改檔案 | 檔案 |
| --- | --- | --- | --- |
| CLI | 有非互動模式的 AI CLI,例如 Grok CLI、Kimi Code CLI、Gemini CLI | 可以 | `.json`,`"type": "cli"` |
| API | OpenAI 相容的 Chat Completions API,例如 DeepSeek、Kimi、Grok、OpenRouter、Ollama | 不行,只能討論與審查 | `.json`,`"type": "openai"` |
| JS 外掛 | JSON 描述不了的情況 | 自己決定 | `.js` |

## 快速開始

1. 左側「CLI 與擴充」按「+ 新增」,選一個範本。
2. 範本會複製到你的擴充資料夾並打開編輯器,改好後按「儲存並載入」。
3. 設定有錯時,編輯器與側欄會直接顯示原因。
4. 到成員設定的「AI CLI」選單選擇新的擴充。

擴充資料夾位於 `~/Library/Application Support/AI Roundtable/adapters/`,按側欄的 📁 可以直接打開。也可以直接在資料夾裡新增或修改檔案,再按 ↻ 重新載入。

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
| `timeoutMs` | 否 | 單回合逾時,預設 10 分鐘 |

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
| `apiKeyEnv` | 無 | 讀取 API key 的環境變數名稱(建議) |
| `apiKey` | 無 | 直接寫 API key。會以明碼存在擴充資料夾,不建議 |
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
| `maxHistoryMessages` | `80` | 保留的歷史訊息數 |

### 設定 API key

在 `~/.zshrc` 加上:

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
  models: ['a', 'b'],       // 或 listModels(kit) / refreshModels(kit)
  async run(agent, ctx, kit) {
    // agent:model、effort、canEdit、name…
    // ctx:prompt、systemPrompt、sessionId、cwd、timeoutMs
    //      onText(全文)、onThinking(全文)、onActivity(動作)、onSession(id)、onProc(可停止的行程)
    return { text: '回覆', thinking: '', sessionId: null, usage: null, error: null };
  },
};
```

也可以匯出 `(kit) => ({ ... })`。`kit` 提供 `runProcess`、`buildArgs`、`render`、`getPath`、`matches`、`truncate`、`createStopHandle`、`resolveEffort` 等工具,定義在 [src/adapters/kit.js](../src/adapters/kit.js)。

長時間的工作請把行程或 `kit.createStopHandle(() => abort())` 傳給 `ctx.onProc`,使用者按「停止」時才停得下來。

## 安全

- 擴充會以你的帳號權限執行指令。JS 外掛在 app 主程序中執行,擁有完整的 Node.js 權限。只安裝你看得懂、信任的擴充。
- CLI 擴充在成員開啟「允許修改檔案」時,通常會帶上自動核准的參數,例如 `--yolo` 或 `--always-approve`。
- API key 建議用環境變數,不要寫進擴充檔。

## 分享擴充

擴充就是一個檔案,可以直接分享。歡迎把好用的設定送 pull request 到 `adapters/templates/`。

範本裡的 Grok CLI、Kimi Code CLI、Gemini CLI 是依官方文件撰寫,作者沒有實際安裝測試。如果參數或輸出格式不同,歡迎回報或修正。
