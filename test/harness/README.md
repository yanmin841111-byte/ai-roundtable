# 測試 harness

啟動**真正的 app**,在裡面跑一段劇本,回傳結果與截圖。

## 為什麼需要它

這個產品最容易出錯、也最難發現的那類問題,只有整疊跑起來才看得到:

- 成員有沒有真的改到檔案,稽核有沒有真的進 transcript
- 燈號說的是不是真話(綠燈是不是真的能用)
- 設定壞掉時,畫面到底跟使用者說了什麼

單元測試看不到這些(它們在 IPC 與 renderer 之上),手動點又重現不了。

## 安全前提

`userData` 與 `workDir` 一律是拋棄式暫存目錄。**不碰使用者真正的設定,也不碰這個
repo。** 要用真實模型時只複製 adapter
設定(`adapters: ['installed:ollama-api']`),不複製 config。

## 用法

```ts
import { report, runApp } from "../app";
import { ollamaMember, ONE_LINE_EDIT, scriptedMember } from "../fixtures";

const r = await runApp({
  members: [
    scriptedMember({
      id: "lead",
      name: "主持人",
      plan: { summary: "…", assignments: [{ agent: "A2", task: "…" }] },
    }),
    ollamaMember({ id: "qwen" }),
  ],
  adapters: ["installed:ollama-api"],
  files: { "src/net.js": "…" },
  git: true,
  constants: { target: "src/net.js" }, // 劇本裡用 H.target 取用
  scenario: async (H) => {
    const g = globalThis as any;
    await g.ready();
    const msgs = await g.send("請修正錯誤訊息", "divide");
    g.check(g.toolAudits(msgs).length > 0, "有工具稽核紀錄");
    await g.shot("after");
    return { ok: true };
  },
});

report("我的情境", r);
console.log(r.read("src/net.js")); // 不經過 app 的獨立驗證
console.log(r.numstat()); // git 的說法
```

## 劇本裡可以用的東西

劇本是**序列化後送進 renderer 執行**的,所以**不能閉包外部變數**——要傳值請用
`constants`,劇本裡以 `H` 取用。 以下工具由 harness 注入(用 `globalThis`
取用,TypeScript 才看得到):

| 名稱                        | 用途                                                      |
| --------------------------- | --------------------------------------------------------- |
| `ready()`                   | 等介面初始化完成(IPC 回來、事件綁好)                      |
| `send(msg, mode)`           | 送出訊息並等整場跑完,回傳這次新增的訊息                   |
| `waitIdle(ms)`              | 等 app 閒置                                               |
| `waitFor(fn, ms, what)`     | 等某個條件成立。畫面很多東西是非同步填的,不要用固定 sleep |
| `check(cond, msg)`          | 斷言。通過的會列進 `result.steps`                         |
| `shot(name)`                | 拍一張截圖                                                |
| `toolAudits(msgs)`          | 從訊息抽出工具稽核紀錄                                    |
| `$(sel)` / `text(sel)`      | DOM 捷徑                                                  |
| `snapshot()` / `window.api` | 直接用 IPC                                                |

## 現成情境

```bash
npm run harness:ui      # 全假成員,通常數分鐘,結果固定,CI 也會跑。包含以下情境:
                        #   content-safety     使用者與 AI 的 Markdown 清理、新視窗與同視窗導覽阻擋
                        #   ui-states          設定壞掉時燈號與徽章有沒有說實話
                        #   i18n-en            英文介面下,主程序產生的錯誤是不是英文
                        #   waiting            長回合時有沒有顯示階段、經過時間與停滯警示
                        #   retry              失敗的 @ 指定回覆能重試;分工流程裡失敗的回合不行
                        #   review-visibility  審查訊息顯示結論徽章與「看了哪些檔案」,點檔名跳到檔案改動(中英各一次)
                        #   plan-output        分工原文收起來;多 AI 把關的計畫阻擋、修正通過、三輪未通過、審查重試成功與耗盡上限(中英文)
                        #   model-capability   API 成員的模型能力顯示在卡片與編輯視窗;按「測試」才送請求(假端點,中英各一次)
                        #   diff-without-git   工作目錄不是 git repo 時,檔案改動照樣列出紅綠對照(中英各一次)
                        #   task-summary       分工任務結束時的結果卡:每位成員的結論、改動的檔案、點檔名跳到檔案改動(中英各一次)
                        #   lineups            側欄陣容保存、切換、刪除;快速組隊預覽、角色交換、前置阻擋與儲存失敗(中英文)
                        #   terminal           內建終端面板:分頁是真的 pty,輸出與尺寸都對得上
                        #   env-fix            環境問題(CLI 沒裝、沒登入、本機模型沒跑)呈現成同一套可照做的下一步
                        #   verify             語法檢查不執行檔案;壞成果自動回退,結果卡不誤報完成
                        #   settings-save      設定寫入成功與失敗,介面都照實回報
                        #   cli-install        沒安裝的內建 CLI 從設定頁與成員設定都能打開安裝視窗(不實際安裝)
                        #   repair-broke       壞修復自動撤回,保留執行階段成果與使用者原有改動
                        #   report-integrity   回報、稽核、磁碟與評測證據一致,回退不掩蓋失敗過程
npm run harness:reports # 單獨跑證據保存回歸,不使用真實模型
npm run harness:live    # 真的本機模型改檔案。需要 ollama serve 正在跑
npm run harness:login   # CLI 裝了但沒登入時的提示。需要機器上有 claude 與 codex,沒有就跳過
```

