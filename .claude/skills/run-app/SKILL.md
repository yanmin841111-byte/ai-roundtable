---
name: run-app
description: 啟動並驅動 AI Roundtable 這個 Electron app —— 要看某個改動在真實 app 裡的行為、要截圖、要驗證成員是否真的改了檔案或稽核是否進了 transcript 時使用。不要自己寫一次性的 spawn electron 腳本。
---

# 跑這個 app

**先用 `test/harness/`,不要重寫驅動程式。** 讀 [test/harness/README.md](../../../test/harness/README.md)。

## 快速開始

```bash
npm run harness:ui      # 完整介面與流程回歸(全假成員,通常數分鐘)
npm run harness:reports # 回報與證據保存回歸(固定端點,不呼叫真模型)
npm run harness:live    # 真的本機模型改檔案(需要 ollama serve,約 1~7 分鐘)
npm run harness:login   # CLI 沒登入時的提示(需要裝有 claude 與 codex)
```

寫新情境:複製 `test/harness/scenarios/ui-states.ts`,改劇本內容。

## 關鍵事實

- **必須先 `npm run build`**。harness 跑的是 `dist/`,不是原始碼。上述 `harness:*` npm scripts 都已經包含 build;直接執行情境檔案時要自行先建置。
- **一定要用隔離環境**。harness 已經處理:`userData` 與 `workDir` 都是拋棄式暫存目錄。
  絕對不要拿使用者真正的設定(`~/Library/Application Support/AI Roundtable/`)去跑測試。
- **要用真實模型**就 `adapters: ['installed:ollama-api']`,只複製 adapter 設定,不複製 config。
- `env -u ELECTRON_RUN_AS_NODE` 是必要的——有那個變數時 electron 會以純 node 模式啟動,開不了視窗。

## 驗證的三條獨立線

驗「成員真的改了檔案」時,只信一條線是不夠的(app 說改了,不代表磁碟真的變了):

1. **app 內部**:`toolAudits(msgs)` —— 稽核有沒有進 transcript,含不含 `shaAfter` 與增刪行數
2. **磁碟**:`r.read('path')` —— 檔案內容真的變了嗎
3. **git**:`r.numstat()` —— 與稽核的 +N/-M 對不對得上

## 手動看畫面

只想看一眼、不需要斷言時:

```bash
npm run build && env -u ELECTRON_RUN_AS_NODE npx electron . --user-data-dir=$(mktemp -d)
```

用真正的設定開(會動到使用者資料,只在使用者要求時這樣做):

```bash
npm start
```
