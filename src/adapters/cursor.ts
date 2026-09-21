// Cursor CLI(指令 cursor-agent)轉接器。
//
// 依 cursor-agent 2026.09 實測的 `-p --output-format stream-json --stream-partial-output` 輸出撰寫:
//   {"type":"system","subtype":"init","session_id":...}
//   {"type":"thinking","subtype":"delta","text":...}            思考片段;subtype "completed" 表示一段結束
//   {"type":"assistant","message":{content:[{text}]},"timestamp_ms":...}   回覆片段
//   {"type":"assistant","message":{content:[{text}]}}           同一段的完整文字,代表這段結束。
//                                                               通常沒有 timestamp_ms,但實測也會帶,所以另外比對內容
//   {"type":"tool_call","subtype":"started"|"completed","call_id":...,"tool_call":{"readToolCall":{args,result}}}
//   {"type":"result","is_error":false,"result":...,"session_id":...,"usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}
//
// 強度寫在模型名稱裡(例如 claude-opus-5-thinking-high),所以轉接器本身沒有強度選項。
// Cursor 沒有系統提示參數,角色設定在第一回合接在提示詞前面;之後用 --resume 續接。

import { runProcess, parseJson, truncate, checkCli } from './process';
import { resolveModelId } from '../model-rules';
import type { AgentConfig } from '../ipc-types';
import type { Adapter, RunContext, RunResult } from './types';
import { tx, type TextLocale } from '../text';

const MODELS_TTL_MS = 10 * 60 * 1000;
const NOT_FOUND = 127;
const MODELS_TIMEOUT_MS = 30 * 1000;
const FALLBACK_MODELS = [{ id: 'auto', label: 'Auto', description: 'Cursor 自動選擇模型', efforts: [], defaultEffort: '', aliases: [] }];

