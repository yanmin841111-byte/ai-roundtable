import type { BrowserWindow } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { parseBrowserPreviewUrl } from './ipc-types';

export type BrowserPreview = { text: string; console: string[]; image?: string };

let active = false;

export async function capturePreview(parent: BrowserWindow, url: URL, image: boolean, cancellation: AbortSignal): Promise<BrowserPreview> {
  const { BrowserWindow, session } = await import('electron');
  if (active) throw new Error('Another browser preview is in progress.');
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  const isolated = session.fromPartition('roundtable-browser-preview', { cache: false });
  active = true;
  let win: BrowserWindow | undefined;
  const close = () => { if (win && !win.isDestroyed()) win.destroy(); };
  signal.addEventListener('abort', close, { once: true });
  try {
    await isolated.setProxy({ mode: 'direct' });
    await isolated.clearStorageData();
    signal.throwIfAborted();
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    isolated.on('will-download', preventDownload);
    isolated.webRequest.onBeforeRequest((request, reply) => {
      const target = parseBrowserPreviewUrl(request.url);
      // Permit same-origin assets and reads, but no redirects to another document, subframes, or mutations.
      reply({ cancel: !target || target.origin !== url.origin || !['GET', 'HEAD'].includes(request.method)
        || request.resourceType === 'subFrame' || request.resourceType === 'webSocket'
        || (request.resourceType === 'mainFrame' && target.href !== url.href.split('#')[0]) });
    });
    isolated.webRequest.onHeadersReceived(({ responseHeaders }, reply) => {
      const headers = responseHeaders ?? {};
      const key = Object.keys(headers).find(name => name.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy';
      reply({ responseHeaders: {
        ...headers,
        'X-DNS-Prefetch-Control': ['off'],
        [key]: [...(headers[key] ?? []), "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'"],
      } });
    });
    win = new BrowserWindow({
      parent, show: false, width: 1200, height: 800, useContentSize: true,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
        webviewTag: false, disableDialogs: true, backgroundThrottling: false, spellcheck: false },
    });
    const contents = win.webContents;
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-frame-navigate', event => event.preventDefault());
    contents.on('will-redirect', event => event.preventDefault());
    const logs: string[] = [];
    contents.on('console-message', event => {
      if (event.frame === contents.mainFrame && logs.length < 20) logs.push(`[${event.level}] ${event.message.slice(0, 400)}`);
    });
    await contents.loadURL(url.href);
    await delay(350, undefined, { signal });
    const text: string = await contents.executeJavaScriptInIsolatedWorld(1, [{
      code: 'document.body?.innerText.slice(0, 12000) ?? ""',
    }]);
    const screenshot = image ? (await contents.capturePage()).toJPEG(70).toString('base64') : undefined;
    signal.throwIfAborted();
    if (image && !screenshot) throw new Error('The preview screenshot was empty.');
    return { text, console: logs, ...(screenshot ? { image: `data:image/jpeg;base64,${screenshot}` } : {}) };
  } finally {
    signal.removeEventListener('abort', close);
    close();
    isolated.removeListener('will-download', preventDownload);
    try { await isolated.clearStorageData(); } finally { active = false; }
  }
}

function preventDownload(event: Electron.Event) {
  event.preventDefault();
}
