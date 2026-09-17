'use strict';
// OpenAI 相容 Chat Completions API 轉接器(DeepSeek、Kimi、Grok、OpenRouter、Ollama、LM Studio…)。
// 規格見 docs/adapters.md。

const crypto = require('crypto');
const fs = require('fs');
const { truncate, createStopHandle, formatTimeout, DEFAULT_TURN_TIMEOUT_MS } = require('./process');
const { renderDeep } = require('./template');
const { resolveModelId, resolveEffort } = require('../model-rules');
const { normalizeModels, normalizeCapabilities } = require('./spec');

const MODELS_TTL_MS = 10 * 60 * 1000;
const MODELS_FETCH_TIMEOUT_MS = 8000;
const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

function validateOpenAISpec(spec: any, errors: any) {
  if (typeof spec.baseUrl !== 'string' || !/^https?:\/\//.test(spec.baseUrl)) errors.push('baseUrl 必須是 http:// 或 https:// 開頭的網址');
  if (spec.apiKeyEnv != null && typeof spec.apiKeyEnv !== 'string') errors.push('apiKeyEnv 必須是環境變數名稱');
  if (spec.secretRef != null && (typeof spec.secretRef !== 'string' || !SECRET_REF_PATTERN.test(spec.secretRef))) errors.push('secretRef 格式不正確');
  if (spec.apiKey != null) errors.push('apiKey 明文欄位已停用，請在擴充設定的 API key 欄位安全移轉');
  if (spec.headers != null && (typeof spec.headers !== 'object' || Array.isArray(spec.headers))) errors.push('headers 必須是物件');
  if (spec.body != null && (typeof spec.body !== 'object' || Array.isArray(spec.body))) errors.push('body 必須是物件');
  if (spec.effortBody != null && (typeof spec.effortBody !== 'object' || Array.isArray(spec.effortBody))) errors.push('effortBody 必須是物件');
  if (spec.modelFilter != null) {
    try { new RegExp(spec.modelFilter); } catch (e: any) { errors.push(`modelFilter 不是有效的正規表示式:${e.message}`); }
  }
}

function joinUrl(base: any, p: any) {
  return base.replace(/\/+$/, '') + '/' + String(p).replace(/^\/+/, '');
}

function missingApiKeyMessage(spec: any) {
  return spec.apiKeyEnv
    ? `缺少 API key:請到「設定 → CLI 與擴充」填入,或設定環境變數 ${spec.apiKeyEnv}`
    : '缺少 API key:請到「設定 → CLI 與擴充」填入並儲存';
}

function buildUserContent(prompt: any, attachments: any, capabilities: any) {
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

function createOpenAIAdapter(spec: any, { fetchImpl, getSecret }: any = {}) {
  const doFetch: any = fetchImpl || ((...a: Parameters<typeof fetch>) => fetch(...a));
  const staticModels = spec.models === 'auto' ? null : normalizeModels(spec.models);
  const sessions = new Map(); // sessionId -> [{ role, content }]
  const maxHistory = spec.maxHistoryMessages || 80;
  // 沒宣告時只送文字:很多相容端點(DeepSeek、多數 Ollama 模型)不收圖片。支援圖片的請在設定加上 imageInline。
  const capabilities = normalizeCapabilities(spec.capabilities, ['textInline']);
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
        fetched = { models: normalizeModels(ids.map((id: any) => ({ id, ...(spec.efforts ? { efforts: spec.efforts } : {}) }))), at: Date.now(), error: null, pending: null };
      } catch (e: any) {
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
    capabilities,
    listModels: () => {
      if (staticModels) return { models: staticModels, source: 'config' };
      return { models: fetched.models, source: fetched.error ? 'error' : fetched.at ? 'api' : 'loading', error: fetched.error };
    },
    refreshModels,
    check: async () => {
      if ((spec.secretRef || spec.apiKeyEnv) && !apiKey()) return { ok: false, error: missingApiKeyMessage(spec) };
      return { ok: true, version: `API ${spec.baseUrl}` };
    },
    testConnection: async () => {
      if ((spec.secretRef || spec.apiKeyEnv) && !apiKey()) return { ok: false, error: missingApiKeyMessage(spec) };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
      try {
        const res = await doFetch(joinUrl(spec.baseUrl, spec.modelsPath || '/models'), { headers: headers(), signal: controller.signal });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${truncate(await res.text(), 200)}` };
        return { ok: true, version: `已連線 ${spec.baseUrl}` };
      } catch (e: any) {
        return { ok: false, error: e.name === 'AbortError' ? '測試連線逾時' : e.message };
      } finally {
        clearTimeout(timer);
      }
    },
    run: (agent: any, ctx: any) => runChat(agent, ctx),
  };

  async function runChat(agent: any, ctx: any) {
    if ((spec.secretRef || spec.apiKeyEnv) && !apiKey() && !spec.apiKeyOptional) {
      return { text: '', thinking: '', sessionId: null, usage: null, error: missingApiKeyMessage(spec) };
    }
    const models = currentModels();
    const model = resolveModelId(models, agent.model || spec.defaultModel || '');
    if (!model) return { text: '', thinking: '', sessionId: null, usage: null, error: '沒有指定模型:請在成員設定選擇模型,或在擴充設定填 defaultModel' };
    const eff = resolveEffort(models, model, agent.effort);
    if (eff.note) ctx.onActivity({ id: 'run-options', kind: 'note', title: eff.note, status: 'done' });

    const history = (spec.history !== false && ctx.sessionId && sessions.get(ctx.sessionId)) || [];
    const vars = { model, effort: eff.effort || '', agentName: agent.name || '' };
    const effortBody = spec.effortBody || { reasoning_effort: '{effort}' };
    const stream = spec.stream !== false;
    const timeoutMs = spec.timeoutMs || ctx.timeoutMs || DEFAULT_TURN_TIMEOUT_MS;
    const reasoningFields = spec.reasoningFields || ['reasoning_content', 'reasoning'];

    const request = async (userContent: any) => {
      const messages: any[] = [];
      if (ctx.systemPrompt) messages.push({ role: spec.systemRole || 'system', content: ctx.systemPrompt });
      messages.push(...history, { role: 'user', content: userContent });
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
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const out: any = { text: '', thinking: '', usage: null, error: null, status: 0 };

      const onChunk = (data: any) => {
        if (data.error) { out.error = data.error.message || JSON.stringify(data.error); return; }
        if (data.usage) out.usage = data.usage;
        const choice = data.choices && data.choices[0];
        if (!choice) return;
        const part = choice.delta || choice.message || {};
        if (typeof part.content === 'string' && part.content) { out.text += part.content; ctx.onText(out.text); }
        for (const f of reasoningFields) {
          if (typeof part[f] === 'string' && part[f]) { out.thinking += part[f]; ctx.onThinking(out.thinking); break; }
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
        if (timedOut) out.error = `API 執行逾時(${formatTimeout(timeoutMs)})`;
        else if (e.name === 'AbortError') out.error = out.error || '已停止';
        else out.error = `無法連線到 ${spec.baseUrl}:${e.cause ? e.cause.message || e.cause.code : e.message}`;
      } finally {
        clearTimeout(timer);
        handle.close();
      }
      return out;
    };

    let userContent = buildUserContent(ctx.prompt, ctx.attachments, capabilities);
    let result = await request(userContent);
    // 很多 OpenAI 相容端點(或同一家的純文字模型)不收 image_url,會直接回 4xx。
    // 帶了圖片才失敗時改用純文字重送一次，否則每回合都會重送同一張圖、一直失敗。
    const imageCount = Array.isArray(userContent) ? userContent.filter((p: any) => p.type === 'image_url').length : 0;
    if (result.error && imageCount && [400, 415, 422].includes(result.status)) {
      ctx.onActivity({ id: 'image-fallback', kind: 'note', title: `此模型不接受圖片(${result.error.slice(0, 120)}),已略過 ${imageCount} 張圖片改用純文字重送`, status: 'done' });
      userContent = ctx.prompt;
      result = await request(userContent);
    }

    let sessionId = ctx.sessionId || null;
    if (!result.error && spec.history !== false) {
      sessionId = sessionId || crypto.randomUUID();
      const next = [...history, { role: 'user', content: userContent }, { role: 'assistant', content: result.text }];
      sessions.set(sessionId, compactHistoryImages(next.slice(-maxHistory)));
      ctx.onSession(sessionId);
    }
    return { text: result.text, thinking: result.thinking, sessionId, usage: result.usage, error: result.error };
  }
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

module.exports = { createOpenAIAdapter, validateOpenAISpec, buildUserContent, compactHistoryImages };
