// OpenAI 相容 Chat Completions API 轉接器(DeepSeek、Kimi、Grok、OpenRouter、Ollama、LM Studio…)。
// 規格見 docs/adapters.md。

import crypto from 'crypto';
import fs from 'fs';
import { truncate, createStopHandle, formatTimeout, DEFAULT_TURN_TIMEOUT_MS } from './process';
import { renderDeep } from './template';
import { findModel, resolveModelId, resolveEffort } from '../model-rules';
import { normalizeModels, normalizeCapabilities } from './spec';
import { FILE_TOOL_DEFINITIONS, FILE_TOOL_MAX_CALLS, FileToolSession, toTranscriptEntry } from './file-tools';
import type { AdapterCapabilities, Adapter, RunAttachment } from './types';
import { tx } from '../text';
import type { TextLocale } from '../text';

const MODELS_TTL_MS = 10 * 60 * 1000;
const MODELS_FETCH_TIMEOUT_MS = 8000;
const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
type OpenAIHealthAdapter = Adapter & { probeConnectionOnCheck: boolean };

const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

// Ollama 的 /v1/models 會回傳 name:latest，但使用者與範本常寫裸名 name。
// 只把 :latest 視為裸名別名；其他 tag（例如 :27b-mlx）仍保持明確，不猜測。
function withLatestAlias(id: string) {
  const latest = id.match(/^(.*):latest$/i);
  return latest && latest[1] ? { id, aliases: [latest[1]] } : { id };
}

function canonicalModelId(models: any, requested: unknown): string | null {
  return findModel(models, requested)?.id || null;
}

