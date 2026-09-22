**繁體中文** | [English](README.en.md)

# AI Roundtable

讓多個 AI CLI(Claude Code、Codex CLI、Cursor
CLI,或任何自訂指令)在同一張圓桌上討論、分工、執行、互相審查的 macOS 桌面應用。

> A desktop app that seats multiple AI coding CLIs and APIs (Claude Code, Codex
> CLI, Cursor CLI, Grok, Kimi, DeepSeek, Gemini, Ollama, or anything you plug
> in) at one table: they debate a task, split the work, execute in parallel, and
> review each other's output. You watch the whole conversation live and can jump
> in at any time.

![AI Roundtable 畫面](docs/screenshot.png)

## 特色

- **多個 AI 同桌**:內建 Claude Code、Codex CLI、Cursor
  CLI;Grok、Kimi、DeepSeek、Gemini、OpenRouter、Ollama 等可從範本一鍵加入。
- **可擴充**:用 JSON 描述任何 CLI 或 OpenAI 相容 API,也能寫 JS 外掛,在 app
  內直接編輯與重新載入。
- **每位成員各自設定**:角色個性、模型、推理強度、是否允許改檔案。
- **陣容**:把誰上場、各自的角色、主持人、流程與工作模式存起來,之後一鍵換回來。
- **工作模式**:「寫程式」會自動驗證改動、鎖住既有測試;「一般任務」(文件、分析、腦力激盪)不做這些。
- **測試先行流程**:先把驗收條件寫成測試,鎖起來,再實作到測試通過。
- **專案規則**:工作目錄的 `CLAUDE.md`、`AGENTS.md`
  會自動放進每位成員的系統提示。
- **停損**:成員卡住或改壞時,一鍵把工作目錄還原到任務開始前。
- **討論 → 分工 → 平行執行 → 交叉審查 →
  總結**,全程即時串流顯示,包含工具呼叫與思考過程。
- **隨時插話**:進行中送出的訊息會在下一位成員發言時帶入。
- **@ 指定成員**:輸入 `@名稱`
  只讓指定的成員回覆或動手,不跑整套討論流程;同時指定多位時平行處理。
- **附件**:拖放或點 📎 附加圖片、文字檔或
  PDF,依各成員的能力給檔案路徑或內嵌內容。
- **環境問題一鍵修好**:CLI 沒裝、沒登入、本機模型沒啟動、這台 Mac 的 git
  不能用……全部在同一個地方照實說發生什麼事,並附上一顆「在終端執行」把修復指令填進內建終端(填好但不自動執行,你按
  Enter
  才會跑);沒有單一指令可跑的就打開官方安裝說明。成員的模型設定裡也會先講清楚這個
  CLI / API
  現在能不能用,不必等送出任務才失敗;真的失敗時,那顆按鈕就接在對話裡的錯誤訊息下面。
- **內建終端**:⌘J
  或工具列的「終端」叫出右側面板,開在同一個工作目錄的真正終端機(可多分頁、可拉寬、跟著主題換色),自己
  `git diff`、`npm test` 不必切到別的 app。
- **歷史對話**:每次任務結束自動保存,可以預覽、匯出成
  Markdown,或按「繼續這段對話」接著討論。
- **平行發言並排**:執行、審查等平行階段的成員訊息每列並排三張。
- **用量統計**:跨 CLI 與 API 統一計算輸入、快取、輸出 token 與成本。
- **介面語言**:繁體中文與
  English,可跟隨系統;系統訊息、給成員的提示詞與匯出檔一併切換。
- **直接用你現有的 CLI 訂閱**,不需要另外申請 API key;API 類成員的 key
  用作業系統安全儲存加密保存。

## 需求

