// OpenAI 相容 Chat Completions API 轉接器(DeepSeek、Kimi、Grok、OpenRouter、Ollama、LM Studio…)。
// 規格見 docs/adapters.md。

import crypto from 'crypto';
import fs from 'fs';
import { truncate, createStopHandle, formatTimeout, DEFAULT_TURN_TIMEOUT_MS, clampTimeout } from './process';
import { renderDeep } from './template';
import { findModel, resolveModelId, resolveEffort } from '../model-rules';
import { normalizeModels, normalizeCapabilities } from './spec';
import { fileToolDefinitions, fileToolReadDefinitions, FILE_TOOL_MAX_CALLS, FileToolSession, toTranscriptEntry } from './file-tools';
import type { AdapterCapabilities, Adapter, RunAttachment } from './types';
import { tx } from '../text';
import type { TextLocale } from '../text';
import type { ModelCapability } from '../ipc-types';

const MODELS_TTL_MS = 10 * 60 * 1000;
const MODELS_FETCH_TIMEOUT_MS = 8000;
// 模型能力的實際測試:本機大模型第一次載入可能要半分鐘以上
const PROBE_TIMEOUT_MS = 90000;
const PROBE_TOOL = { type: 'function', function: { name: 'ping', description: 'Reply to a ping.', parameters: { type: 'object', properties: {} } } };
// 1x1 的紅色 PNG
const PROBE_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// 逾時了:說出上限,並告訴使用者在哪裡調高——只說「逾時」的話,他不知道這是可以改的
function timeoutMessage(loc: TextLocale, timeoutMs: number): string {
  return `${tx(loc, 'api.runTimeout', { duration: formatTimeout(timeoutMs, loc) })} ${tx(loc, 'ext.timeoutHint')}`;
}

// 模型清單附帶的能力資料(OpenRouter:supported_parameters、architecture.input_modalities)。
// 沒有這些欄位就回 null——一般 OpenAI 相容端點的清單只有 id。
function capabilityFromListing(m: any): { tools?: boolean; images?: boolean } | null {
  const params = Array.isArray(m && m.supported_parameters) ? m.supported_parameters.map(String) : null;
  const inputs = Array.isArray(m && m.architecture && m.architecture.input_modalities) ? m.architecture.input_modalities.map(String) : null;
  if (!params && !inputs) return null;
  return { ...(params ? { tools: params.includes('tools') } : {}), ...(inputs ? { images: inputs.includes('image') } : {}) };
}
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

