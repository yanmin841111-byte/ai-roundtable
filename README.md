# AI Roundtable

讓多個 AI CLI(Claude Code、Codex CLI,或任何自訂指令)在同一張圓桌上討論、分工、執行、互相審查的 macOS 桌面應用。

## 啟動

```bash
npm install
npm start
```

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

進行中隨時可以送出訊息,會在下一位成員發言時帶入;「停止」會中止所有 CLI 程序。「新對話」會清空對話與各成員的 session 記憶。

## 成員設定

點左側成員卡片可編輯:

| 欄位 | 說明 |
| --- | --- |
| AI CLI | `Claude Code`(`claude`)、`Codex CLI`(`codex`)或自訂指令 |
| 模型 / 版本 | Claude:`fable`、`opus`、`sonnet`、`haiku` 或完整名稱;Codex:`gpt-5.5` 等 |
| 強度 | Claude:low / medium / high / xhigh / max;Codex:minimal / low / medium / high / xhigh |
| 角色與個性 | 會放進系統提示,決定成員的立場與說話方式 |
| 允許修改檔案 | 開啟時 Claude 用 `--dangerously-skip-permissions`、Codex 用 `workspace-write`;關閉時只能讀取 |
| 自訂指令 | 提示詞從 stdin 送入、stdout 當作回覆,可用 `{model}`、`{effort}` 佔位,例如 `gemini -m {model} -p -` |

主持人在「設定」區選擇,負責分工與總結。

## 記憶方式

Claude 以 `--resume <session_id>`、Codex 以 `codex exec resume <thread_id>` 續接,所以後續回合只送「新訊息」,省 token。自訂指令沒有 session,每次都會送完整對話紀錄。

## 注意

- 兩個 CLI 都用你現有的登入與訂閱額度,多回合討論會消耗較快。建議討論用較便宜的模型與較低強度,執行階段再用高強度。
- 平行執行時多人改同一個檔案仍可能衝突;分工提示已要求主持人避免重疊,但複雜任務建議工作目錄使用 git 以便回溯。
- 設定檔位於 `~/Library/Application Support/AI Roundtable/config.json`。
