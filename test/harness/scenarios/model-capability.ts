'use strict';

// 情境:API 成員的模型能力顯示在成員卡片與編輯視窗,按「測試」會實際測。
//
// 起一個假的本機端點(像 Ollama):/api/show 說 gemma3 能看圖、不能呼叫工具;qwen3 能呼叫工具、不能看圖。
// 卡片只標限制;編輯視窗列出完整能力與來源;按「測試」送出實際請求。
// 這個端點實際上收下了工具,所以測試結果和 Ollama 的回報不同:測完之後卡片要跟著更新。
// Gemma 的設定只寫別名 gemma3(清單裡是 gemma3:latest)——卡片與編輯視窗用的名字不同,更新時容易對不上。

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { runApp, report } from '../app';

function fakeEndpoint(): Promise<{ server: http.Server; port: number; chats: () => number }> {
  let chats = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const send = (status: number, json: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.url === '/v1/models') return send(200, { data: [{ id: 'gemma3:latest' }, { id: 'qwen3:8b' }] });
      if (req.url === '/api/show') return send(200, { capabilities: body.model === 'gemma3:latest' ? ['completion', 'vision'] : ['completion', 'tools'] });
      if (req.url === '/v1/chat/completions') {
        chats++;
        return send(200, { choices: [{ message: { role: 'assistant', content: 'OK' } }] });
      }
      send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, chats: () => chats })));
}

async function once(locale: 'zh-Hant' | 'en') {
  const zh = locale === 'zh-Hant';
  const ep = await fakeEndpoint();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-capui-')), 'fakelocal.json');
  fs.writeFileSync(file, JSON.stringify({
    id: 'fakelocal', type: 'openai', label: zh ? '測試端點' : 'Test endpoint', baseUrl: `http://127.0.0.1:${ep.port}/v1`,
    models: 'auto', stream: false, supportsEdit: true, fileTools: { enabled: true },
    capabilities: { attachments: ['textInline', 'imageInline'] },
  }));
  const r = await runApp({
    members: [
      { id: 'g', name: 'Gemma', cli: 'fakelocal', model: 'gemma3', canEdit: true },
      { id: 'q', name: 'Qwen', cli: 'fakelocal', model: 'qwen3:8b', canEdit: true },
    ],
    adapters: [file],
    settings: { leadAgentId: 'g', uiLocale: locale, language: zh ? '繁體中文' : 'English' },
    constants: { zh },
    timeoutMs: 2 * 60 * 1000,
    scenario: async (H: any) => {
      const g: any = globalThis;
      await g.ready();
      const card = (id: string) => document.querySelector(`#agent-list .agent-card[data-agent-id="${id}"]`) as HTMLElement;
      const badges = (id: string) => Array.from(card(id).querySelectorAll('.badge')).map((b) => b.textContent);
      // 兩位成員的能力各自非同步查回來:兩張卡片都等到,不能只等其中一張(CI 的機器慢,曾經因此失敗)
      await g.waitFor(() => badges('g').includes(H.zh ? '不支援工具' : 'no tools') && badges('q').includes(H.zh ? '不能看圖' : 'no images'), 15000, '兩張卡片的能力徽章');
      g.check(badges('g').includes(H.zh ? '不支援工具' : 'no tools'), `Gemma 的卡片標出不支援工具(${badges('g').join(', ')})`);
      g.check(!badges('g').includes(H.zh ? '不能看圖' : 'no images'), 'Gemma 能看圖,不標');
      g.check(badges('q').includes(H.zh ? '不能看圖' : 'no images') && !badges('q').includes(H.zh ? '不支援工具' : 'no tools'), `Qwen 的卡片只標不能看圖(${badges('q').join(', ')})`);
      await g.shot(`cards-${H.zh ? 'zh' : 'en'}`);

      // 編輯視窗:完整能力與來源
      card('g').click();
      const capText = () => ['#f-cap-text', '#f-cap-source', '#f-cap-effect'].map((s) => (document.querySelector(s) as HTMLElement).textContent || '').join(' | ');
      await g.waitFor(() => /Ollama/.test(capText()), 10000);
      const wrap = document.querySelector('#f-cap') as HTMLElement;
      g.check(wrap.offsetHeight > 0, '編輯視窗顯示模型能力列');
      g.check(new RegExp(H.zh ? '不能呼叫工具 · 可以看圖 \\| 來源:Ollama 回報 \\| 這位成員不能改檔' : 'cannot call tools · can see images \\| Source: reported by Ollama \\| This member cannot edit files').test(capText()), `能力列寫出能力、來源與影響(${capText()})`);
      g.check((document.querySelector('#f-cap-effect') as HTMLElement).offsetHeight > 0, '不能呼叫工具的影響要看得到');
      await g.shot(`editor-${H.zh ? 'zh' : 'en'}`);

      // 按「測試」:實際送請求
      (document.querySelector('#f-cap-test') as HTMLButtonElement).click();
      await g.waitFor(() => new RegExp(H.zh ? '實際測試' : 'tested').test(capText()), 20000);
      g.check(new RegExp(H.zh ? '可以呼叫工具 · 可以看圖 \\| 來源:.*實際測試' : 'can call tools · can see images \\| Source: tested').test(capText()), `測試後顯示實際測試的結果(${capText()})`);
      g.check((document.querySelector('#f-cap-effect') as HTMLElement).hidden, '能呼叫工具就不顯示影響');
      g.check(!(document.querySelector('#f-cap-test') as HTMLButtonElement).disabled, '測試完按鈕恢復');
      await g.shot(`tested-${H.zh ? 'zh' : 'en'}`);

      // 不存檔直接關掉編輯視窗:卡片(存的是別名 gemma3)也要換成測好的結果
      (document.querySelector('#modal-close') as HTMLButtonElement).click();
      await g.waitFor(() => !badges('g').includes(H.zh ? '不支援工具' : 'no tools'), 10000, '卡片更新');
      g.check(!badges('g').includes(H.zh ? '不支援工具' : 'no tools'), `測試之後卡片跟著更新(${badges('g').join(', ')})`);

      // 送出前的圖片提醒也要看模型能力:範本會送圖,但 Qwen 的模型不能看圖;Gemma 可以
      const input = document.querySelector('#input') as HTMLTextAreaElement;
      input.value = H.zh ? '請看圖' : 'Look at this';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const image = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2])], 'sample.png', { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(image);
      (document.querySelector('.composer-box') as HTMLElement).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await g.waitFor(() => /Qwen/.test(g.text('#hint')), 5000, '圖片能力警告');
      const hint = g.text('#hint');
      g.check(new RegExp(H.zh ? '圖片內容無法提供給 Qwen' : 'Qwen cannot receive image content').test(hint) && !/Gemma/.test(hint), `送出前提醒只點名看不到圖的 Qwen(${hint})`);

      const leaks = g.hiddenLeaks();
      g.check(leaks.length === 0, `沒有帶 hidden 卻仍佔版面的元素(${leaks.join(', ') || '無'})`);
      return { cap: capText() };
    },
  });
  ep.server.close();
  report(`模型能力 · ${locale}`, r);
  // 沒按「測試」之前一個對話請求都不能送;按了之後是三個(基準、工具、圖片)
  if (r.ok && ep.chats() !== 3) { console.log(`  失敗:對話請求應該剛好 3 個(按了一次測試),實際 ${ep.chats()} 個`); r.ok = false; }
  r.cleanup();
  return r;
}

async function main() {
  const zh = await once('zh-Hant');
  const en = await once('en');
  if (!zh.ok || !en.ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
