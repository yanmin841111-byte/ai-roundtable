// 用 JSON 描述的 CLI 轉接器。規格見 docs/adapters.md。

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { runProcess, parseJson, truncate, checkCli } from './process';
import { getPath, render, buildArgs, matches } from './template';
import { resolveModelId, resolveEffort } from '../model-rules';
import { normalizeModels, normalizeCapabilities } from './spec';

const TEXT_MODES = ['append', 'replace', 'message'];

function validateCliSpec(spec: any, errors: any) {
  if (typeof spec.bin !== 'string' || !spec.bin.trim()) errors.push('bin 必須是指令名稱或路徑');
  if (spec.args != null && !Array.isArray(spec.args)) errors.push('args 必須是陣列');
  if (spec.input != null && !['stdin', 'arg', 'file', 'none'].includes(spec.input)) errors.push('input 必須是 stdin、arg、file 或 none');
  if (spec.systemPrompt != null && !['prepend', 'arg', 'none'].includes(spec.systemPrompt)) errors.push('systemPrompt 必須是 prepend、arg 或 none');
  const out = spec.output || {};
  if (out.format != null && !['text', 'jsonl', 'json'].includes(out.format)) errors.push('output.format 必須是 text、jsonl 或 json');
  if (out.rules != null && !Array.isArray(out.rules)) errors.push('output.rules 必須是陣列');
  (out.rules || []).forEach((r: any, i: any) => {
    if (!r || typeof r !== 'object') { errors.push(`output.rules[${i}] 必須是物件`); return; }
    for (const key of ['mode', 'thinkingMode']) {
      if (r[key] != null && !TEXT_MODES.includes(r[key])) errors.push(`output.rules[${i}].${key} 必須是 ${TEXT_MODES.join('、')}`);
    }
  });
  if (out.sessionIdPattern != null) {
    try { new RegExp(out.sessionIdPattern); } catch (e: any) { errors.push(`output.sessionIdPattern 不是有效的正規表示式:${e.message}`); }
  }
  if (spec.env != null && (typeof spec.env !== 'object' || Array.isArray(spec.env))) errors.push('env 必須是物件');
}

function createCliAdapter(spec: any) {
  const out = spec.output || {};
  const format = out.format || 'text';
  const rules = out.rules || [];
  const hasSessionRule = rules.some((r: any) => r.sessionId) || !!out.sessionIdPattern;
  const models = normalizeModels(spec.models);

  return {
    id: spec.id,
    label: spec.label || spec.id,
    type: 'cli',
    description: spec.description || '',
    bin: spec.bin,
    supportsResume: spec.supportsResume != null ? !!spec.supportsResume : hasSessionRule,
    supportsEdit: spec.supportsEdit != null ? !!spec.supportsEdit : true,
    efforts: spec.efforts || [],
    usageShape: spec.usageShape || null, // 沒填就交給 usage.js 依欄位特徵判斷
    capabilities: normalizeCapabilities(spec.capabilities, ['filePath']),
    listModels: () => ({ models, source: models.length ? 'config' : 'none' }),
    check: () => (spec.versionArgs === false ? Promise.resolve({ ok: true, version: '(略過檢查)' }) : checkCli(spec.bin, spec.versionArgs === null ? null : spec.versionArgs || ['--version'])),
    run: (agent: any, ctx: any) => runCli(spec, { format, rules, models }, agent, ctx),
  };
}