function validateOpenAISpec(spec: any, errors: any) {
  if (typeof spec.baseUrl !== 'string' || !/^https?:\/\//.test(spec.baseUrl)) errors.push('baseUrl 必須是 http:// 或 https:// 開頭的網址');
  if (spec.apiKeyEnv != null && typeof spec.apiKeyEnv !== 'string') errors.push('apiKeyEnv 必須是環境變數名稱');
  if (spec.secretRef != null && (typeof spec.secretRef !== 'string' || !SECRET_REF_PATTERN.test(spec.secretRef))) errors.push('secretRef 格式不正確');
  if (spec.apiKey != null) errors.push('apiKey 明文欄位已停用，請在擴充設定的 API key 欄位安全移轉');
  if (spec.headers != null && (typeof spec.headers !== 'object' || Array.isArray(spec.headers))) errors.push('headers 必須是物件');
  if (spec.body != null && (typeof spec.body !== 'object' || Array.isArray(spec.body))) errors.push('body 必須是物件');
  if (spec.effortBody != null && (typeof spec.effortBody !== 'object' || Array.isArray(spec.effortBody))) errors.push('effortBody 必須是物件');
  if (spec.maxHistoryMessages != null && (!Number.isInteger(spec.maxHistoryMessages) || spec.maxHistoryMessages <= 0)) errors.push('maxHistoryMessages 必須是正整數');
  if (spec.unreachableHint != null && typeof spec.unreachableHint !== 'string') errors.push('unreachableHint 必須是字串');
  if (spec.supportsEdit != null && typeof spec.supportsEdit !== 'boolean') errors.push('supportsEdit 必須是布林值');
  if (spec.fileTools != null && (!spec.fileTools || typeof spec.fileTools !== 'object' || Array.isArray(spec.fileTools))) errors.push('fileTools 必須是物件');
  else if (spec.fileTools?.enabled != null && typeof spec.fileTools.enabled !== 'boolean') errors.push('fileTools.enabled 必須是布林值');
  if (spec.supportsEdit === true && spec.fileTools?.enabled !== true) errors.push('supportsEdit=true 時必須明確設定 fileTools.enabled=true');
  if (spec.fileTools?.enabled === true && spec.supportsEdit !== true) errors.push('fileTools.enabled=true 時必須明確設定 supportsEdit=true');
  if (spec.modelFilter != null) {
    try { new RegExp(spec.modelFilter); } catch (e: any) { errors.push(`modelFilter 不是有效的正規表示式:${e.message}`); }
  }
}

function joinUrl(base: any, p: any) {
  return base.replace(/\/+$/, '') + '/' + String(p).replace(/^\/+/, '');
}

function missingApiKeyMessage(spec: any, locale: TextLocale) {
  return spec.apiKeyEnv
    ? tx(locale, 'api.missingKeyEnv', { env: spec.apiKeyEnv })
    : tx(locale, 'api.missingKey');
}

// key 存在但被伺服器拒絕。這和「沒填 key」是不同的狀況,訊息要說得出差別,
// 否則使用者會反覆去確認一個其實已經填好、只是過期或打錯的欄位。
function invalidApiKeyMessage(spec: any, locale: TextLocale) {
  return tx(locale, 'api.invalidKey', { service: spec.label || spec.id || tx(locale, 'api.service') });
}

function buildUserContent(prompt: string, attachments: RunAttachment[] | undefined, capabilities: AdapterCapabilities) {
  const modes = capabilities && Array.isArray(capabilities.attachments) ? capabilities.attachments : [];
  if (!modes.includes('imageInline')) return prompt;
  const images: any[] = [];
  for (const item of Array.isArray(attachments) ? attachments : []) {
    if (!item || item.kind !== 'image' || typeof item.path !== 'string' || !/^image\/(png|jpeg|webp|gif)$/.test(item.mime || '')) continue;
    try {
      const data = fs.readFileSync(item.path);
      images.push({ type: 'image_url', image_url: { url: `data:${item.mime};base64,${data.toString('base64')}` } });
    } catch {}
  }
  return images.length ? [{ type: 'text', text: prompt }, ...images] : prompt;
}

function createOpenAIAdapter(spec: any, { fetchImpl, getSecret, getLocale }: any = {}): Adapter {
  const locale = (): TextLocale => getLocale?.() || 'zh-Hant';
  const doFetch: any = fetchImpl || ((...a: Parameters<typeof fetch>) => fetch(...a));
  const staticModels = spec.models === 'auto' ? null : normalizeModels(spec.models);
  const sessions = new Map(); // sessionId -> [{ role, content }]
  const maxHistory = Number.isInteger(spec.maxHistoryMessages) && spec.maxHistoryMessages > 0 ? spec.maxHistoryMessages : 80;
  // 沒宣告時只送文字:很多相容端點(DeepSeek、多數 Ollama 模型)不收圖片。支援圖片的請在設定加上 imageInline。
  const capabilities = normalizeCapabilities(spec.capabilities, ['textInline']);
  const supportsFileTools = spec.supportsEdit === true && spec.fileTools?.enabled === true;
  let fetched: any = { models: [], at: 0, error: null, pending: null };

  const apiKey = () => {
    if (spec.secretRef && getSecret) {
      try {
        const secret = getSecret(spec.secretRef);
        if (secret) return secret;
      } catch {}
    }
    return (spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : '') || '';
  };
  const headers = () => {
    const h = { 'Content-Type': 'application/json', ...(spec.headers || {}) };
    const key = apiKey();
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  };
  const currentModels = () => staticModels || fetched.models;
  const hasCredentialSetting = !!(spec.secretRef || spec.apiKeyEnv);
  const missingRequiredApiKey = () => hasCredentialSetting && !apiKey() && !spec.apiKeyOptional;

  async function refreshModels(force: any = false) {
    if (staticModels) return;
    if (!force && fetched.at && Date.now() - fetched.at < MODELS_TTL_MS) return;
    if (fetched.pending) return fetched.pending;
    fetched.pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
      try {
        const res = await doFetch(joinUrl(spec.baseUrl, spec.modelsPath || '/models'), { headers: headers(), signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${truncate(await res.text(), 200)}`);
        const data = await res.json();
        const filter = spec.modelFilter ? new RegExp(spec.modelFilter) : null;
        const ids = (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [])
          .map((m: any) => (typeof m === 'string' ? m : m.id || m.name))
          .filter((id: any) => typeof id === 'string' && (!filter || filter.test(id)))
          .sort();
        fetched = {
          models: normalizeModels(ids.map((id: any) => ({
            ...withLatestAlias(id),
            ...(spec.efforts ? { efforts: spec.efforts } : {}),
          }))),
          at: Date.now(),
          error: null,
          pending: null,
        };
      } catch (e: any) {
        fetched = { ...fetched, at: Date.now(), error: e.name === 'AbortError' ? tx(locale(), 'api.modelsTimeout') : e.message, pending: null };
      } finally {
        clearTimeout(timer);
      }
    })();
    return fetched.pending;
  }

  async function testConnection() {
    if (missingRequiredApiKey()) return { ok: false, state: 'unauthenticated' as const, error: missingApiKeyMessage(spec, locale()) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(joinUrl(spec.baseUrl, spec.modelsPath || '/models'), { headers: headers(), signal: controller.signal });
      if (!res.ok) {
        const body = truncate(await res.text(), 200);
        // 401/403 表示 key 存在但無效——這是最常見的失敗。以前只回一個沒有 state 的錯誤,
        // 設定畫面因此對過期的 key 亮綠燈,使用者要送出任務、等模型跑完才會發現。
        if (res.status === 401 || res.status === 403) {
          return { ok: false, state: 'unauthenticated' as const, error: `HTTP ${res.status} ${body}`, hint: invalidApiKeyMessage(spec, locale()) };
        }
        return { ok: false, error: `HTTP ${res.status} ${body}` };
      }
      return { ok: true, state: 'ready' as const, version: tx(locale(), 'api.connected', { url: spec.baseUrl }) };
    } catch (e: any) {
      const connectionError = e.name === 'AbortError' ? tx(locale(), 'api.connectionTimeout') : e.message;
      // 連不上就是連不上,有沒有 key 都一樣。過去有 key 的 adapter 會回一個沒有 state 的錯誤,
      // 再被 registry 正規化成 unauthenticated——離線被講成「尚未登入」,方向完全相反。
      return {
        ok: false,
        state: 'unreachable' as const,
        error: connectionError,
        hint: (typeof spec.unreachableHint === 'string' && spec.unreachableHint.trim())
          || tx(locale(), hasCredentialSetting ? 'api.networkHint' : 'api.localHint'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const adapter: OpenAIHealthAdapter = {
    id: spec.id,
    label: spec.label || spec.id,
    type: 'openai',
    description: spec.description || '',
    bin: null,
    supportsResume: spec.history !== false,
    // OpenAI-compatible adapter 預設永遠唯讀；必須由規格同時明確開啟 supportsEdit 與 fileTools。
    // 實際執行還要通過 ctx.fileToolsEnabled（由 orchestrator 的 reviewer 條件控制）。
    supportsEdit: supportsFileTools,
    efforts: spec.efforts || [],
    usageShape: 'openai', // OpenAI 相容端點:prompt_tokens 已含快取,cached 在 prompt_tokens_details
    capabilities,
    // Registry.checkAll 只對完全免 credential 的 HTTP adapter 做「每次都探測」。
    // 有 key 的雲端 API 不在每次啟動時連線(那會變成每開一次 app 就打一輪付費端點),
    // 改由 checkAll({ probeCredentialed: true }) 在使用者打開設定時驗證——
    // 那正是他要讀燈號判斷「能不能開會」的時刻。
    // 不放進共用 Adapter 介面，避免把 OpenAI 專屬策略擴散到 CLI / JS adapter。
    probeConnectionOnCheck: !hasCredentialSetting,
    listModels: () => {
      if (staticModels) return { models: staticModels, source: 'config' };
      return { models: fetched.models, source: fetched.error ? 'error' : fetched.at ? 'api' : 'loading', error: fetched.error };
    },
    refreshModels,
    check: async () => {
      if (missingRequiredApiKey()) return { ok: false, state: 'unauthenticated', error: missingApiKeyMessage(spec, locale()) };
      return { ok: true, state: 'ready', version: `API ${spec.baseUrl}` };
    },
    testConnection,
    run: (agent: any, ctx: any) => runChat(agent, ctx),
  };
  return adapter;

  async function runChat(agent: any, ctx: any) {
    if (missingRequiredApiKey()) {
      return { text: '', thinking: '', sessionId: null, usage: null, error: missingApiKeyMessage(spec, ctx.locale || locale()) };
    }
    const models = currentModels();
    const model = resolveModelId(models, agent.model || spec.defaultModel || '');
    if (!model) return { text: '', thinking: '', sessionId: null, usage: null, error: tx(ctx.locale || locale(), 'api.noModel') };
    const eff = resolveEffort(models, model, agent.effort);
    if (eff.note) ctx.onActivity({ id: 'run-options', kind: 'note', title: eff.note, status: 'done' });

    const history = (spec.history !== false && ctx.sessionId && sessions.get(ctx.sessionId)) || [];
    const vars = { model, effort: eff.effort || '', agentName: agent.name || '' };
    const effortBody = spec.effortBody || { reasoning_effort: '{effort}' };
    const stream = spec.stream !== false;
    const timeoutMs = spec.timeoutMs || ctx.timeoutMs || DEFAULT_TURN_TIMEOUT_MS;
    const reasoningFields = spec.reasoningFields || ['reasoning_content', 'reasoning'];

    const toolsEnabled = supportsFileTools && agent.canEdit === true && ctx.fileToolsEnabled === true;
    let fileTools: FileToolSession | null = null;
    if (toolsEnabled) {
      try { fileTools = new FileToolSession(ctx.cwd); }
      catch (e: any) { return { text: '', thinking: '', sessionId: ctx.sessionId || null, usage: null, error: tx(ctx.locale || locale(), 'api.fileToolsFailed', { error: e.message }), toolEvents: [] }; }
    }
    const deadline = Date.now() + timeoutMs;

    const request = async (messages: any[], textPrefix: string, thinkingPrefix: string) => {
      const body = {
        ...renderDeep(spec.body || {}, vars),
        ...(eff.effort ? renderDeep(effortBody, vars) : {}),
        model,
        messages,
        stream,
        ...(fileTools ? { tools: FILE_TOOL_DEFINITIONS, tool_choice: 'auto' } : {}),
        ...(stream && spec.streamUsage !== false ? { stream_options: { include_usage: true } } : {}),
      };

      const controller = new AbortController();
      const handle = createStopHandle(() => controller.abort());
      ctx.onProc(handle);
      let timedOut = false;
      const remainingMs = Math.max(0, deadline - Date.now());
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, remainingMs);
      const out: any = { text: '', thinking: '', usage: null, error: null, status: 0, toolCalls: [] };
      const toolCalls = new Map<number, any>();

      const onChunk = (data: any) => {
        if (data.error) { out.error = data.error.message || JSON.stringify(data.error); return; }
        if (data.usage) out.usage = data.usage;
        const choice = data.choices && data.choices[0];
        if (!choice) return;
        const part = choice.delta || choice.message || {};
        if (typeof part.content === 'string' && part.content) { out.text += part.content; ctx.onText(textPrefix + out.text); }
        for (const f of reasoningFields) {
          if (typeof part[f] === 'string' && part[f]) { out.thinking += part[f]; ctx.onThinking(thinkingPrefix + out.thinking); break; }
        }
        for (const fragment of Array.isArray(part.tool_calls) ? part.tool_calls : []) {
          let index = Number.isInteger(fragment.index) ? fragment.index : -1;
          if (index < 0 && fragment.id) {
            for (const [knownIndex, known] of toolCalls) {
              if (known.id === fragment.id) { index = knownIndex; break; }
            }
          }
          if (index < 0) index = toolCalls.size;
          const call = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (fragment.id) call.id = fragment.id;
          if (fragment.type) call.type = fragment.type;
          if (fragment.function?.name) call.function.name += fragment.function.name;
          if (typeof fragment.function?.arguments === 'string') call.function.arguments += fragment.function.arguments;
          else if (fragment.function?.arguments && typeof fragment.function.arguments === 'object') call.function.arguments = JSON.stringify(fragment.function.arguments);
          toolCalls.set(index, call);
        }
      };

      try {
        const res = await doFetch(joinUrl(spec.baseUrl, spec.path || '/chat/completions'), {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        out.status = res.status;
        if (!res.ok) {
          const raw = await res.text();
          let msg = raw;
          try { const j = JSON.parse(raw); msg = (j.error && (j.error.message || j.error)) || j.message || raw; } catch {}
          out.error = `HTTP ${res.status}:${truncate(typeof msg === 'string' ? msg : JSON.stringify(msg), 800)}`;
        } else if (stream && res.body) {
          await readSse(res.body, onChunk);
        } else {
          onChunk(await res.json());
        }
      } catch (e: any) {
        if (timedOut) out.error = tx(ctx.locale || locale(), 'api.runTimeout', { duration: formatTimeout(timeoutMs) });
        else if (e.name === 'AbortError') out.error = out.error || tx(ctx.locale || locale(), 'api.stopped');
        else out.error = tx(ctx.locale || locale(), 'api.cannotConnect', { url: spec.baseUrl, error: e.cause ? e.cause.message || e.cause.code : e.message });
      } finally {
        clearTimeout(timer);
        handle.close();
      }
      out.toolCalls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({
        ...call,
        id: call.id || `call_${crypto.randomUUID()}`,
      }));
      return out;
    };

    let userContent = buildUserContent(ctx.prompt, ctx.attachments, capabilities);
    const runConversation = async (content: any) => {
      const systemMessages = ctx.systemPrompt ? [{ role: spec.systemRole || 'system', content: ctx.systemPrompt }] : [];
      const exchange: any[] = [{ role: 'user', content }];
      let text = '';
      let thinking = '';
      let usage: any = null;
      let status = 0;
      let error: string | null = null;
      const toolEvents: any[] = [];

      // 每輪工具本身另有 20 次硬上限；API 往返也設上限，避免模型反覆呼叫失敗工具。
      for (let apiRound = 0; apiRound < 10; apiRound++) {
        if (Date.now() >= deadline) { error = tx(ctx.locale || locale(), 'api.runTimeout', { duration: formatTimeout(timeoutMs) }); break; }
        const result = await request([...systemMessages, ...history, ...exchange], text, thinking);
        status = result.status;
        usage = result.usage || usage;
        if (result.text) text += result.text;
        if (result.thinking) thinking += result.thinking;
        if (result.error) { error = result.error; break; }
        if (!fileTools || !result.toolCalls.length) {
          exchange.push({ role: 'assistant', content: result.text || '' });
          return { text, thinking, usage, error: null, status, exchange, toolEvents };
        }
        if (result.toolCalls.length > fileTools.remainingCalls) {
          const call = result.toolCalls[0];
          const toolResult = { ok: false, error: tx(ctx.locale || locale(), 'api.tooManyTools', { n: FILE_TOOL_MAX_CALLS }) };
          exchange.push({ role: 'assistant', content: result.text || null, tool_calls: [call] });
          const entry = toTranscriptEntry(call.id, call.function?.name || '', call.function?.arguments || '{}', toolResult);
          toolEvents.push(entry);
          ctx.onActivity({ id: call.id, kind: 'tool', title: entry.summary, detail: JSON.stringify(entry.result), status: 'error' });
          exchange.push({ role: 'tool', tool_call_id: call.id, name: call.function?.name || '', content: JSON.stringify(toolResult) });
          continue;
        }

        exchange.push({ role: 'assistant', content: result.text || null, tool_calls: result.toolCalls });
        for (const call of result.toolCalls) {
          const name = call.function?.name || '';
          const args = call.function?.arguments || '{}';
          ctx.onActivity({ id: call.id, kind: 'tool', title: tx(ctx.locale || locale(), 'api.toolRunning', { name }), status: 'running' });
          const toolResult = fileTools.execute(name, args);
          const entry = toTranscriptEntry(call.id, name, args, toolResult);
          toolEvents.push(entry);
          ctx.onActivity({
            id: call.id,
            kind: 'tool',
            title: entry.summary,
            detail: JSON.stringify(entry.result),
            status: toolResult.ok ? 'done' : 'error',
          });
          exchange.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(toolResult) });
        }
      }
      if (!error) error = tx(ctx.locale || locale(), 'api.toolRoundsExceeded');
      return { text, thinking, usage, error, status, exchange, toolEvents };
    };

    let result = await runConversation(userContent);
    // 很多 OpenAI 相容端點(或同一家的純文字模型)不收 image_url,會直接回 4xx。
    // 帶了圖片才失敗時改用純文字重送一次，否則每回合都會重送同一張圖、一直失敗。
    const imageCount = Array.isArray(userContent) ? userContent.filter((p: any) => p.type === 'image_url').length : 0;
    if (result.error && imageCount && [400, 415, 422].includes(result.status)) {
      ctx.onActivity({ id: 'image-fallback', kind: 'note', title: tx(ctx.locale || locale(), 'api.imageFallback', { error: result.error.slice(0, 120), n: imageCount }), status: 'done' });
      // 第一輪可能已經改過檔案。那些稽核紀錄不能因為重試就消失:
      // 檔案已經落盤,少了紀錄就等於沒有人會去審它,而畫面看起來一切正常。
      const executedBeforeRetry = result.toolEvents || [];
      userContent = ctx.prompt;
      result = await runConversation(userContent);
      if (executedBeforeRetry.length) result.toolEvents = [...executedBeforeRetry, ...(result.toolEvents || [])];
    }

    let sessionId = ctx.sessionId || null;
    if (!result.error && spec.history !== false) {
      sessionId = sessionId || crypto.randomUUID();
      const next = [...history, ...result.exchange];
      sessions.set(sessionId, compactHistoryImages(next.slice(-maxHistory)));
      ctx.onSession(sessionId);
    }
    return { text: result.text, thinking: result.thinking, sessionId, usage: result.usage, error: result.error, toolEvents: result.toolEvents };
  }
}

// 一鍵連接 Ollama 的底層探測。Renderer 不需知道端點、認證或模型 API；
// Registry.quickSetupOllama 會把這份結果轉成可直接選擇與儲存的資料。
async function discoverOllama({ fetchImpl, baseUrl = OLLAMA_DEFAULT_BASE_URL, getLocale }: any = {}) {
  const adapter = createOpenAIAdapter({
    id: 'ollama-discovery',
    type: 'openai',
    label: 'Ollama',
    baseUrl,
    models: 'auto',
    unreachableHint: tx(getLocale?.() || 'zh-Hant', 'api.startOllama'),
  }, { fetchImpl, getLocale });
  const health = adapter.testConnection ? await adapter.testConnection() : { ok: false, error: tx(getLocale?.() || 'zh-Hant', 'api.ollamaTestFailed') };
  if (!health.ok) return { ok: false, baseUrl, models: [], error: health.error || tx(getLocale?.() || 'zh-Hant', 'api.ollamaConnectFailed'), hint: health.hint || null };
  if (adapter.refreshModels) await adapter.refreshModels();
  const list = adapter.listModels ? adapter.listModels() : { models: [], source: 'none' };
  if (list.error) return { ok: false, baseUrl, models: [], error: list.error, hint: health.hint || null };
  return { ok: true, baseUrl, models: list.models || [], error: null, hint: null };
}

// 對話記憶裡只保留最近一則帶圖訊息的影像資料，更早的換成文字佔位。
// 否則每張 base64 圖片會在記憶中留到 maxHistory 則，並在之後每一回合重送。
function compactHistoryImages(history: any) {
  let keptLatest = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const content = history[i].content;
    if (!Array.isArray(content) || !content.some((p: any) => p && p.type === 'image_url')) continue;
    if (!keptLatest) { keptLatest = true; continue; }
    const count = content.filter((p: any) => p && p.type === 'image_url').length;
    const text = content.filter((p: any) => p && p.type === 'text').map((p: any) => p.text).join('\n');
    history[i] = { ...history[i], content: `${text}\n\n(先前回合附上的 ${count} 張圖片已從記憶中移除)` };
  }
  return history;
}

// 解析 Server-Sent Events:每個 "data: {...}" 交給 onData,遇到 [DONE] 結束。
async function readSse(body: any, onData: any) {
  const decoder = new TextDecoder();
  let buf = '';
  const handleLine = (line: any) => {
    if (!line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return true;
    try { onData(JSON.parse(payload)); } catch {}
    return false;
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: any;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (handleLine(line)) return;
    }
  }
  if (buf.trim()) handleLine(buf.trim());
}

export {
  OLLAMA_DEFAULT_BASE_URL,
  buildUserContent,
  canonicalModelId,
  compactHistoryImages,
  createOpenAIAdapter,
  discoverOllama,
  validateOpenAISpec,
  withLatestAlias,
};
