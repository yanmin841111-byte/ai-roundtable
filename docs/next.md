**繁體中文** | [English](next.en.md)

# 接下來要做的

已經決定要做、但還沒做的事。寫在這裡是為了換機器、隔一段時間回來時接得回去——
知道「為什麼要做」跟知道「要改哪幾個檔案」一樣重要,所以兩邊都寫。

做完一項就從這裡刪掉,並在 [CHANGELOG.md](../CHANGELOG.md) 留下紀錄。

## 換機器之後先確認環境還是好的

```bash
npm ci
npm run typecheck   # 型別
npm test            # 單元測試(目前 47 項)
npm run e2e         # 端對端(目前 47 項檢查)
npm run harness:ui  # 真的 Electron app 跑一遍介面情境,會留截圖
```

`npm run harness:ui` 是最慢但最重要的一道:單元測試在純 node 底下跑,看不到 app 裡
`process.execPath` 是 Electron 這件事。評測的實驗 5 第一次 48 跑就是被這一類差異作廢的。

---

## 1. 結果卡還沒顯示反例證據

**現況**:反例的結果(確認 / 不成立 / 跑不成、修復後有沒有變成通過)只出現在系統訊息與
棘輪訊息裡。那些訊息會進對話紀錄與文字匯出,所以不會消失,但**結果卡沒有帶**。

**為什麼要補**:結果卡是這個產品的證據面——驗證紀錄、檔案改動、待處理事項都在那裡,
而且人工驗收與 JSON 匯出也從那裡出去。反例是同一級的證據(app 自己執行、不經過模型),
卻只留在訊息流裡,等於在證據鏈上留了一個洞:使用者看結果卡看不到「這次有兩個反例被確認、
修復後一個通過一個還沒」。

**要改哪裡**:

| 檔案 | 做什麼 |
| --- | --- |
| [src/ipc-types.ts](../src/ipc-types.ts) | `TaskSummary` 加一個 `counterexamples?` 欄位,形狀比照 `TaskVerification`:標題、提出者、確認狀態、修復後狀態、輸出(有長度上限) |
| [src/orchestrator.ts](../src/orchestrator.ts) | `pushTaskSummary` 把 `counterexamples`(執行後)與 `fix.counterexamples`(修復後)帶進去 |
| [renderer/task-card.ts](../renderer/task-card.ts) | 和驗證紀錄同一區塊呈現;沿用既有的「證據先於結論」排版 |
| [renderer/i18n.ts](../renderer/i18n.ts) | 中英文文案 |
| [src/flow/task-summary.ts](../src/flow/task-summary.ts) | 文字匯出也要有 |
| [test/harness/scenarios/counterexample.ts](../test/harness/scenarios/counterexample.ts) | 既有情境加檢查:結果卡真的看得到那兩個反例 |

**注意**:舊的歷史紀錄沒有這個欄位,要照既有慣例明講「舊紀錄沒有這項證據」,
不要拿沒有資料當成沒有問題。

---

## 2. 實驗:先獨立作答,再公開互相攻擊(Sequential vs Independent-first)

**還沒開跑,而且要先取得使用者同意**(比照實驗 4 的規矩)。下面是預先登記的草稿,
開跑前要補上次數與確切的 commit,而且**不可以先看結果再回頭改這一段**。

### 背景

現在的討論階段是「依序輪流,每人看得到之前所有人的話」。那是錨定最大化的順序。
實驗 3 的事後觀察已經看到它的影子:圓桌沒有全對的 10 次裡,**8 次結果卡寫著「✓ 審查通過」**,
也就是審查者照著執行者的說法複誦。產品後來把交叉審查改成乾淨 context 就是為了切斷這條路,
但**討論階段沒有動過**。

