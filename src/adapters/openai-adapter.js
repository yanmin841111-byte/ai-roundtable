'use strict';
// OpenAI 相容 Chat Completions API 轉接器(DeepSeek、Kimi、Grok、OpenRouter、Ollama、LM Studio…)。
// 規格見 docs/adapters.md。

const crypto = require('crypto');
const { truncate, createStopHandle, formatTimeout, DEFAULT_TURN_TIMEOUT_MS } = require('./process');
const { renderDeep } = require('./template');
const { resolveModelId, resolveEffort } = require('../model-rules');
const { normalizeModels } = require('./spec');

const MODELS_TTL_MS = 10 * 60 * 1000;
const MODELS_FETCH_TIMEOUT_MS = 8000;

function validateOpenAISpec(spec, errors) {
  if (typeof spec.baseUrl !== 'string' || !/^https?:\/\//.test(spec.baseUrl)) errors.push('baseUrl 必須是 http:// 或 https:// 開頭的網址');
  if (spec.apiKeyEnv != null && typeof spec.apiKeyEnv !== 'string') errors.push('apiKeyEnv 必須是環境變數名稱');
  if (spec.headers != null && (typeof spec.headers !== 'object' || Array.isArray(spec.headers))) errors.push('headers 必須是物件');
  if (spec.body != null && (typeof spec.body !== 'object' || Array.isArray(spec.body))) errors.push('body 必須是物件');
  if (spec.effortBody != null && (typeof spec.effortBody !== 'object' || Array.isArray(spec.effortBody))) errors.push('effortBody 必須是物件');
  if (spec.modelFilter != null) {
    try { new RegExp(spec.modelFilter); } catch (e) { errors.push(`modelFilter 不是有效的正規表示式:${e.message}`); }
  }
}

function joinUrl(base, p) {
  return base.replace(/\/+$/, '') + '/' + String(p).replace(/^\/+/, '');
}

function createOpenAIAdapter(spec, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const staticModels = spec.models === 'auto' ? null : normalizeModels(spec.models);
  const sessions = new Map(); // sessionId -> [{ role, content }]
  const maxHistory = spec.maxHistoryMessages || 80;
  let fetched = { models: [], at: 0, error: null, pending: null };

  const apiKey = () => spec.apiKey || (spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : '') || '';
  const headers = () => {
    const h = { 'Content-Type': 'application/json', ...(spec.headers || {}) };
    const key = apiKey();
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  };
  const currentModels = () => staticModels || fetched.models;

  async function refreshModels(force = false) {
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
          .map((m) => (typeof m === 'string' ? m : m.id || m.name))
          .filter((id) => typeof id === 'string' && (!filter || filter.test(id)))
          .sort();
        fetched = { models: normalizeModels(ids.map((id) => ({ id, ...(spec.efforts ? { efforts: spec.efforts } : {}) }))), at: Date.now(), error: null, pending: null };
      } catch (e) {
        fetched = { ...fetched, at: Date.now(), error: e.name === 'AbortError' ? '取得模型清單逾時' : e.message, pending: null };
      } finally {
        clearTimeout(timer);
      }
    })();
    return fetched.pending;
  }

  return {
    id: spec.id,
    label: spec.label || spec.id,
    type: 'openai',
    description: spec.description || '',
    bin: null,
    supportsResume: spec.history !== false,
    supportsEdit: false,
    efforts: spec.efforts || [],
    usageShape: 'openai', // OpenAI 相容端點:prompt_tokens 已含快取,cached 在 prompt_tokens_details
    listModels: () => {
      if (staticModels) return { models: staticModels, source: 'config' };
      return { models: fetched.models, source: fetched.error ? 'error' : fetched.at ? 'api' : 'loading', error: fetched.error };
    },
    refreshModels,
    check: async () => {
      if (spec.apiKeyEnv && !apiKey()) return { ok: false, error: `缺少環境變數 ${spec.apiKeyEnv}` };
      return { ok: true, version: `API ${spec.baseUrl}` };
    },
    run: (agent, ctx) => runChat(agent, ctx),
  };

  async function runChat(agent, ctx) {
    if (spec.apiKeyEnv && !apiKey() && !spec.apiKeyOptional) {
      return { text: '', thinking: '', sessionId: null, usage: null, error: `缺少 API key:請設定環境變數 ${spec.apiKeyEnv},或在擴充設定填 apiKey` };
    }
    const models = currentModels();
    const model = resolveModelId(models, agent.model || spec.defaultModel || '');
    if (!model) return { text: '', thinking: '', sessionId: null, usage: null, error: '沒有指定模型:請在成員設定選擇模型,或在擴充設定填 defaultModel' };
    const eff = resolveEffort(models, model, agent.effort);
    if (eff.note) ctx.onActivity({ id: 'run-options', kind: 'note', title: eff.note, status: 'done' });

    const history = (spec.history !== false && ctx.sessionId && sessions.get(ctx.sessionId)) || [];
    const messages = [];
    if (ctx.systemPrompt) messages.push({ role: spec.systemRole || 'system', content: ctx.systemPrompt });
    messages.push(...history, { role: 'user', content: ctx.prompt });

    const vars = { model, effort: eff.effort || '', agentName: agent.name || '' };
    const effortBody = spec.effortBody || { reasoning_effort: '{effort}' };
    const stream = spec.stream !== false;
    const body = {
      ...renderDeep(spec.body || {}, vars),
      ...(eff.effort ? renderDeep(effortBody, vars) : {}),
      model,
      messages,
      stream,
      ...(stream && spec.streamUsage !== false ? { stream_options: { include_usage: true } } : {}),
    };

    const controller = new AbortController();
    const handle = createStopHandle(() => controller.abort());
    ctx.onProc(handle);
    const timeoutMs = spec.timeoutMs || ctx.timeoutMs || DEFAULT_TURN_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    let text = '';
    let thinking = '';
    let usage = null;
    let error = null;
    const reasoningFields = spec.reasoningFields || ['reasoning_content', 'reasoning'];

    const onChunk = (data) => {
      if (data.error) { error = data.error.message || JSON.stringify(data.error); return; }
      if (data.usage) usage = data.usage;
      const choice = data.choices && data.choices[0];
      if (!choice) return;
      const part = choice.delta || choice.message || {};
      if (typeof part.content === 'string' && part.content) { text += part.content; ctx.onText(text); }
      for (const f of reasoningFields) {
        if (typeof part[f] === 'string' && part[f]) { thinking += part[f]; ctx.onThinking(thinking); break; }
      }
    };

    try {
      const res = await doFetch(joinUrl(spec.baseUrl, spec.path || '/chat/completions'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const raw = await res.text();
        let msg = raw;
        try { const j = JSON.parse(raw); msg = (j.error && (j.error.message || j.error)) || j.message || raw; } catch {}
        error = `HTTP ${res.status}:${truncate(typeof msg === 'string' ? msg : JSON.stringify(msg), 800)}`;
      } else if (stream && res.body) {
        await readSse(res.body, onChunk);
      } else {
        onChunk(await res.json());
      }
    } catch (e) {
      if (timedOut) error = `API 執行逾時(${formatTimeout(timeoutMs)})`;
      else if (e.name === 'AbortError') error = error || '已停止';
      else error = `無法連線到 ${spec.baseUrl}:${e.cause ? e.cause.message || e.cause.code : e.message}`;
    } finally {
      clearTimeout(timer);
      handle.close();
    }

    let sessionId = ctx.sessionId || null;
    if (!error && spec.history !== false) {
      sessionId = sessionId || crypto.randomUUID();
      const next = [...history, { role: 'user', content: ctx.prompt }, { role: 'assistant', content: text }];
      sessions.set(sessionId, next.slice(-maxHistory));
      ctx.onSession(sessionId);
    }
    return { text, thinking, sessionId, usage, error };
  }
}

// 解析 Server-Sent Events:每個 "data: {...}" 交給 onData,遇到 [DONE] 結束。
async function readSse(body, onData) {
  const decoder = new TextDecoder();
  let buf = '';
  const handleLine = (line) => {
    if (!line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return true;
    try { onData(JSON.parse(payload)); } catch {}
    return false;
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (handleLine(line)) return;
    }
  }
  if (buf.trim()) handleLine(buf.trim());
}

module.exports = { createOpenAIAdapter, validateOpenAISpec };
