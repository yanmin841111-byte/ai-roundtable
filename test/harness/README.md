# 測試 harness

啟動**真正的 app**,在裡面跑一段劇本,回傳結果與截圖。

## 為什麼需要它

這個產品最容易出錯、也最難發現的那類問題,只有整疊跑起來才看得到:

- 成員有沒有真的改到檔案,稽核有沒有真的進 transcript
- 燈號說的是不是真話(綠燈是不是真的能用)
- 設定壞掉時,畫面到底跟使用者說了什麼

單元測試看不到這些(它們在 IPC 與 renderer 之上),手動點又重現不了。

## 安全前提

`userData` 與 `workDir` 一律是拋棄式暫存目錄。**不碰使用者真正的設定,也不碰這個 repo。**
要用真實模型時只複製 adapter 設定(`adapters: ['installed:ollama-api']`),不複製 config。

## 用法

```ts
import { runApp, report } from '../app';
import { scriptedMember, ollamaMember, ONE_LINE_EDIT } from '../fixtures';

const r = await runApp({
  members: [
    scriptedMember({ id: 'lead', name: '主持人', plan: { summary: '…', assignments: [{ agent: 'A2', task: '…' }] } }),
    ollamaMember({ id: 'qwen' }),
  ],
  adapters: ['installed:ollama-api'],
  files: { 'src/net.js': '…' },
  git: true,
  constants: { target: 'src/net.js' },      // 劇本裡用 H.target 取用
  scenario: async (H) => {
    const g = globalThis as any;
    await g.ready();
    const msgs = await g.send('請修正錯誤訊息', 'divide');
    g.check(g.toolAudits(msgs).length > 0, '有工具稽核紀錄');
    await g.shot('after');
    return { ok: true };
  },
});

report('我的情境', r);
console.log(r.read('src/net.js'));   // 不經過 app 的獨立驗證
console.log(r.numstat());            // git 的說法
```

## 劇本裡可以用的東西

劇本是**序列化後送進 renderer 執行**的,所以**不能閉包外部變數**——要傳值請用 `constants`,劇本裡以 `H` 取用。
以下工具由 harness 注入(用 `globalThis` 取用,TypeScript 才看得到):

| 名稱 | 用途 |
|---|---|
| `ready()` | 等介面初始化完成(IPC 回來、事件綁好) |
| `send(msg, mode)` | 送出訊息並等整場跑完,回傳這次新增的訊息 |
| `waitIdle(ms)` | 等 app 閒置 |
| `waitFor(fn, ms, what)` | 等某個條件成立。畫面很多東西是非同步填的,不要用固定 sleep |
| `check(cond, msg)` | 斷言。通過的會列進 `result.steps` |
| `shot(name)` | 拍一張截圖 |
| `toolAudits(msgs)` | 從訊息抽出工具稽核紀錄 |
| `$(sel)` / `text(sel)` | DOM 捷徑 |
| `snapshot()` / `window.api` | 直接用 IPC |

## 現成情境

```bash
npm run harness:ui      # 設定壞掉時畫面說了什麼。全假成員,快,可進 CI
npm run harness:live    # 真的本機模型改檔案。需要 ollama serve 正在跑
```

## 踩過的坑

- **劇本函式會被 esbuild 加上 `__name(...)`**。harness 的 prelude 補了一個等價的 no-op,不必自己處理。
- **adapter 檔名必須以英數字開頭**(`registry.ts` 的 `FILE_PATTERN`)。`.tmp-x.json` 會被靜靜濾掉。
- **非同步渲染**:健康檢查、雲端 key 驗證都是後來才填上去的。用 `waitFor` 等**你要驗的那個狀態**,不要等「有沒有東西」——一開始就存在的元素會讓你假通過。
- **不要等「某段字消失」**。第一次渲染前那裡是空字串,「不含『檢查中』」會立刻成立。要等完成態本身出現(例如「3/4 個 CLI 可用」)。這個錯誤會讓測試靠時序運氣通過,換台機器就壞。
- **斷言要讀對元素**。讀整張卡的文字會被 persona 之類的內容誤中;要驗徽章就讀 `.badge`。
- **截圖**在 `report()` 時複製到 `$TMPDIR/ai-roundtable-shots/<情境名>/`,暫存目錄清掉也還在。
