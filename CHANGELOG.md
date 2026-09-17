# 變更紀錄

格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/),版本號遵循 [語意化版本](https://semver.org/lang/zh-TW/)。

## [未發布]

尚無。

## [0.1.0] - 2026-09-17

第一個版本。

### 新增

- 圓桌流程:成員輪流討論、主持人分工、平行執行、交叉審查、修復回合與總結;另有「只討論,不執行」模式。
- 內建 Claude Code、Codex CLI、Cursor CLI 與自訂指令轉接器,模型清單從各 CLI 的本機快取讀取。
- 擴充系統:用 JSON 描述 CLI 或 OpenAI 相容 API,或寫 JS 外掛;附 Grok、Kimi、DeepSeek、Gemini、OpenRouter、Ollama 與空白範本。
- 擴充編輯器的基本設定分頁、API 連線測試,以及用作業系統安全儲存加密保存 API key。
- 附件:拖放或選擇圖片、文字檔、PDF,依成員能力提供路徑、內嵌文字或圖片。
- 歷史對話:任務結束自動保存,可預覽、刪除、匯出成 Markdown,並能載入後繼續討論。
- `@名稱` 指定成員:只讓被指定的成員回覆;進行中指定時,任務結束前會確保對方回覆。
- 平行發言(執行、審查、修復、同時指定多位成員)每列並排三張顯示。
- 跨 CLI 與 API 的用量正規化與總計。
- 淺色、深色與跟隨系統主題,以及文字大小設定。
- 介面語言:繁體中文與 English(可跟隨系統),系統訊息、提示詞與匯出的 Markdown 一併切換。

### 變更

- 主程序、介面與測試改用 TypeScript(strict)撰寫;`npm start` 會先建置到 `dist/`,介面由 esbuild 打包。
- 主程序與介面共用 IPC 型別定義。
- 新增 GitHub Actions CI,每次 push 與 pull request 都跑型別檢查、測試、建置與端對端測試(`npm run e2e`,用假成員跑完整流程)。
- 內建 Claude Code / Codex CLI 轉接器有了重播 stream-json 事件的測試。
- `npm run dist` 產生未簽章的 dmg 到 `release/`;推送 `v*` 標籤會自動建置並附到 GitHub Release。

### 安全

- 擴充檔裡的明文 `apiKey` 欄位停用;載入時自動搬到安全儲存,確定存好才改寫檔案。
- `secrets.json` 損壞時先備份原檔,不會被新的 key 覆寫。
- 附件、歷史紀錄、擴充檔的路徑一律在主程序驗證。

[未發布]: https://github.com/yanmin841111-byte/ai-roundtable/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yanmin841111-byte/ai-roundtable/releases/tag/v0.1.0