快速組隊可在 build 後單獨跑 `node --import tsx test/harness/scenarios/lineups.ts --quick-only`。
使用假成員及隔離設定,檢查套用不啟動任務、不提升權限、保留舊陣容,以及窄側欄沒有水平溢出。

審查重試可在 build 後單獨跑 `node --import tsx test/harness/scenarios/plan-output.ts --retry-only`。
四個中英文隔離情境使用固定失敗的假成員,驗證單次重試、原失敗紀錄保留、修復恢復與重試耗盡時仍阻擋;不消耗模型額度。

審查格式與反例判定可在 build 後跑 `node --import tsx test/harness/scenarios/plan-output.ts --evidence-only`。
六個中英文情境驗證格式澄清不消耗修復輪數,以及反例一致撤回或有反對票時的結果卡、原始失敗輸出與入庫狀態。
格式澄清與失敗重試共用每次審查最多一次的額外回合;不放寬標記解析,也不自動把否定票改為通過。
新反例只有在提出者及至少另一位非被審作者都引用原始需求並明確同意撤回時,才移出修復門檻。
這仍是模型判斷,不是正確性的證明。缺票、格式不完整、反對、停止或呼叫失敗都不撤回;兩人團隊及既有反例庫不自動撤回。

計畫續訂可在 build 後單獨跑 `node --import tsx test/harness/scenarios/plan-output.ts --continue-only`。
中英文各一次實際點擊結果卡按鈕,驗證草稿續訂不重跑討論、重新審核後才改檔,並保留原本的阻擋結果。

經使用者同意後,`COPILOT_LIVE=1 caffeinate -i node --import tsx test/harness/scenarios/copilot-complex.ts --continue-plan`
會執行複雜排程器的真實 Copilot 任務;只有計畫被阻擋時才點一次續訂,不無限重跑。
先用 `--dry-run` 檢查題目而不消耗額度。原始訊息、失敗歷史、公開與隱藏測試結果保存在隔離目錄,
成功重試的審查錯誤仍保留,但驗收只把未解決的錯誤當成阻擋。

2026-09-28 的新版複雜任務隱藏驗收由 17 項增至 22 項,加入非普通資源物件及 `__proto__`、`constructor`、`toString` 資源名稱的容量與 CLI 檢查。
這些追加檢查已在舊產物重現漏網缺陷,但不改寫舊批次分數。新版本必須使用新的證據目錄,不能接續舊的 30 場批次。

30 場重複驗證在 build 後先跑 `node --import tsx test/harness/scenarios/copilot-batch.ts --dry-run`。
取得額度授權後執行 `COPILOT_LIVE=1 caffeinate -i node --import tsx test/harness/scenarios/copilot-batch.ts --output .eval-local/copilot-30-2026-09-27`。
固定交錯執行兩人修正、三人修正與複雜排程器各 10 場;每場皆為新隔離目錄,最多 30 分鐘。
`manifest.json` 預先記錄清單、模型與程式雜湊,`summary.json` 逐場更新,完整證據與產物保存在各場目錄。
只有 30/30 同版本通過才會標記 `readyToPush`;批次程式本身不提交或推送。
中斷後可加 `--resume` 接續同一輸出目錄,但中斷場次記失敗、不重抽;程式或建置變更時拒絕接續。
這是兩個固定任務的重複功能驗證,不代表所有程式任務的普遍成功率。

### 換機測試交接

2026-09-29 的完整批次為 17/30 通過;同版本重跑在使用者要求下停止,已完成 5 場中 4 場通過、1 場失敗,第 6 場人工中斷。
這次提交供換機測試,不代表達成 30/30 驗收。原始證據在本機 `.eval-local/`,不隨 Git 推送;不覆寫或合併不同批次的成績。
已知未修問題:外層逾時可能留下獨立 CLI 程序;反例判定格式錯誤沒有再次澄清;重複認證連線失敗仍跑完討論輪數;部分逾時缺少途中訊息且逾時分類不一致。

另一台電腦需有桌面環境、Node.js >= 20.6.0、已登入的 GitHub Copilot CLI,以及這三個模型的使用權限。
在 repo 根目錄執行以下命令(POSIX shell),最後一行會使用真實模型額度:

