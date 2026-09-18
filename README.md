**繁體中文** | [English](README.en.md)

# AI Roundtable

讓多個 AI CLI(Claude Code、Codex CLI、Cursor CLI,或任何自訂指令)在同一張圓桌上討論、分工、執行、互相審查的 macOS 桌面應用。

> A desktop app that seats multiple AI coding CLIs and APIs (Claude Code, Codex CLI, Cursor CLI, Grok, Kimi, DeepSeek, Gemini, Ollama, or anything you plug in) at one table: they debate a task, split the work, execute in parallel, and review each other's output. You watch the whole conversation live and can jump in at any time.

![AI Roundtable 畫面](docs/screenshot.png)

## 特色

- **多個 AI 同桌**:內建 Claude Code、Codex CLI、Cursor CLI;Grok、Kimi、DeepSeek、Gemini、OpenRouter、Ollama 等可從範本一鍵加入。
- **可擴充**:用 JSON 描述任何 CLI 或 OpenAI 相容 API,也能寫 JS 外掛,在 app 內直接編輯與重新載入。
- **每位成員各自設定**:角色個性、模型、推理強度、是否允許改檔案。
- **陣容**:把誰上場、各自的角色、主持人與流程存起來,之後一鍵換回來。
- **討論 → 分工 → 平行執行 → 交叉審查 → 總結**,全程即時串流顯示,包含工具呼叫與思考過程。
- **隨時插話**:進行中送出的訊息會在下一位成員發言時帶入。
- **@ 指定成員**:輸入 `@名稱` 只讓指定的成員回覆或動手,不跑整套討論流程;同時指定多位時平行處理。
- **附件**:拖放或點 📎 附加圖片、文字檔或 PDF,依各成員的能力給檔案路徑或內嵌內容。
- **歷史對話**:每次任務結束自動保存,可以預覽、匯出成 Markdown,或按「繼續這段對話」接著討論。
- **平行發言並排**:執行、審查等平行階段的成員訊息每列並排三張。
- **用量統計**:跨 CLI 與 API 統一計算輸入、快取、輸出 token 與成本。
- **介面語言**:繁體中文與 English,可跟隨系統;系統訊息、給成員的提示詞與匯出檔一併切換。
- **直接用你現有的 CLI 訂閱**,不需要另外申請 API key;API 類成員的 key 用作業系統安全儲存加密保存。

## 需求