文獻同向:同質 agent 擴張有強烈遞減報酬,而且強模型彼此錯得更像
([arXiv 2602.03794](https://arxiv.org/html/2602.03794v1));算力對齊後 multi-agent debate
普遍打不贏單 agent baseline([arXiv 2502.08788](https://arxiv.org/abs/2502.08788))。

### 假設

- **H1**:Independent-first 的測試通過率高於 Sequential。
- **H2**(比較有意思的那個):Independent-first 的**錯誤相關性**低於 Sequential。

### 條件

- **A(Sequential)**:現況。A 答 → B 看 A → C 看 A+B → …
- **B(Independent-first)**:每位成員各自在乾淨 context 下答一次,全部答完才公開,
  然後才進入互相挑錯與驗證。

### 指標

- 主指標:錯誤相關性。四位成員獨立答錯**不同**的東西 vs 答錯**同一個**東西。
  具體定義要在開跑前寫死——建議用「同一題上,任兩位成員的失敗測試集合的 Jaccard 相似度」,
  平均起來當一個數。這個指標才是直接回答「共享多少思考會讓集體錯誤同步化」的那一個。
- 次指標:測試通過率、全對率、時間、token。

### 已知的困難(要先解決,不然量到的不是這個)

1. 現在的 `eval/ab.ts` 只有「單人 vs 圓桌」兩種條件,要加第三種。
2. 錯誤相關性需要**每位成員各自的產出**,而現在的流程只留合併後的工作目錄。
   要嘛用隔離目錄(worktrees 已經有了)各自評分,要嘛改成每位成員答在不同檔案。
   這一條是最大的工程量,建議先做它。
3. 題目仍然是問題:七題「從零寫單檔函式」全部碰到天花板,改錯題(`forth-fix`、`poker-fix`)
   才有空間。錯誤相關性在改錯題上比較好定義(隱藏測試是固定的)。

### 要改哪裡

| 檔案 | 做什麼 |
| --- | --- |
| [src/orchestrator.ts](../src/orchestrator.ts) `discussPhase` | 加一個「獨立回合」模式:第一輪每位成員用 `freshContext`,不帶其他人的發言 |
| [src/ipc-types.ts](../src/ipc-types.ts) | 設定裡加討論模式,陣容也要記得 |
| [eval/ab.ts](../eval/ab.ts)、[eval/stats.ts](../eval/stats.ts) | 第三種條件與錯誤相關性的計算 |
| [eval/EXPERIMENTS.md](../eval/EXPERIMENTS.md) | 開跑前把上面這份草稿正式登記進去 |

---

## 3. README 還沒說出「圓桌比單人好」目前沒有證據

**現況**:[eval/EXPERIMENTS.md](../eval/EXPERIMENTS.md) 的誠實度很高——自己抓到 bug 就整批作廢、
寫下檢定力不足、拒絕用事後分析下結論。但 [README.md](../README.md) 的「特色」清單讀起來是一串肯定句,
使用者看不到「多個 AI 互相審查會讓結果更好,這件事在我們自己的評測裡從來沒有被證實過」。

**要講清楚的分界**(這是重點,不要寫成自我否定):

- 已經量過的:同模型互審(實驗 3、5、6,後來因為修復回合沒拿到檔案工具而作廢)、
  小模型動手 + Claude Code 把關(實驗 7,H3 不成立,主指標 −6.7 個百分點,p = 0.631)。
- **從來沒量過的**:產品真正的旗艦用法——Claude Code + Codex 同桌。
- 所以現況是「**未被證實**」,不是「已被證偽」。兩者差很多,而 README 現在兩者都沒說。

**建議的位置**:「注意」那一節,或「特色」之後獨立一小節,連到 `eval/EXPERIMENTS.md`。
一併補上這次新加的東西的適用範圍:棘輪保證的是「不會比任務開始前更糟」,
不是「做對了」;反例保證的是「這幾個具體的錯不見了」,不是「需求都滿足了」。

---

## 4. 算力對齊的 baseline(改造 3)

實驗設計上的一個既有問題:圓桌用掉 1.5–3 倍的時間與 token,但對照組是「單人跑 1 次」。
正確的對照是**單人跑 N 次 + 同一個棘輪挑選**,N 調到 token 數對齊。

棘輪做完之後這件事第一次做得到了——它就是那個挑選器。如果圓桌連這個 baseline 都贏不了,
答案就清楚;贏得了,那才是真的賣點。

這一項和第 2 項共用同一批基礎建設(`eval/ab.ts` 的多條件支援),建議一起規劃。