```sh
git pull --ff-only
npm install
npm run typecheck
npm test
npm run build
node -e 'require("node:fs").mkdirSync(".eval-local", { recursive: true })'
node --import tsx test/harness/scenarios/copilot-batch.ts --dry-run
COPILOT_LIVE=1 node --import tsx test/harness/scenarios/copilot-batch.ts --output .eval-local/copilot-30-new-machine
```

輸出目錄必須不存在;換機後開新批次,不要用 `--resume` 接續舊機的批次。macOS 可在 `node` 前加 `caffeinate -i` 避免閒置睡眠。
CLI 版本檢查或公開 GitHub API 可達不等於模型認證成功。中止時需確認該次測試的 Electron 與獨立 CLI 程序均已停止,不可只關閉終端就假定清理完成。

### 證據保存回歸

`npm run harness:reports` 單獨驗證 A/B 評測的證據保存(也包含在 `harness:ui` /
CI): 使用真正 Electron 與隔離目錄,但模型由本機固定回應端點代替,不花模型額度。
直接走 `eval/ab.ts` 的 `runOnce`,驗全對與修復後語法失敗、自動回退兩種情況:
磁碟、git
增刪與保留下來的執行階段稽核雜湊一致;壞修復的稽核與回報也保留,回退不掩蓋未完成的需求。
超過 1,500 字的回報、修復回合、驗證與結果卡完整保存;
清理原工作目錄後證據仍在,且流水帳 `evidenceId` 能接上離線標註計分。 另外檢查 1.6
MB 的 UTF-8 劇本結果在 app 退出前完整傳回,以及劇本真正失敗時保留錯誤與退出代碼。
只驗結果傳輸可用
`npm run build && node --import tsx test/harness/scenarios/report-integrity.ts --transport-only`。
這是保存流程的回歸測試,固定樣本的分數不是模型品質或產品成效的實驗結果。

### 真實模型評測

審查品質的評測在
[`eval/`](../../eval/README.md):真的模型當審查者,跑一組固定題目,輸出分數。
它用的就是這個
harness。**模型輸出每次不同,單次結果只是一個樣本**,要比較兩種設定時請各跑多次。

要看某個改動有沒有讓模型表現變好,用同一題在改動前後各跑一次:用
`git worktree add` 開一份舊版, 只把 `test/harness/`
的檔案複製進去(產品程式碼維持舊版),分別建置後依序執行。 兩邊共用本機
Ollama,**不要同時跑**,否則會互相拖慢、影響比較。

## 踩過的坑

- **驗證不能因為回退而失真**。確認語法檢查沒有執行檔案時,把執行痕跡放在 harness
  的隔離 `tmp` 裡、`workDir` 外;否則回退會把痕跡刪掉,造成假通過。
- **劇本函式會被 esbuild 加上 `__name(...)`**。harness 的 prelude 補了一個等價的
  no-op,不必自己處理。
- **大型結果不能 `console.log` 後立刻退出**。stdout 是非同步管線;真機重現過 1.6
  MB 只收到 24 KB, app exit 0 卻被判成沒有結果。主程序現在等寫入 callback
  才退出,harness 以 UTF-8 串流解碼避免中文字跨區塊損壞。
- **adapter 檔名必須以英數字開頭**(`registry.ts` 的
  `FILE_PATTERN`)。`.tmp-x.json` 會被靜靜濾掉。
- **非同步渲染**:健康檢查、雲端 key 驗證都是後來才填上去的。用 `waitFor`
  等**你要驗的那個狀態**,不要等「有沒有東西」——一開始就存在的元素會讓你假通過。
- **不要等「某段字消失」**。第一次渲染前那裡是空字串,「不含『檢查中』」會立刻成立。要等完成態本身出現(例如「3/4
  個 CLI 可用」)。這個錯誤會讓測試靠時序運氣通過,換台機器就壞。
- **斷言要讀對元素**。讀整張卡的文字會被 persona 之類的內容誤中;要驗徽章就讀
  `.badge`。
- **截圖**在 `report()` 時複製到
  `$TMPDIR/ai-roundtable-shots/<情境名>/`,暫存目錄清掉也還在。
- **截圖前等動畫跑完**。設定視窗有淡入動畫,打開後立刻拍會拍到半透明的中間畫面;切換分頁後也要等一下。`shot()`
  本身會等 1.5 秒讓主程序拍完,但它不知道畫面還在動。
- **訊息元素用 `[data-msg-id="…"]`
  定位**。不要靠文字內容找泡泡,同一位成員常有好幾則。
- **要讓成員「第一次失敗、第二次成功」**,用自訂指令配合工作目錄裡的標記檔(見
  `retry.ts`);順便 `cat >> .prompts` 把每次收到的提示詞記下來,就能在 app
  之外獨立驗證成員看到了什麼。
- **要驗會等很久的東西(例如停滯 60
  秒),不要真的等**。把狀態撥到過去(`el.dataset.progressAt = 70 秒前`),再看計時器下一跳有沒有畫出來——走的仍是真實的渲染路徑。
