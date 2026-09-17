# AI Roundtable

讓多個 AI CLI(Claude Code、Codex CLI、Cursor CLI,或任何自訂指令)在同一張圓桌上討論、分工、執行、互相審查的 macOS 桌面應用。

> A desktop app that seats multiple AI coding CLIs and APIs (Claude Code, Codex CLI, Cursor CLI, Grok, Kimi, DeepSeek, Gemini, Ollama, or anything you plug in) at one table: they debate a task, split the work, execute in parallel, and review each other's output. You watch the whole conversation live and can jump in at any time.

![AI Roundtable 畫面](docs/screenshot.png)

## 特色

- **多個 AI 同桌**:內建 Claude Code、Codex CLI、Cursor CLI;Grok、Kimi、DeepSeek、Gemini、OpenRouter、Ollama 等可從範本一鍵加入。
- **可擴充**:用 JSON 描述任何 CLI 或 OpenAI 相容 API,也能寫 JS 外掛,在 app 內直接編輯與重新載入。
- **每位成員各自設定**:角色個性、模型、推理強度、是否允許改檔案。
- **討論 → 分工 → 平行執行 → 交叉審查 → 總結**,全程即時串流顯示,包含工具呼叫與思考過程。
- **隨時插話**:進行中送出的訊息會在下一位成員發言時帶入。
- **@ 指定成員**:輸入 `@名稱` 只讓指定的成員回覆或動手,不跑整套討論流程;同時指定多位時平行處理。
- **繼續歷史對話**:從左側「歷史對話」打開任一筆紀錄,按「繼續這段對話」即可接著討論。
- **平行發言並排**:執行、審查等平行階段的成員訊息每列並排三張。
- **直接用你現有的 CLI 訂閱**,不需要另外申請 API key。

## 需求

