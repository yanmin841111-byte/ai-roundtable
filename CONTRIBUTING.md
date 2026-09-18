**繁體中文** | [English](CONTRIBUTING.en.md)

# 參與貢獻

感謝你願意幫忙改進 AI Roundtable。回報問題、補擴充範本、修文件、送程式碼都很歡迎。

## 回報問題

請先搜尋 [issues](https://github.com/yanmin841111-byte/ai-roundtable/issues) 有沒有人回報過。開新 issue 時請附上:

- macOS 版本、Node.js 版本,以及用到的 CLI 與版本(左下角的 CLI 狀態可以看到)
- 重現步驟、預期結果、實際結果
- 相關的錯誤訊息或截圖

貼上對話紀錄或設定檔前,請先刪掉 API key、token、私人路徑與專案內容。安全性問題請不要開公開 issue,改依 [SECURITY.md](SECURITY.md) 私下回報。

## 開發環境

```bash
git clone https://github.com/yanmin841111-byte/ai-roundtable.git
cd ai-roundtable
npm install
npm start
npm test
```

程式碼是 TypeScript。`npm start` 會先建置到 `dist/` 再啟動 Electron,改完重新執行 `npm start` 即可。常用指令:

| 指令 | 用途 |
| --- | --- |
| `npm run typecheck` | 主程序與介面兩份 tsconfig 的型別檢查 |
| `npm test` | 用 `tsx` 直接跑 `test/*.test.ts`,不需要先建置 |
| `npm run build` | `tsc` 編譯主程序、esbuild 打包介面、複製靜態檔到 `dist/` |
| `npm run smoke:dist` | 確認 `dist/` 的 CommonJS 輸出可以正常載入 |
| `npm run e2e` | 建置後啟動真正的 Electron app,用假成員跑完整圓桌、附件、@ 指定與歷史紀錄(`test/e2e/`),不需要安裝任何 CLI |
| `npm run harness:ui` | 建置後逐一跑介面情境(`test/harness/scenarios/`),檢查燈號、徽章、審查結論、模型能力等畫面有沒有說實話,並留下截圖;全假成員,約 1~2 分鐘,CI 也會跑 |

開發時好用的環境變數與參數:

| 設定 | 用途 |
| --- | --- |
| `--user-data-dir=<資料夾>` | 用獨立的資料夾啟動,不動到自己的成員設定、歷史紀錄與 API key,例如 `npm start -- --user-data-dir=/tmp/ar-dev` |
| `AI_ROUNDTABLE_ADAPTERS_DIR` | 指定擴充資料夾,方便開發擴充 |
| `AI_ROUNDTABLE_DEBUG=1` | 把介面的 console 訊息印到終端機 |
| `AI_ROUNDTABLE_SHOT=<png>` | 啟動後截圖到指定檔案;搭配 `AI_ROUNDTABLE_SHOT_JS` 可先在介面執行一段 JS(例如塞入示範訊息) |
| `AI_ROUNDTABLE_SHOTS_DIR` | `harness:ui` 的截圖存放位置(預設在系統暫存目錄的 `ai-roundtable-shots/`) |

## 送 pull request

1. 從 `main` 開新分支,一個 PR 只處理一件事。
2. 行為有改動就補測試,送出前跑 `npm run typecheck` 與 `npm test`,全部通過才送;動到流程或介面時再跑 `npm run e2e` 與 `npm run harness:ui`。
3. 介面有改動時附上截圖,淺色與深色主題都檢查一次。
4. 使用者看得到的功能或設定有變,一併更新 `README.md`、`docs/` 與 `CHANGELOG.md` 的「未發布」段落,以及對應的英文版(`*.en.md`)。
5. PR 說明寫清楚改了什麼、為什麼、怎麼驗證。

Commit 訊息用英文祈使句開頭,第一行簡短說明做了什麼,例如 `Add Cursor CLI adapter`。

## 程式與文案慣例

- 介面文字、程式註解與文件使用繁體中文。
- 介面用字以 [docs/ui-copy.md](docs/ui-copy.md) 為準;新增或修改文案時同步更新該檔。
- 文案不直接寫在程式裡:介面文字放 `renderer/i18n.ts`(HTML 用 `data-i18n` 標記),主程序的系統訊息、提示詞與匯出文字放 `src/text.ts`,兩個檔案都要同時提供繁體中文與英文。
- 樣式只使用 `renderer/style.css` 既有的色彩變數(`--panel`、`--accent`、`--border` 等),新元件要在淺色、深色與「跟隨系統」下都正常,並遵守 `prefers-reduced-motion`。
- 主程序負責驗證與存取檔案,renderer 傳來的路徑、代號與數字一律不信任。
- 註解說明「為什麼」,不重述程式碼在做什麼。
- 測試是純 Node.js 腳本(`test/*.test.ts`),不依賴測試框架;放進 `test/` 並以 `.test.ts` 結尾就會被 `npm test` 執行。
- IPC 的參數與回傳型別集中在 `src/ipc-types.ts` 的 `IpcContract`;新增或修改通道時先改這裡,主程序的 `handle()` 與 `preload.ts` 的 `invoke()` 對不上就會編譯失敗。
- 使用者的 JS 外掛(`adapters/templates/*.js`)在執行期由主程序載入,維持純 JavaScript,不經過建置。

## 擴充範本

歡迎把好用的 CLI 或 API 設定送到 `adapters/templates/`,欄位說明見 [docs/adapters.md](docs/adapters.md)。請在 PR 註明:

- 實際測試過的 CLI 或 API 版本;沒有實測的話,在範本的 `description` 註明「尚未實測」
- 該服務是否支援續接、修改檔案、圖片等能力,以及 `capabilities` 的依據

## 授權

送出的貢獻會以 [MIT 授權](LICENSE) 釋出。