async function runCli(spec: any, { format, rules, models }: any, agent: any, ctx: any) {
  const out = spec.output || {};
  const input = spec.input || 'stdin';
  const systemMode = spec.systemPrompt || 'prepend';
  const model = agent.model ? resolveModelId(models, agent.model) : '';
  const effortResult = resolveEffort(models, model, agent.effort);
  if (effortResult.note) ctx.onActivity({ id: 'run-options', kind: 'note', title: effortResult.note, status: 'done' });

  // 沒有續接時(或不支援續接),角色設定要跟著提示詞一起送
  let prompt = ctx.prompt;
  if (systemMode === 'prepend' && ctx.systemPrompt && !ctx.sessionId) prompt = `${ctx.systemPrompt}\n\n---\n\n${prompt}`;

  let promptFile = '';
  if (input === 'file') {
    promptFile = path.join(os.tmpdir(), `ai-roundtable-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(promptFile, prompt);
  }

  const vars = {
    prompt: input === 'arg' ? prompt : '',
    promptFile,
    systemPrompt: systemMode === 'arg' ? ctx.systemPrompt || '' : '',
    model,
    effort: effortResult.effort || '',
    sessionId: ctx.sessionId || '',
    cwd: ctx.cwd,
    canEdit: !!agent.canEdit,
    agentName: agent.name || '',
  };
  const args = buildArgs(spec.args || [], vars);
  const env = spec.env ? Object.fromEntries(Object.entries(spec.env).map(([k, v]: any) => [k, render(v, vars)])) : null;

  const state: any = { text: '', thinking: '', sessionId: ctx.sessionId || null, usage: null, error: null, actSeq: 0 };
  let stdout = '';
  const stdoutLimit = 2 * 1024 * 1024;

  const applyEvent = (ev: any) => {
    for (const rule of rules) {
      if (!matches(ev, rule.match)) continue;
      const items = rule.each ? getPath(ev, rule.each) : [ev];
      for (const item of Array.isArray(items) ? items : []) applyRule(rule, item, ev, state, ctx);
    }
  };

  let res: any;
  try {
    res = await runProcess(spec.bin, args, {
      cwd: ctx.cwd,
      stdin: input === 'stdin' ? prompt : null,
      env,
      shell: !!spec.shell,
      timeoutMs: spec.timeoutMs || ctx.timeoutMs,
    }, {
      onProc: ctx.onProc,
      onStderr: (d: any) => { if (out.sessionIdPattern) stdout += d; },
      onLine: (line: any) => {
        if (stdout.length < stdoutLimit) stdout += line + '\n';
        if (format === 'text') {
          state.text += (state.text ? '\n' : '') + line;
          ctx.onText(state.text);
        } else if (format === 'jsonl') {
          const ev = parseJson(line);
          if (ev && typeof ev === 'object') applyEvent(ev);
          else if (out.nonJsonLines === 'text') { state.text += (state.text ? '\n' : '') + line; ctx.onText(state.text); }
        }
      },
    });
  } finally {
    if (promptFile) fs.rm(promptFile, { force: true }, () => {});
  }

  if (format === 'json') {
    const data = parseJson(stdout.trim());
    if (data && typeof data === 'object') (Array.isArray(data) ? data : [data]).forEach(applyEvent);
    else if (stdout.trim()) state.error = state.error || `無法解析 JSON 輸出:${truncate(stdout, 500)}`;
  }

  if (out.sessionIdPattern && !state.sessionId) {
    const m = stdout.match(new RegExp(out.sessionIdPattern));
    if (m) { state.sessionId = m[1] || m[0]; ctx.onSession(state.sessionId); }
  }

  const okCodes = spec.successExitCodes || [0];
  let error = state.error;
  if (res.spawnError) error = `無法啟動 ${spec.bin}:${truncate(res.stderr, 1000)}`;
  else if (res.timedOut) error = res.error || `${spec.bin} 執行逾時`;
  else if (!okCodes.includes(res.code) && !state.text) error = error || `${spec.bin} 結束代碼 ${res.code}\n${truncate(res.stderr, 2000)}`;
  return { text: state.text, thinking: state.thinking, sessionId: state.sessionId, usage: state.usage, error };
}

function mergeText(current: any, piece: any, mode: any) {
  if (piece == null || piece === '') return current;
  const s = typeof piece === 'string' ? piece : JSON.stringify(piece);
  if (mode === 'replace') return s;
  if (mode === 'message') return current ? `${current}\n\n${s}` : s;
  return current + s;
}

function applyRule(rule: any, item: any, event: any, state: any, ctx: any) {
  const scope = { ...item, $event: event };
  if (rule.text) {
    const next = mergeText(state.text, getPath(scope, rule.text), rule.mode || 'append');
    if (next !== state.text) { state.text = next; ctx.onText(state.text); }
  }
  if (rule.thinking) {
    const next = mergeText(state.thinking, getPath(scope, rule.thinking), rule.thinkingMode || rule.mode || 'append');
    if (next !== state.thinking) { state.thinking = next; ctx.onThinking(state.thinking); }
  }
  if (rule.sessionId) {
    const id = getPath(scope, rule.sessionId);
    if (id && id !== state.sessionId) { state.sessionId = String(id); ctx.onSession(state.sessionId); }
  }
  if (rule.usage) {
    const usage = getPath(scope, rule.usage);
    if (usage && typeof usage === 'object') state.usage = usage;
  }
  if (rule.error) {
    const e = getPath(scope, rule.error);
    state.error = e == null ? JSON.stringify(item) : (typeof e === 'string' ? e : JSON.stringify(e));
  }
  if (rule.activity) {
    const a = rule.activity;
    const id = a.id ? render(a.id, scope) : `act-${++state.actSeq}`;
    const activity: any = { id, kind: 'tool' };
    for (const key of ['title', 'detail', 'result', 'status']) {
      if (a[key] != null) activity[key] = truncate(render(a[key], scope), key === 'title' ? 200 : 1500);
    }
    if (!activity.status) activity.status = 'done';
    ctx.onActivity(activity);
  }
}

export { createCliAdapter, validateCliSpec };