- macOS(其他平台尚未測試)
- Node.js 20.6.0 以上(開發與 CI 使用 Node.js 22)
- 至少一個 AI 來源:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
    、[Codex CLI](https://github.com/openai/codex) 或
    [Cursor CLI](https://cursor.com/cli)(`cursor-agent`),安裝並登入即可直接使用
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

輸出在 `release/AI Roundtable-<版本>-arm64.dmg`(Apple Silicon)與
`-x64.dmg`(Intel),也可以直接到
[Releases](https://github.com/yanmin841111-byte/ai-roundtable/releases)
下載。沒有 Apple 開發者憑證,app 只有 ad-hoc 簽章、未經公證,第一次開啟 macOS
會說「無法驗證開發者」:按「完成」後到「系統設定 →
隱私權與安全性」,在下方按「強制打開」再確認一次即可(macOS 14 以前也可以在 Finder
對 app 按右鍵 → 打開)。之後就能正常開啟。

## 流程

送出任務後,依「模式」不同:

- **討論 → 寫測試 → 實作 →
  交叉審查**:和下面的流程一樣,只是在分工之後多一步——每位成員先把自己那份工作的驗收條件寫成測試。那些測試在實作回合會被鎖住,不能修改,所以「讓測試通過」只能靠改實作。
- **討論 → 分工執行 → 交叉審查**
  1. 成員依序輪流發言,每人看得到之前所有人的話。某成員認為已有共識時會在回覆末尾寫
     `[AGREED]`;同一回合全員同意即進入分工,否則到達「最大討論回合」後強制進入。
  2. 主持人輸出 JSON 分工表,盡量讓每人負責不同檔案。
  3. 兩位以上可改檔的成員**平行**執行時,各自使用隔離目錄,結束後只合併沒有重疊的改動。重疊或無法安全合併的版本保留在訊息列出的目錄,成果標成未完成。無法準備隔離目錄時改在原目錄**依序**執行,並照實說明。
  4. **app 自己驗證**(只有「寫程式」模式):改動的 `.js`、`.json`
     檔用語法檢查確認載得起來;設了「驗證指令」(例如
     `npm test`)就在工作目錄執行。這一步不經過任何模型。任務開始前就存在的測試檔會被鎖住,修復回合不能改——要讓測試通過請改實作。
  5. 每位成員審查下一位成員的成果。審查用**乾淨的
     context**:只看任務要求、對方的回報、實際改動與驗證結果,看不到討論與執行過程,才不會被對方的說法帶著走。執行到一半失敗、但已經改了檔案的成員,也照樣送審。
  6. 審查提出問題、或自動驗證沒過時修復一次,然後重新驗證與複查。若提出問題的是未參與執行、可改檔的審查者,且另有第三位成員可獨立複查,就由審查者直接接手修復;否則維持原執行者修復、原審查者複查。寫測試與修復回合依序執行,仍有問題就帶進總結。
  7. 主持人總結。
- **只討論,不執行**:討論到共識或回合上限後由主持人總結。

隔離優先使用 Git worktree;非 Git 或工作目錄是倉庫子目錄時使用有限副本(單檔 256 KB、總共 20 MB)。無法完整複製就依序執行,不靜默漏檔。相依套件與快取不複製,隔離目錄可能需要另行安裝依賴。這是工作目錄隔離,不是限制 CLI 權限的安全沙箱。

「寫程式」的分工或測試先行流程在總結前若仍有內建語法檢查失敗,或修復回合讓原本通過的任一道驗證關卡變成失敗,會嘗試自動回退:執行階段沒有語法錯誤時只撤回修復,否則回到任務前。執行階段驗證指令就已經失敗、修復沒有讓它變得更差時,不自動回退。只做了語法檢查、沒有專案驗證指令時,結果卡標成「僅語法檢查通過」,不是可合併。結果卡顯示回退後的驗證狀態,撤回成果仍算未完成。回退依賴記憶體中的有限快照(單檔
256 KB、總共 20
MB),不是完整備份;缺基準點、還原不完整或工作目錄身分改變時會明示,目錄不可信時也不再執行回退後驗證。

訊息裡用 `@名稱`
指定成員時,只有被指定的成員會回覆(多位時平行執行);進行中指定的話,對方會在下一次發言時看到,任務結束前還沒輪到就補一次回覆。

進行中隨時可以送出訊息,會在下一位成員發言時帶入;「停止」會中止所有 CLI
程序。「新對話」會清空對話與各成員的 session 記憶。

## 成員設定

點左側成員卡片可編輯:

| 欄位         | 說明                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| AI CLI       | 內建的 Claude Code、Codex CLI、Cursor CLI、自訂指令,或你加入的擴充                                                                        |
| 模型 / 版本  | 自動讀取各 CLI 的本機模型快取,只列正式、未退役的模型;選「其他(手動輸入)」可填任意模型名稱                                                 |
| 強度         | 選項依模型而定;模型不支援時會自動降到最接近的等級,或略過不送,並在對話中標示                                                               |
| 角色與個性   | 會放進系統提示,決定成員的立場與說話方式                                                                                                   |
| 允許修改檔案 | 開啟時 Claude 用 `--dangerously-skip-permissions`、Codex 用 `workspace-write`、Cursor 用 `--force`;關閉時只能讀取(Cursor 用 `--mode ask`) |
| 自訂指令     | 提示詞從 stdin 送入、stdout 當作回覆,可用 `{model}`、`{effort}` 佔位,例如 `gemini -m {model} -p -`                                        |

主持人在「設定」區選擇,負責分工與總結。

**專案規則**:工作目錄裡的
`CLAUDE.md`、`AGENTS.md`(依序找第一個)會自動放進每位成員的系統提示,不必每次重講一遍專案慣例。太長會截斷,並在對話裡說明。

**陣容**:側欄「成員」旁的「陣容」可以把目前的組合存起來——哪些成員上場、各自的角色與個性、主持人、流程與討論回合數。之後點一下就換回來:陣容裡的成員啟用並換上當時的角色,其他成員暫停。陣容只記得是哪幾位成員,不會動到他們的
CLI、模型或金鑰。套用後又改過設定時,按鈕會標出「已修改」,可以更新陣容或另存新的。

## 擴充其他 CLI 與 API

左下角「⚙ 設定」→「CLI 與擴充」按「+ 新增」,從範本加入其他 AI:

| 範本                                            | 類型 | 需要                                                                |
| ----------------------------------------------- | ---- | ------------------------------------------------------------------- |
| Grok CLI、Kimi Code CLI、Gemini CLI             | CLI  | 安裝對應 CLI                                                        |
| DeepSeek、Kimi(Moonshot)、Grok(xAI)、OpenRouter | API  | API key(在擴充編輯器填入,或設定環境變數)                            |
| Ollama                                          | API  | 本機執行 Ollama；Qwen3.8 MLX 可先執行 `ollama pull qwen3.8:27b-mlx` |
| 空白 CLI、空白 API、Aider JS 外掛               | 自訂 | 自己填                                                              |

- Ollama 的 `qwen3.8:27b-mlx`（約 18GB，建議至少 32GB
  記憶體）可透過內建範本參與討論、圖片理解、審查及受限改檔；請先執行
  `ollama serve`。範本預設關閉
  thinking。改檔必須同時符合：範本啟用工具、成員允許改檔、divide
  流程有另一位合格 reviewer。工具只有讀檔、精確文字替換與小檔寫入，含路徑隔離與
  SHA-256
  衝突保護；操作會寫入稽核紀錄供另一位成員審查。若審查沒有成功完成，介面會明確標示「尚未審查」，請使用紅綠
  diff 自行確認。
- 設定有錯時,設定頁與編輯器會直接顯示原因。
- CLI 範本依官方文件撰寫,尚未全部實測。

完整欄位與寫法見 [docs/adapters.md](docs/adapters.md)。

## 模型清單

模型清單邏輯在 `src/models.ts`,別名與強度規則在
`src/model-rules.ts`(主程序與介面共用)。

- Claude Code:`~/.claude/cache/model-catalog/*.json`,取 `section` 為 `main`
  的模型;多個檔案時由新到舊找第一個有效的。
- Codex:`~/.codex/models_cache.json`,排除 `visibility` 非 `list` 與有
  `upgrade`(已退役)的模型。
- Cursor CLI:執行 `cursor-agent --list-models`,每 10 分鐘更新一次。Cursor
  的強度寫在模型名稱裡(例如 `claude-opus-5-thinking-high`),所以不另外選強度。
- 讀取結果依檔案修改時間快取,檔案沒變不重讀;每次打開成員編輯視窗都會重抓,CLI
  更新快取後不用重開 app。
- 讀不到快取時使用內建清單,編輯視窗會標示。

## 附件

在輸入框拖放檔案或點 📎,支援 png / jpg / webp / gif / txt / md / json / csv /
log / pdf。預設一次最多 10 個檔案、單檔 20 MB、合計 50
MB,驗證在主程序進行(副檔名與檔案內容都會檢查)。

附件存在 app 的資料夾,不會寫進工作目錄。依成員能力決定怎麼給:

- 本機 CLI:給檔案路徑,由 CLI 自己讀。讀取範圍受限的 CLI(Claude Code、Gemini
  CLI)會在工作目錄的 `.roundtable-runtime/` 放一份暫存副本,任務結束、停止或關閉
  app 時刪除。
- API:文字檔直接內嵌;宣告支援圖片的端點會附上圖片,被拒收時自動改用純文字重送。PDF
  只提供給能讀檔的 CLI,API 成員會被告知無法讀取。

## 記憶方式

Claude 以 `--resume <session_id>`、Codex 以
`codex exec resume <thread_id>`、Cursor 以 `--resume <chatId>`
續接,所以後續回合只送「新訊息」,省 token。OpenAI 相容 API 在 app
記憶體中保留對話歷史。自訂指令沒有
session,每次都會送完整對話紀錄,長度受「對話紀錄上限」限制。

CLI 的 session
不會寫進歷史紀錄。載入歷史對話繼續討論時,每位成員第一次發言會收到依上限截斷的完整紀錄(原始任務一定保留),之後才恢復只送新訊息。

## ⚠️ 安全提醒

擴充會以你的帳號權限執行指令,JS 外掛擁有完整的 Node.js 權限,只安裝你信任的擴充。

「允許修改檔案與執行指令」開啟時,Claude Code 會以
`--dangerously-skip-permissions` 執行,Codex 會以 `workspace-write`
沙箱且不詢問確認執行,Cursor CLI 會以 `--force` 自動核准指令。AI
可以在工作目錄內建立、修改、刪除檔案並執行指令。

- 工作目錄請使用獨立資料夾,不要指到重要專案或家目錄。
- API key 在擴充編輯器填入時,以作業系統安全儲存(macOS 鑰匙圈)加密後存在
  `secrets.json`,不會寫進擴充 JSON。舊版寫在擴充檔的明文 `apiKey`
  會在載入時自動搬移。
- 建議工作目錄使用 git,方便檢查與回溯 AI 做的變更。
- 只想看討論時,關閉該選項或使用「只討論,不執行」模式。

## 注意

- 各 CLI
  都用你現有的登入與訂閱額度,多回合討論會消耗較快。建議討論用較便宜的模型與較低強度,執行階段再用高強度;只需要某位成員處理時用
  `@名稱`,不必跑完整流程。
- 平行執行時多人改同一個檔案仍可能衝突;分工提示已要求主持人避免重疊,但複雜任務建議工作目錄使用
  git 以便回溯。

## 資料位置

都在 `~/Library/Application Support/AI Roundtable/`;`sessions/` 與 `adapters/`
可以從「設定 → 資料與紀錄」直接打開:

| 路徑           | 內容                        |
| -------------- | --------------------------- |
| `config.json`  | 成員與設定                  |
| `sessions/`    | 歷史對話(每段對話一個 JSON) |
| `attachments/` | 附件,刪除歷史對話時一併清掉 |
| `adapters/`    | 擴充設定檔                  |
| `secrets.json` | 加密後的 API key            |

## 專案結構

| 路徑                                                         | 說明                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `main.ts`、`preload.ts`                                      | Electron 主程序與 IPC 介面                                                                                  |
| `src/ipc-types.ts`、`renderer/api.d.ts`                      | 主程序與介面共用的 IPC 型別                                                                                 |
| `renderer/`                                                  | 介面(HTML / CSS / TypeScript,由 esbuild 打包);`app.ts` 是主程式,`diff-view.ts`、`task-card.ts` 是獨立的元件 |
| `src/orchestrator.ts`                                        | 討論、分工、執行、審查、@ 指定的流程                                                                        |
| `src/flow/`                                                  | 流程用到的獨立部分:審查配對與結論、對話紀錄截斷、git 變更、分工解析、訊息還原、結果卡                       |
| `src/snapshot.ts`、`src/task-changes.ts`                     | 工作目錄快照,與「這次任務改了什麼」的比對                                                                   |
| `src/adapters/`                                              | 內建轉接器、擴充載入、CLI / API 通用轉接器                                                                  |
| `src/attachments.ts`、`src/session-log.ts`、`src/secrets.ts` | 附件、歷史紀錄、API key 儲存                                                                                |
| `src/terminal.ts`、`src/pty.exp`、`renderer/terminal.ts`     | 終端分頁:pty(借 macOS 內建的 expect,不需要原生模組)與右側面板                                               |
| `src/git-check.ts`、`renderer/env-fix.ts`                    | 環境問題:偵測這台機器的 git 能不能用,以及「照實說一句話 + 一個可照做的下一步」的統一卡片                    |
| `src/models.ts`、`src/model-rules.ts`、`src/usage.ts`        | 模型清單、強度規則、用量正規化                                                                              |
| `adapters/templates/`                                        | 「+ 新增」裡的擴充範本                                                                                      |
| `docs/`                                                      | 擴充撰寫說明與介面文案規格                                                                                  |
| `test/`                                                      | `npm test` 執行的測試;`test/e2e/` 是端對端測試                                                              |
| `test/harness/`                                              | 隔離的真實 Electron 驗證與截圖,情境及用法見 [harness 說明](test/harness/README.md)                          |
| `eval/`                                                      | 審查品質評測,以及「單人 vs 圓桌」對照實驗;都用真的模型跑固定題目,長時間的實驗可以用流水帳續跑               |
| `dist/`                                                      | `npm run build` 的輸出,app 實際載入的是這裡(不進版控)                                                       |

## 貢獻

歡迎開 issue 或送 pull request,流程與注意事項見
[CONTRIBUTING.md](CONTRIBUTING.md)。發現安全問題請依 [SECURITY.md](SECURITY.md)
私下回報。變更紀錄見 [CHANGELOG.md](CHANGELOG.md)。

## 授權

[PolyForm Noncommercial 1.0.0](LICENSE):個人、研究、教育與非營利組織可以免費使用、修改與分發,**不得用於商業用途**。需要商業授權請[聯絡作者](https://github.com/yanmin841111-byte)。

原始碼公開,但因為限制商業使用,不屬於 OSI
定義的「開源」授權。在改用這份授權之前公開的版本(包括 v0.1.0)是以 MIT
授權釋出,依那些版本取得的程式碼仍適用 MIT。