function validateOpenAISpec(spec: any, errors: any, locale: TextLocale = 'zh-Hant') {
  const e = (key: string, params: Record<string, string> = {}) => errors.push(tx(locale, key, params));
  if (typeof spec.baseUrl !== 'string' || !/^https?:\/\//.test(spec.baseUrl)) e('spec.baseUrl');
  if (spec.apiKeyEnv != null && typeof spec.apiKeyEnv !== 'string') e('spec.apiKeyEnv');
  if (spec.secretRef != null && (typeof spec.secretRef !== 'string' || !SECRET_REF_PATTERN.test(spec.secretRef))) e('spec.badFormat', { field: 'secretRef' });
  if (spec.apiKey != null) e('spec.plainApiKey');
  if (spec.headers != null && (typeof spec.headers !== 'object' || Array.isArray(spec.headers))) e('spec.mustBeObject', { field: 'headers' });
  if (spec.body != null && (typeof spec.body !== 'object' || Array.isArray(spec.body))) e('spec.mustBeObject', { field: 'body' });
  if (spec.effortBody != null && (typeof spec.effortBody !== 'object' || Array.isArray(spec.effortBody))) e('spec.mustBeObject', { field: 'effortBody' });
  if (spec.maxHistoryMessages != null && (!Number.isInteger(spec.maxHistoryMessages) || spec.maxHistoryMessages <= 0)) e('spec.mustBePositiveInt', { field: 'maxHistoryMessages' });
  if (spec.unreachableHint != null && typeof spec.unreachableHint !== 'string') e('spec.mustBeString', { field: 'unreachableHint' });
  if (spec.supportsEdit != null && typeof spec.supportsEdit !== 'boolean') e('spec.mustBeBoolean', { field: 'supportsEdit' });
  if (spec.fileTools != null && (!spec.fileTools || typeof spec.fileTools !== 'object' || Array.isArray(spec.fileTools))) e('spec.mustBeObject', { field: 'fileTools' });
  else if (spec.fileTools?.enabled != null && typeof spec.fileTools.enabled !== 'boolean') e('spec.mustBeBoolean', { field: 'fileTools.enabled' });
  if (spec.supportsEdit === true && spec.fileTools?.enabled !== true) e('spec.requiresTogether', { a: 'supportsEdit', b: 'fileTools.enabled' });
  if (spec.fileTools?.enabled === true && spec.supportsEdit !== true) e('spec.requiresTogether', { a: 'fileTools.enabled', b: 'supportsEdit' });
  if (spec.modelFilter != null) {
    try { new RegExp(spec.modelFilter); } catch (err: any) { e('spec.badRegex', { field: 'modelFilter', error: err.message }); }
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
        const listing = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
        const ids = listing
          .map((m: any) => (typeof m === 'string' ? m : m.id || m.name))
          .filter((id: any) => typeof id === 'string' && (!filter || filter.test(id)))
          .sort();
        // 有些端點(例如 OpenRouter)在模型清單裡就附了能力資料,不用另外花錢測
        const caps = new Map<string, { tools?: boolean; images?: boolean }>();
        for (const m of listing) {
          const id = m && typeof m === 'object' ? (m.id || m.name) : null;
          const cap = typeof id === 'string' ? capabilityFromListing(m) : null;
          if (cap) caps.set(id, cap);
        }
        fetched = {
          models: normalizeModels(ids.map((id: any) => ({
            ...withLatestAlias(id),
            ...(spec.efforts ? { efforts: spec.efforts } : {}),
          }))),
          at: Date.now(),
          error: null,
          pending: null,
          caps,
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
    endpoint: spec.baseUrl,
    resolveModel: (model: string) => resolveModelId(currentModels(), model || spec.defaultModel || ''),
    modelCapability,
    run: (agent: any, ctx: any) => runChat(agent, ctx),
  };
  return adapter;

  // ---------- 模型能力 ----------
  // 順序:實際測試(使用者按了才做)> 端點附帶的模型資料 > Ollama 的回報。
  // 付費端點不自動測:每開一次 app 就打一輪付費請求是不能接受的。
  async function modelCapability(model: string, { live = false }: { live?: boolean } = {}): Promise<ModelCapability | null> {
    if (!model) return null;
    if (live) return liveCapability(model);
    if (!staticModels) await refreshModels();
    const meta = fetched.caps && fetched.caps.get(model);
    if (meta) return { model, ...meta, source: 'metadata', at: Date.now() };
    return ollamaCapability(model);
  }

  // Ollama 的 POST /api/show 直接回報 capabilities(["completion", "tools", "vision"…]),免費而且精確。
  // 需要 key 的雲端端點不可能是本機 Ollama,不去打它。
  async function ollamaCapability(model: string): Promise<ModelCapability | null> {
    if (hasCredentialSetting) return null;
    const root = String(spec.baseUrl || '').replace(/\/v1\/?$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(joinUrl(root, '/api/show'), { method: 'POST', headers: headers(), body: JSON.stringify({ model }), signal: controller.signal });
      if (!res.ok) { await res.text().catch(() => ''); return null; }
      const data = await res.json();
      if (!Array.isArray(data && data.capabilities)) return null;
      const caps = data.capabilities.map(String);
      return { model, tools: caps.includes('tools'), images: caps.includes('vision'), source: 'ollama', at: Date.now() };
    } catch {
      return null; // 不是 Ollama,或連不上:就是不知道
    } finally {
      clearTimeout(timer);
    }
  }

  // 實際測試:先送一個最簡單的請求確認端點與模型本身能用,再分別帶工具、帶圖片各送一次。
  // 沒有基準請求的話,任何 400(例如參數不合)都會被誤判成「不支援工具」。
  async function liveCapability(model: string): Promise<ModelCapability> {
    const at = Date.now();
    if (missingRequiredApiKey()) return { model, source: 'probe', at, error: missingApiKeyMessage(spec, locale()) };
    const post = async (extra: any) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const body = { ...renderDeep(spec.body || {}, { model, effort: '', agentName: '' }), model, stream: false, ...extra };
        const res = await doFetch(joinUrl(spec.baseUrl, spec.path || '/chat/completions'), { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: controller.signal });
        const text = await res.text().catch(() => '');
        return { ok: res.ok, status: res.status, text };
      } catch (e: any) {
        return { ok: false, status: 0, text: e.name === 'AbortError' ? tx(locale(), 'api.connectionTimeout') : e.message };
      } finally {
        clearTimeout(timer);
      }
    };
    const base = await post({ messages: [{ role: 'user', content: 'Reply with OK.' }] });
    if (!base.ok) return { model, source: 'probe', at, error: base.status ? `HTTP ${base.status} ${truncate(base.text, 160)}` : base.text };
    // 2xx 就是收下了;被 4xx 拒絕才算不支援。其他狀況(5xx、逾時)不下結論
    const decide = (r: { ok: boolean; status: number }, rejects: number[]) => (r.ok ? true : rejects.includes(r.status) ? false : undefined);
    const tools = decide(await post({ messages: [{ role: 'user', content: 'Call the ping tool.' }], tools: [PROBE_TOOL], tool_choice: 'auto' }), [400, 404, 422]);
    const images = decide(await post({ messages: [{ role: 'user', content: [{ type: 'text', text: 'What color is this image? Answer in one word.' }, { type: 'image_url', image_url: { url: PROBE_PIXEL } }] }] }), [400, 415, 422]);
    return { model, source: 'probe', at, ...(tools !== undefined ? { tools } : {}), ...(images !== undefined ? { images } : {}) };
  }

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
    const timeoutMs = clampTimeout(spec.timeoutMs || ctx.timeoutMs || DEFAULT_TURN_TIMEOUT_MS);
    const reasoningFields = spec.reasoningFields || ['reasoning_content', 'reasoning'];

    // 寫入工具要三重閘門全開;唯讀工具(審查回合)只要端點支援工具呼叫就好——
    // 讀檔不改變任何東西,不需要改檔權限,也不需要另一位 reviewer。
    const writeTools = supportsFileTools && agent.canEdit === true && ctx.fileToolsEnabled === true;
    const readTools = supportsFileTools && ctx.readOnlyFileTools === true;
    const toolsEnabled = writeTools || readTools;
    let fileTools: FileToolSession | null = null;
    if (toolsEnabled) {
      try { fileTools = new FileToolSession(ctx.cwd, { readOnly: !writeTools, locale: ctx.locale || locale() }); }
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
        ...(fileTools ? { tools: fileTools.readOnly ? fileToolReadDefinitions(fileTools.locale) : fileToolDefinitions(fileTools.locale), tool_choice: 'auto' } : {}),
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
        if (timedOut) out.error = timeoutMessage(ctx.locale || locale(), timeoutMs);
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
      // 唯讀回合(審查)多給幾輪:一次只讀一個檔案的模型,讀完清單上十個檔案就用光 10 輪,
      // 整個審查被丟掉。讀檔不會改變任何東西,仍受工具次數上限與回合逾時約束。
      const maxApiRounds = fileTools && fileTools.readOnly ? FILE_TOOL_MAX_CALLS + 2 : 10;
      for (let apiRound = 0; apiRound < maxApiRounds; apiRound++) {
        if (Date.now() >= deadline) { error = timeoutMessage(ctx.locale || locale(), timeoutMs); break; }
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
          const entry = toTranscriptEntry(call.id, call.function?.name || '', call.function?.arguments || '{}', toolResult, ctx.locale || locale());
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
          const entry = toTranscriptEntry(call.id, name, args, toolResult, ctx.locale || locale());
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
      if (!error) error = tx(ctx.locale || locale(), 'api.toolRoundsExceeded', { n: maxApiRounds });
      return { text, thinking, usage, error, status, exchange, toolEvents };
    };

    let result = await runConversation(userContent);
    // 重送前清掉畫面上已經顯示的文字:被放棄的那次嘗試可能已經說了半句話,
    // 重送的結果若是空的,orchestrator 會把那半句話當成這回合的回覆。
    const restart = () => { ctx.onText(''); ctx.onThinking(''); };

    // 範本支援工具,不代表這位成員選的模型支援:同一個 Ollama 範本可以選到不收 tools 的模型,
    // 帶了 tools 的請求會直接被拒絕(Ollama 回 400,OpenRouter 回 404「沒有支援工具的端點」),整個審查失敗;
    // 有些端點則是讀過檔之後的下一個請求才被拒。唯讀回合(審查)被拒時不帶工具重送一次,
    // 並告訴模型這次沒有工具——要審的內容 orchestrator 已經附在提示詞裡。讀檔沒有副作用,
    // 所以即使已經讀過檔也可以整個重來;會改檔的回合不走這條路。
    // 這一步排在拿掉圖片之前:能看圖但不支援工具的模型,不該先白白丟掉圖片。
    let toolsNote = '';
    if (result.error && fileTools && fileTools.readOnly && [400, 404, 422].includes(result.status)) {
      ctx.onActivity({ id: 'tools-fallback', kind: 'note', title: tx(ctx.locale || locale(), 'api.readToolsFallback', { error: result.error.slice(0, 120) }), status: 'done' });
      fileTools = null;
      toolsNote = tx(ctx.locale || locale(), 'api.readToolsUnavailable');
      userContent = typeof userContent === 'string' ? `${userContent}\n\n${toolsNote}` : [...userContent, { type: 'text', text: toolsNote }];
      restart();
      result = await runConversation(userContent);
    }

    // 很多 OpenAI 相容端點(或同一家的純文字模型)不收 image_url,會直接回 4xx。
    // 帶了圖片才失敗時改用純文字重送一次，否則每回合都會重送同一張圖、一直失敗。
    const imageCount = Array.isArray(userContent) ? userContent.filter((p: any) => p.type === 'image_url').length : 0;
    // 已經改過檔案就不重來:4xx 不一定是圖片造成的(例如內容超過長度上限),整個回合重跑會把
    // 同一段修改再套用一次。寫入已經落盤、稽核紀錄也在,照實回報失敗,讓審查去看。
    const wrote = (result.toolEvents || []).some((e: any) => e.ok && e.name !== 'read_file');
    if (result.error && imageCount && !wrote && [400, 415, 422].includes(result.status)) {
      ctx.onActivity({ id: 'image-fallback', kind: 'note', title: tx(ctx.locale || locale(), 'api.imageFallback', { error: result.error.slice(0, 120), n: imageCount }), status: 'done' });
      // 走到這裡的第一輪只可能讀過檔、或寫入失敗(成功寫過檔的回合不重來)。這些紀錄照樣保留
      const executedBeforeRetry = result.toolEvents || [];
      userContent = toolsNote ? `${ctx.prompt}\n\n${toolsNote}` : ctx.prompt;
      restart();
      result = await runConversation(userContent);
      if (executedBeforeRetry.length) result.toolEvents = [...executedBeforeRetry, ...(result.toolEvents || [])];
    }

    let sessionId = ctx.sessionId || null;
    if (!result.error && spec.history !== false) {
      sessionId = sessionId || crypto.randomUUID();
      // 審查回合(唯讀)的工具往返只留最後的回答。會改檔的回合保留寫入的呼叫:
      // 修復回合沒有工具可以重讀,成員只能從記憶裡看到自己寫了什麼。
      const exchange = readTools && !writeTools ? collapseToolTurn(result.exchange, result.text) : result.exchange;
      const turn = forgetEphemeral(exchange, ctx.ephemeral, tx(ctx.locale || locale(), 'api.ephemeralDropped'));
      sessions.set(sessionId, compactHistoryImages(compactHistoryTools(trimHistory([...history, ...turn], maxHistory), ctx.locale || locale()), ctx.locale || locale()));
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

// 審查回合存進記憶時只留下「使用者的訊息 + 最後的回答」。
// 一回合的讀檔往返會產生好幾對「助理呼叫 + 工具結果」:讀七個檔案就是十四則。記憶依則數裁切
// (Ollama 範本只留 16 則),它們會把之前的討論與任務整個擠掉,而成員之後只會收到沒看過的新訊息,
// 等於永久失去前情。審查讀過什麼,之後用不到。
function collapseToolTurn(exchange: any[], text: string) {
  if (!exchange.some((m) => m && m.role === 'tool')) return exchange;
  return [exchange[0], { role: 'assistant', content: text || '' }];
}

// 依則數裁切歷史,可能切在「助理發出工具呼叫」與「工具結果」之間,讓開頭留下沒有對應
// 呼叫的 tool 訊息。OpenAI 規格不接受這種訊息,嚴格的端點(DeepSeek、OpenRouter…)會以 400
// 拒絕這位成員之後的每一個回合。裁完之後把開頭孤立的 tool 訊息丟掉。
// (實測 Ollama 會接受,但不能依賴寬鬆的端點。)
function trimHistory(history: any[], max: number) {
  const kept = history.slice(-max);
  let start = 0;
  while (start < kept.length && kept[start] && kept[start].role === 'tool') start++;
  return kept.slice(start);
}

// 讀檔結果一則可能就幾十 KB。存進歷史的話,之後的每一個回合都會整包重送。
// 之後需要時可以重讀,所以存進歷史時只留路徑與雜湊,把檔案內容拿掉;寫入的呼叫(成員自己寫的內容)不動。
const TOOL_HISTORY_MAX_CHARS = 2000;
function compactHistoryTools(history: any[], loc: TextLocale = 'zh-Hant') {
  return history.map((m) => {
    if (!m || m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= TOOL_HISTORY_MAX_CHARS) return m;
    try {
      const result = JSON.parse(m.content);
      if (result && typeof result.content === 'string') {
        return { ...m, content: JSON.stringify({ ...result, content: tx(loc, 'api.readDropped', { n: result.content.length }) }) };
      }
    } catch {}
    return { ...m, content: `${m.content.slice(0, TOOL_HISTORY_MAX_CHARS)}${tx(loc, 'api.toolTruncated')}` };
  });
}

// 只屬於這一回合的內容(審查時附上的檔案)存進記憶前換成一行說明
function forgetEphemeral(exchange: any[], ephemeral: string | undefined, placeholder: string) {
  if (!ephemeral) return exchange;
  const strip = (text: string) => (text.includes(ephemeral) ? text.split(ephemeral).join(placeholder) : text);
  return exchange.map((m) => {
    if (!m || m.role !== 'user') return m;
    if (typeof m.content === 'string') return { ...m, content: strip(m.content) };
    if (Array.isArray(m.content)) return { ...m, content: m.content.map((p: any) => (p && p.type === 'text' && typeof p.text === 'string' ? { ...p, text: strip(p.text) } : p)) };
    return m;
  });
}

// 對話記憶裡只保留最近一則帶圖訊息的影像資料，更早的換成文字佔位。
// 否則每張 base64 圖片會在記憶中留到 maxHistory 則，並在之後每一回合重送。
function compactHistoryImages(history: any, loc: TextLocale = 'zh-Hant') {
  let keptLatest = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const content = history[i].content;
    if (!Array.isArray(content) || !content.some((p: any) => p && p.type === 'image_url')) continue;
    if (!keptLatest) { keptLatest = true; continue; }
    const count = content.filter((p: any) => p && p.type === 'image_url').length;
    const text = content.filter((p: any) => p && p.type === 'text').map((p: any) => p.text).join('\n');
    history[i] = { ...history[i], content: `${text}\n\n${tx(loc, 'api.imagesDropped', { n: count })}` };
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