// `cursor-agent --list-models` 的輸出:每行「id - 顯示名稱」,預設模型會標 (default)。
function parseCursorModels(output: any) {
  const models: any[] = [];
  const seen = new Set();
  for (const raw of String(output || '').split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    const m = line.match(/^([A-Za-z0-9][\w.\-:[\]=,]*)\s+-\s+(.+)$/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const isDefault = /\(default\)\s*$/i.test(m[2]);
    const label = m[2].replace(/\s*\(default\)\s*$/i, '').trim() || m[1];
    models.push({ id: m[1], label, description: isDefault ? 'Cursor 預設模型' : '', efforts: [], defaultEffort: '', aliases: [] });
  }
  return models;
}

// 工具名稱轉成對話裡顯示的標題,例如 readToolCall → 讀取檔案:path
function describeCursorTool(key: any, args: any = {}, locale: TextLocale = 'zh-Hant') {
  const name = String(key || '').replace(/ToolCall$/, '');
  switch (name) {
    case 'shell': return tx(locale, 'act.run', { detail: truncate(args.command, 120) });
    case 'read': return tx(locale, 'act.read', { detail: args.path || '' });
    case 'edit': return tx(locale, 'act.edit', { detail: args.path || '' });
    case 'write': return tx(locale, 'act.write', { detail: args.path || '' });
    case 'delete': return tx(locale, 'act.delete', { detail: args.path || '' });
    case 'glob': return tx(locale, 'act.glob', { detail: args.globPattern || args.pattern || '' });
    case 'grep': return tx(locale, 'act.grep', { detail: args.pattern || '' });
    case 'ls': return tx(locale, 'act.ls', { detail: args.path || '' });
    default: return tx(locale, 'act.tool', { detail: name || 'unknown' });
  }
}

// 精簡工具結果:優先取常見的文字欄位,其餘轉成 JSON。
function toolResultText(result: any) {
  if (!result || typeof result !== 'object') return { status: 'done', text: '' };
  const body = result.success || result.error || result.rejected || result;
  const status = result.success ? 'done' : 'error';
  if (body && typeof body === 'object') {
    for (const key of ['content', 'interleavedOutput', 'stdout', 'diffString', 'message', 'error']) {
      if (typeof body[key] === 'string' && body[key]) {
        const extra = key === 'stdout' && body.stderr ? `\n${body.stderr}` : '';
        const exit = body.exitCode != null && body.exitCode !== 0 ? 'error' : status;
        return { status: exit, text: body[key] + extra };
      }
    }
    if (body.exitCode != null) return { status: body.exitCode === 0 ? status : 'error', text: `exit ${body.exitCode}` };
  }
  return { status, text: JSON.stringify(body) };
}

// cursor-agent 是 Node 程式,stdout 是非阻塞 pipe 時會在寫完前就結束行程:
// 在 Electron 主程序裡實測 --list-models 固定在約 8KB 處被截斷,回合最後的 result 事件也可能遺失。
// 透過 sh 接一層 cat,讓它寫進一般的阻塞 pipe;pipefail 保留 cursor-agent 自己的結束代碼。
function viaShell(bin: string, args: readonly string[]): [string, string[]] {
  return ['/bin/sh', ['-c', 'set -o pipefail; "$0" "$@" | cat', bin, ...args]];
}

function createCursorAdapter({ bin = 'cursor-agent' }: { bin?: string } = {}): Adapter {
  let fetched: any = { models: null, at: 0, error: null, pending: null };

  async function refreshModels(force: any = false) {
    if (!force && fetched.at && Date.now() - fetched.at < MODELS_TTL_MS) return;
    if (fetched.pending) return fetched.pending;
    fetched.pending = (async () => {
      let out = '';
      const res = await runProcess(...viaShell(bin, ['--list-models']), { timeoutMs: MODELS_TIMEOUT_MS, killGraceMs: 1000 }, {
        onLine: (line: any) => { out += line + '\n'; },
      });
      const models = parseCursorModels(out);
      let error: any = null;
      if (res.spawnError || res.code === NOT_FOUND) error = `找不到指令 ${bin}`;
      else if (res.timedOut) error = '取得模型清單逾時';
      else if (!models.length) error = truncate(res.stderr || out || `${bin} --list-models 沒有輸出模型`, 300).trim();
      fetched = { models: models.length ? models : fetched.models, at: Date.now(), error: models.length ? null : error, pending: null };
    })();
    return fetched.pending;
  }

  function listModels() {
    if (fetched.models) return { models: fetched.models, source: 'cli' };
    if (fetched.error) return { models: FALLBACK_MODELS, source: 'error', error: fetched.error };
    return { models: FALLBACK_MODELS, source: 'loading' };
  }

  async function run(agent: AgentConfig, ctx: RunContext): Promise<RunResult> {
    const args = cursorArgs(agent, ctx, agent.model ? resolveModelId(listModels().models, agent.model) : '');
    if (agent.effort) ctx.onActivity({ id: 'run-options', kind: 'note', title: tx(ctx.locale || 'zh-Hant', 'cursor.effortIgnored', { effort: agent.effort }), status: 'done' });

    let prompt = ctx.prompt;
    if (ctx.systemPrompt && !ctx.sessionId) prompt = `${ctx.systemPrompt}\n\n---\n\n${prompt}`;

    const segments: any[] = []; // 已結束的回覆段落
    let current = '';    // 正在串流的段落
    let thinking = '';
    let thinkingOpen = false;
    let sessionId = ctx.sessionId || null;
    let resultText: any = null;
    let usage: any = null;
    let errorMsg: any = null;

    const renderText = () => [...segments, current].filter(Boolean).join('\n\n');
    const closeSegment = (full: any = '') => {
      const seg = (full != null ? full : current).trim();
      if (seg) segments.push(seg);
      current = '';
    };

    const res = await runProcess(...viaShell(bin, args), { cwd: ctx.cwd, stdin: prompt, timeoutMs: ctx.timeoutMs, locale: ctx.locale }, {
      onProc: ctx.onProc,
      onLine: (line: any) => {
        const ev = parseJson(line);
        if (!ev || typeof ev !== 'object') return;
        if (ev.session_id && ev.session_id !== sessionId) {
          const id = String(ev.session_id);
          sessionId = id;
          ctx.onSession(id);
        }
        if (ev.type === 'thinking') {
          if (ev.subtype === 'delta' && ev.text) {
            if (!thinkingOpen && thinking) thinking += '\n\n';
            thinkingOpen = true;
            thinking += ev.text;
            ctx.onThinking(thinking);
          } else if (ev.subtype === 'completed') {
            thinkingOpen = false;
          }
          return;
        }
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          const piece = ev.message.content.map((c: any) => (c && c.type === 'text' ? c.text || '' : '')).join('');
          const isRepeat = current ? piece === current : !!piece.trim() && segments[segments.length - 1] === piece.trim();
          if (isRepeat && !current) return; // 工具呼叫已經結束這段,重送的完整文字直接略過
          if (isRepeat || ev.timestamp_ms == null) closeSegment(piece); // 完整段落:以它為準,取代串流累積的片段
          else current += piece;
          ctx.onText(renderText());
          return;
        }
        if (ev.type === 'tool_call' && ev.tool_call) {
          if (current) { closeSegment(); ctx.onText(renderText()); }
          const key = Object.keys(ev.tool_call).find((k: any) => /ToolCall$/.test(k));
          const call = (key && ev.tool_call[key]) || {};
          const activity: any = { id: ev.call_id || ev.tool_call.toolCallId, kind: 'tool', title: describeCursorTool(key, call.args || {}, ctx.locale || 'zh-Hant') };
          if (ev.subtype === 'completed') {
            const r = toolResultText(call.result);
            activity.status = r.status;
            activity.result = truncate(r.text, 1500);
          } else {
            activity.status = 'running';
            activity.detail = truncate(JSON.stringify(call.args || {}, null, 1), 1500);
          }
          ctx.onActivity(activity);
          return;
        }
        if (ev.type === 'result') {
          if (ev.usage) usage = ev.usage;
          if (ev.is_error) errorMsg = (typeof ev.result === 'string' && ev.result) || ev.error || tx(ctx.locale || 'zh-Hant', 'cli.failed', { name: 'Cursor' });
          else if (typeof ev.result === 'string') resultText = ev.result;
        }
      },
    });

    if (current) closeSegment();
    let text = renderText();
    // result 是 Cursor 自己組好的最終回覆,串流去重萬一判斷失誤也以它為準
    if (resultText && resultText.trim() && resultText !== text) { text = resultText; ctx.onText(text); }
    const l = ctx.locale || 'zh-Hant';
    if (res.spawnError || res.code === NOT_FOUND) errorMsg = tx(l, 'cli.spawnFailed', { bin, detail: truncate(res.stderr, 1000).trim() || tx(l, 'proc.notFound', { bin }) });
    else if (res.timedOut) errorMsg = res.error || `${tx(l, 'cli.timedOut', { bin })}\n${truncate(res.stderr, 2000)}`;
    else if (res.code !== 0 && !text) errorMsg = errorMsg || `${tx(l, 'cli.exitCode', { bin, code: String(res.code) })}\n${truncate(res.stderr, 2000)}`;
    return { text, thinking, sessionId, usage, error: errorMsg };
  }

  return {
    id: 'cursor',
    docsUrl: 'https://cursor.com/cli',
    label: 'Cursor CLI',
    type: 'builtin',
    bin,
    supportsResume: true,
    supportsEdit: true,
    capabilities: { attachments: ['filePath'], attachmentsNeedCwd: false },
    efforts: [],
    listModels,
    refreshModels,
    check: (opts) => checkCli(bin, undefined, opts?.locale),
    usageShape: 'cursor',
    run,
  };
}

// cursor-agent 的參數。抽出來是為了能對照「真的 CLI 支不支援」,見 test/cli-flags.test.ts。
export function cursorArgs(agent: Pick<AgentConfig, 'canEdit'>, ctx: { cwd?: string; sessionId?: string | null }, modelId = ''): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--workspace', ctx.cwd || '.'];
  if (modelId) args.push('--model', modelId);
  if (ctx.sessionId) args.push('--resume', ctx.sessionId);
  // 不能改檔案時用 ask 模式(唯讀);可以改檔案時自動核准指令
  if (agent.canEdit) args.push('--force');
  else args.push('--mode', 'ask');
  return args;
}

export { createCursorAdapter, parseCursorModels, describeCursorTool };
