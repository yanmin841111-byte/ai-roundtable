'use strict';

// 常用的成員與工作目錄預設。
//
// 取捨:能用假成員的地方就用假成員。真模型一回合要一兩分鐘、結果每次不同,
// 只有在「要驗的就是真模型能不能用工具」時才值得。把假的當主持人、真的當執行者,
// 可以把「分工 JSON 產得對不對」和「檔案工具通不通」分開驗。

import path from 'path';
import type { HarnessMember } from './app';

export const FIXTURE_DIR = __dirname;

/**
 * 腳本化的假成員。依階段回固定內容,所以整場流程完全可預測。
 * plan 給定時,分工階段就吐那份 JSON。
 */
export function scriptedMember(opts: {
  id?: string;
  name?: string;
  plan?: { summary: string; assignments: Array<{ agent: string; task: string }> };
  discuss?: string;
  review?: string;
  /** 修復後複查時的回覆(沒給就沿用 review) */
  recheck?: string;
  canEdit?: boolean;
  /** 執行階段寫進工作目錄的檔案(相對路徑 → 內容) */
  writes?: Record<string, string>;
  /** 執行階段的回報文字 */
  report?: string;
}): HarnessMember {
  const payload = Buffer.from(JSON.stringify({
    plan: opts.plan || null,
    discuss: opts.discuss || '同意直接進入分工\n[AGREED]',
    review: opts.review || '看過了,沒問題\n[NO_ISSUES]',
    recheck: opts.recheck || null,
    writes: opts.writes || null,
    report: opts.report || null,
  }), 'utf8').toString('base64');
  return {
    id: opts.id || 'scripted',
    name: opts.name || '主持人',
    cli: 'custom',
    persona: '測試用的腳本成員',
    canEdit: opts.canEdit === true,
    // base64 傳參數,免得引號與換行在 shell / JSON 之間被吃掉
    customCommand: `node "${path.join(FIXTURE_DIR, 'scripted-agent.js')}" ${payload}`,
  };
}

/** 真的本機模型。預設沿用使用者已安裝的 ollama 設定,測到的才是實際生效的組合。 */
export function ollamaMember(opts: { id?: string; name?: string; model?: string } = {}): HarnessMember {
  return {
    id: opts.id || 'ollama',
    name: opts.name || 'Qwen',
    cli: 'ollama',
    model: opts.model || 'qwen3.8:27b-mlx',
    persona: '本機模型。一次只動一個地方,先讀檔再改。',
    canEdit: true,
  };
}

/** 綁在一個沒安裝的 CLI 上,用來驗「設定壞掉時畫面說了什麼」。 */
export function missingCliMember(opts: { id?: string; name?: string; cli?: string } = {}): HarnessMember {
  return {
    id: opts.id || 'missing',
    name: opts.name || 'Gemini',
    cli: opts.cli || 'gemini',
    persona: '對照用成員',
    canEdit: true,
  };
}

/** 一行就能改對、也一定改得出來的題目。驗檔案工具時用它,才不會把模型能力混進來。 */
export const ONE_LINE_EDIT = {
  file: 'src/net.js',
  before: [
    'function connect(host) {',
    '  if (!host) {',
    '    throw new Error("connection refused by upstream server");',
    '  }',
    '  return { host, ok: true };',
    '}',
    '',
    'module.exports = { connect };',
  ].join('\n') + '\n',
  oldText: 'connection refused by upstream server',
  newText: 'timeout while waiting for upstream server',
  get task() {
    return `請把 ${this.file} 裡 connect() 丟出的錯誤訊息改成 "${this.newText}"。`
      + '務必先用 read_file 讀出原文,再用 replace_text 精準替換,不要憑印象猜內容。';
  },
};