- macOS(其他平台尚未測試)
- Node.js 20 以上
- 至少一個 AI 來源:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 、[Codex CLI](https://github.com/openai/codex) 或 [Cursor CLI](https://cursor.com/cli)(`cursor-agent`),安裝並登入即可直接使用
  - 或其他 CLI / API,透過擴充接入

## 快速開始

```bash
git clone https://github.com/yanmin841111-byte/ai-roundtable.git
cd ai-roundtable
npm install
npm start
```

左下角會顯示偵測到的 CLI 與版本。找不到時請確認指令在登入 shell 的 `PATH` 裡。

打包成 .dmg:

```bash
npm run dist
```

輸出在 `release/AI Roundtable-<版本>-arm64.dmg`(Apple Silicon)與 `-x64.dmg`(Intel),也可以直接到 [Releases](https://github.com/yanmin841111-byte/ai-roundtable/releases) 下載。沒有 Apple 開發者憑證,app 只有 ad-hoc 簽章、未經公證,第一次開啟 macOS 會說「無法驗證開發者」:按「完成」後到「系統設定 → 隱私權與安全性」,在下方按「強制打開」再確認一次即可(macOS 14 以前也可以在 Finder 對 app 按右鍵 → 打開)。之後就能正常開啟。

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

**陣容**:側欄「成員」旁的「陣容」可以把目前的組合存起來——哪些成員上場、各自的角色與個性、主持人、流程與討論回合數。之後點一下就換回來:陣容裡的成員啟用並換上當時的角色,其他成員暫停。陣容只記得是哪幾位成員,不會動到他們的 CLI、模型或金鑰。套用後又改過設定時,按鈕會標出「已修改」,可以更新陣容或另存新的。

## 擴充其他 CLI 與 API

左下角「⚙ 設定」→「CLI 與擴充」按「+ 新增」,從範本加入其他 AI:

| 範本 | 類型 | 需要 |
| --- | --- | --- |
| Grok CLI、Kimi Code CLI、Gemini CLI | CLI | 安裝對應 CLI |
| DeepSeek、Kimi(Moonshot)、Grok(xAI)、OpenRouter | API | API key(在擴充編輯器填入,或設定環境變數) |
| Ollama | API | 本機執行 Ollama；Qwen3.8 MLX 可先執行 `ollama pull qwen3.8:27b-mlx` |
| 空白 CLI、空白 API、Aider JS 外掛 | 自訂 | 自己填 |

- Ollama 的 `qwen3.8:27b-mlx`（約 18GB，建議至少 32GB 記憶體）可透過內建範本參與討論、圖片理解、審查及受限改檔；請先執行 `ollama serve`。範本預設關閉 thinking。改檔必須同時符合：範本啟用工具、成員允許改檔、divide 流程有另一位合格 reviewer。工具只有讀檔、精確文字替換與小檔寫入，含路徑隔離與 SHA-256 衝突保護；操作會寫入稽核紀錄供另一位成員審查。若審查沒有成功完成，介面會明確標示「尚未審查」，請使用紅綠 diff 自行確認。
- 設定有錯時,設定頁與編輯器會直接顯示原因。
- CLI 範本依官方文件撰寫,尚未全部實測。

完整欄位與寫法見 [docs/adapters.md](docs/adapters.md)。

## 模型清單

模型清單邏輯在 `src/models.ts`,別名與強度規則在 `src/model-rules.ts`(主程序與介面共用)。

- Claude Code:`~/.claude/cache/model-catalog/*.json`,取 `section` 為 `main` 的模型;多個檔案時由新到舊找第一個有效的。
- Codex:`~/.codex/models_cache.json`,排除 `visibility` 非 `list` 與有 `upgrade`(已退役)的模型。
- Cursor CLI:執行 `cursor-agent --list-models`,每 10 分鐘更新一次。Cursor 的強度寫在模型名稱裡(例如 `claude-opus-5-thinking-high`),所以不另外選強度。
- 讀取結果依檔案修改時間快取,檔案沒變不重讀;每次打開成員編輯視窗都會重抓,CLI 更新快取後不用重開 app。
- 讀不到快取時使用內建清單,編輯視窗會標示。

## 附件

在輸入框拖放檔案或點 📎,支援 png / jpg / webp / gif / txt / md / json / csv / log / pdf。預設一次最多 10 個檔案、單檔 20 MB、合計 50 MB,驗證在主程序進行(副檔名與檔案內容都會檢查)。

附件存在 app 的資料夾,不會寫進工作目錄。依成員能力決定怎麼給:

- 本機 CLI:給檔案路徑,由 CLI 自己讀。讀取範圍受限的 CLI(Claude Code、Gemini CLI)會在工作目錄的 `.roundtable-runtime/` 放一份暫存副本,任務結束、停止或關閉 app 時刪除。
- API:文字檔直接內嵌;宣告支援圖片的端點會附上圖片,被拒收時自動改用純文字重送。PDF 只提供給能讀檔的 CLI,API 成員會被告知無法讀取。

## 記憶方式

Claude 以 `--resume <session_id>`、Codex 以 `codex exec resume <thread_id>`、Cursor 以 `--resume <chatId>` 續接,所以後續回合只送「新訊息」,省 token。OpenAI 相容 API 在 app 記憶體中保留對話歷史。自訂指令沒有 session,每次都會送完整對話紀錄,長度受「對話紀錄上限」限制。

CLI 的 session 不會寫進歷史紀錄。載入歷史對話繼續討論時,每位成員第一次發言會收到依上限截斷的完整紀錄(原始任務一定保留),之後才恢復只送新訊息。

## ⚠️ 安全提醒

擴充會以你的帳號權限執行指令,JS 外掛擁有完整的 Node.js 權限,只安裝你信任的擴充。

「允許修改檔案與執行指令」開啟時,Claude Code 會以 `--dangerously-skip-permissions` 執行,Codex 會以 `workspace-write` 沙箱且不詢問確認執行,Cursor CLI 會以 `--force` 自動核准指令。AI 可以在工作目錄內建立、修改、刪除檔案並執行指令。

- 工作目錄請使用獨立資料夾,不要指到重要專案或家目錄。
- API key 在擴充編輯器填入時,以作業系統安全儲存(macOS 鑰匙圈)加密後存在 `secrets.json`,不會寫進擴充 JSON。舊版寫在擴充檔的明文 `apiKey` 會在載入時自動搬移。
- 建議工作目錄使用 git,方便檢查與回溯 AI 做的變更。
- 只想看討論時,關閉該選項或使用「只討論,不執行」模式。

## 注意

- 各 CLI 都用你現有的登入與訂閱額度,多回合討論會消耗較快。建議討論用較便宜的模型與較低強度,執行階段再用高強度;只需要某位成員處理時用 `@名稱`,不必跑完整流程。
- 平行執行時多人改同一個檔案仍可能衝突;分工提示已要求主持人避免重疊,但複雜任務建議工作目錄使用 git 以便回溯。

## 資料位置

都在 `~/Library/Application Support/AI Roundtable/`;`sessions/` 與 `adapters/` 可以從「設定 → 資料與紀錄」直接打開:

| 路徑 | 內容 |
| --- | --- |
| `config.json` | 成員與設定 |
| `sessions/` | 歷史對話(每段對話一個 JSON) |
| `attachments/` | 附件,刪除歷史對話時一併清掉 |
| `adapters/` | 擴充設定檔 |
| `secrets.json` | 加密後的 API key |

## 專案結構

| 路徑 | 說明 |
| --- | --- |
| `main.ts`、`preload.ts` | Electron 主程序與 IPC 介面 |
| `src/ipc-types.ts`、`renderer/api.d.ts` | 主程序與介面共用的 IPC 型別 |
| `renderer/` | 介面(HTML / CSS / TypeScript,由 esbuild 打包);`app.ts` 是主程式,`diff-view.ts`、`task-card.ts` 是獨立的元件 |
| `src/orchestrator.ts` | 討論、分工、執行、審查、@ 指定的流程 |
| `src/flow/` | 流程用到的獨立部分:審查配對與結論、對話紀錄截斷、git 變更、分工解析、訊息還原、結果卡 |
| `src/snapshot.ts`、`src/task-changes.ts` | 工作目錄快照,與「這次任務改了什麼」的比對 |
| `src/adapters/` | 內建轉接器、擴充載入、CLI / API 通用轉接器 |
| `src/attachments.ts`、`src/session-log.ts`、`src/secrets.ts` | 附件、歷史紀錄、API key 儲存 |
| `src/models.ts`、`src/model-rules.ts`、`src/usage.ts` | 模型清單、強度規則、用量正規化 |
| `adapters/templates/` | 「+ 新增」裡的擴充範本 |
| `docs/` | 擴充撰寫說明與介面文案規格 |
| `test/` | `npm test` 執行的測試;`test/e2e/` 是端對端測試 |
| `dist/` | `npm run build` 的輸出,app 實際載入的是這裡(不進版控) |

## 貢獻

歡迎開 issue 或送 pull request,流程與注意事項見 [CONTRIBUTING.md](CONTRIBUTING.md)。發現安全問題請依 [SECURITY.md](SECURITY.md) 私下回報。變更紀錄見 [CHANGELOG.md](CHANGELOG.md)。

## 授權

[MIT](LICENSE)
