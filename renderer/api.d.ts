// Renderer 端的全域宣告:preload 透過 contextBridge 掛上的 window.api。
// 型別本身定義在 src/ipc-types.ts,由主程序、preload 與 renderer 共用。
// 注意:src/ipc-types.ts 會被 renderer bundle inline,不得 import electron 或 node:* 模組。

import type { RendererApi } from '../src/ipc-types';

export type * from '../src/ipc-types';

declare global {
  interface Window {
    api: RendererApi;
  }
}