- macOS(其他平台尚未測試)
- Node.js 20 以上
- 至少一個 AI 來源:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 、[Codex CLI](https://github.com/openai/codex) 或 [Cursor CLI](https://cursor.com/cli)(`cursor-agent`),安裝並登入即可直接使用
  - 或其他 CLI / API,透過擴充接入

## 啟動

```bash
git clone https://github.com/yanmin841111-byte/ai-roundtable.git
cd ai-roundtable
npm install
npm start
```

左下角會顯示偵測到的 CLI 與版本。找不到時請確認指令在登入 shell 的 `PATH` 裡。

打包成 .app / .dmg:

```bash
npm install --save-dev electron-builder
npm run dist
```

## 流程

送出任務後,依「模式」不同:

- **討論 → 分工執行 → 交叉審查**
  1. 成員依序輪流發言,每人看得到之前所有人的話。某成員認為已有共識時會在回覆末尾寫 `[AGREED]`;同一回合全員同意即進入分工,否則到達「最大討論回合」後強制進入。
  2. 主持人輸出 JSON 分工表,盡量讓每人負責不同檔案。
  3. 所有成員**平行**在工作目錄執行自己的工作。
  4. 每位成員審查下一位成員的成果(會實際打開檔案看)。
  5. 主持人總結。
- **只討論,不執行**:討論到共識或回合上限後由主持人總結。

訊息裡用 `@名稱` 指定成員時,只有被指定的成員會回覆(多位時平行執行);進行中指定的話,對方會在下一次發言時看到,任務結束前還沒輪到就補一次回覆。

進行中隨時可以送出訊息,會在下一位成員發言時帶入;「停止」會中止所有 CLI 程序。「新對話」會清空對話與各成員的 session 記憶。

## 成員設定

點左側成員卡片可編輯:

| 欄位 | 說明 |
| --- | --- |
| AI CLI | 內建的 Claude Code、Codex CLI、Cursor CLI、自訂指令,或你加入的擴充 |
| 模型 / 版本 | 自動讀取各 CLI 的本機模型快取,只列正式、未退役的模型;選「其他(手動輸入)」可填任意模型名稱 |
| 強度 | 選項依模型而定;模型不支援時會自動降到最接近的等級,或略過不送,並在對話中標示 |
| 角色與個性 | 會放進系統提示,決定成員的立場與說話方式 |
| 允許修改檔案 | 開啟時 Claude 用 `--dangerously-skip-permissions`、Codex 用 `workspace-write`、Cursor 用 `--force`;關閉時只能讀取(Cursor 用 `--mode ask`) |
| 自訂指令 | 提示詞從 stdin 送入、stdout 當作回覆,可用 `{model}`、`{effort}` 佔位,例如 `gemini -m {model} -p -` |

主持人在「設定」區選擇,負責分工與總結。

## 擴充其他 CLI 與 API

左下角「⚙ 設定」→「CLI 與擴充」按「+ 新增」,從範本加入其他 AI:

| 範本 | 類型 | 需要 |
| --- | --- | --- |
| Grok CLI、Kimi Code CLI、Gemini CLI | CLI | 安裝對應 CLI |
| DeepSeek、Kimi(Moonshot)、Grok(xAI)、OpenRouter | API | 設定 API key 環境變數 |
| Ollama | API | 本機執行 Ollama |
| 空白 CLI、空白 API、Aider JS 外掛 | 自訂 | 自己填 |

- API 類型的成員只能討論與審查,不能修改檔案。
- 設定有錯時,設定頁與編輯器會直接顯示原因。
- CLI 範本依官方文件撰寫,尚未全部實測。

完整欄位與寫法見 [docs/adapters.md](docs/adapters.md)。

## 模型清單

模型清單邏輯在 `src/models.js`,別名與強度規則在 `src/model-rules.js`(主程序與介面共用)。

- Claude Code:`~/.claude/cache/model-catalog/*.json`,取 `section` 為 `main` 的模型;多個檔案時由新到舊找第一個有效的。
- Codex:`~/.codex/models_cache.json`,排除 `visibility` 非 `list` 與有 `upgrade`(已退役)的模型。
- Cursor CLI:執行 `cursor-agent --list-models`,每 10 分鐘更新一次。Cursor 的強度寫在模型名稱裡(例如 `claude-opus-5-thinking-high`),所以不另外選強度。
- 讀取結果依檔案修改時間快取,檔案沒變不重讀;每次打開成員編輯視窗都會重抓,CLI 更新快取後不用重開 app。
- 讀不到快取時使用內建清單,編輯視窗會標示。

執行 `npm test` 可跑模型清單與擴充系統的測試。

## 記憶方式

Claude 以 `--resume <session_id>`、Codex 以 `codex exec resume <thread_id>`、Cursor 以 `--resume <chatId>` 續接,所以後續回合只送「新訊息」,省 token。自訂指令沒有 session,每次都會送完整對話紀錄。

## ⚠️ 安全提醒

擴充會以你的帳號權限執行指令,JS 外掛擁有完整的 Node.js 權限,只安裝你信任的擴充。

「允許修改檔案與執行指令」開啟時,Claude Code 會以 `--dangerously-skip-permissions` 執行,Codex 會以 `workspace-write` 沙箱且不詢問確認執行,Cursor CLI 會以 `--force` 自動核准指令。AI 可以在工作目錄內建立、修改、刪除檔案並執行指令。

- 工作目錄請使用獨立資料夾,不要指到重要專案或家目錄。
- 建議工作目錄使用 git,方便檢查與回溯 AI 做的變更。
- 只想看討論時,關閉該選項或使用「只討論,不執行」模式。

## 注意

- 兩個 CLI 都用你現有的登入與訂閱額度,多回合討論會消耗較快。建議討論用較便宜的模型與較低強度,執行階段再用高強度。
- 平行執行時多人改同一個檔案仍可能衝突;分工提示已要求主持人避免重疊,但複雜任務建議工作目錄使用 git 以便回溯。
- 設定檔位於 `~/Library/Application Support/AI Roundtable/config.json`。

## 貢獻

歡迎開 issue 或送 pull request。修改模型清單邏輯後請跑 `npm test`。

## 授權

[MIT](LICENSE)
