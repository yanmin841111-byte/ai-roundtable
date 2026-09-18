// 內建轉接器:Claude Code、Codex CLI、Cursor CLI、自訂 shell 指令。
// 每個轉接器都遵守 registry.js 描述的介面。

import { runProcess, parseJson, truncate, checkCli } from './process';
import { listModels, resolveRunOptions } from '../models';
import { createCursorAdapter } from './cursor';
import type { AgentConfig } from '../ipc-types';
import type { Adapter, RunContext, RunResult } from './types';
import { tx, type TextLocale } from '../text';

// 錯誤訊息與工具動作標題會顯示在對話泡泡裡,跟著介面語言。
const loc = (ctx: RunContext): TextLocale => ctx.locale || 'zh-Hant';

// 強度被調整或略過時,在對話泡泡裡留一筆紀錄,讓使用者知道實際送出的設定。
function reportRunNote(ctx: RunContext, run: { note?: string | null }) {
  if (run.note) ctx.onActivity({ id: 'run-options', kind: 'note', title: run.note, status: 'done' });
}

// ---------- Claude Code ----------
async function runClaude(agent: AgentConfig, ctx: RunContext): Promise<RunResult> {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  const run = resolveRunOptions('claude', agent.model, agent.effort);
  if (run.model) args.push('--model', run.model);
  if (run.effort) args.push('--effort', run.effort);
  reportRunNote(ctx, run);
  if (ctx.sessionId) args.push('--resume', ctx.sessionId);
  if (ctx.systemPrompt) args.push('--append-system-prompt', ctx.systemPrompt);
  if (agent.canEdit) args.push('--dangerously-skip-permissions');
  else args.push('--permission-mode', 'dontAsk', '--restricted');

  let text = '';
  let thinking = '';
  let sessionId = ctx.sessionId || null;
  let resultText: any = null;
  let usage: any = null;
  let errorMsg: any = null;
  const toolNames: Record<string, any> = {};

  const res = await runProcess('claude', args, { cwd: ctx.cwd, stdin: ctx.prompt, timeoutMs: ctx.timeoutMs, locale: loc(ctx) }, {
    onProc: ctx.onProc,
    onLine: (line: any) => {
      const ev = parseJson(line);
      if (!ev) return;
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
        const id = String(ev.session_id);
        sessionId = id;
        ctx.onSession(id);
        return;
      }
      if (ev.type === 'stream_event' && ev.event) {
        const e = ev.event;
        if (e.type === 'message_start') {
          if (text && !text.endsWith('\n\n')) text += '\n\n';
        } else if (e.type === 'content_block_delta' && e.delta) {
          if (e.delta.type === 'text_delta') { text += e.delta.text; ctx.onText(text); }
          else if (e.delta.type === 'thinking_delta') { thinking += e.delta.thinking; ctx.onThinking(thinking); }
        }
        return;
      }
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_use') {
            toolNames[block.id] = block.name;
            ctx.onActivity({ id: block.id, kind: 'tool', title: describeClaudeTool(block, loc(ctx)), detail: truncate(JSON.stringify(block.input, null, 1), 1500), status: 'running' });
          }
        }
        return;
      }
      if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_result') {
            const content = Array.isArray(block.content) ? block.content.map((c: any) => c.text || '').join('\n') : (block.content || '');
            ctx.onActivity({ id: block.tool_use_id, kind: 'tool', status: block.is_error ? 'error' : 'done', result: truncate(content, 1500) });
          }
        }
        return;
      }
      if (ev.type === 'result') {
        usage = { total_cost_usd: ev.total_cost_usd, ...(ev.usage || {}) };
        if (ev.is_error) errorMsg = ev.result || ev.error || tx(loc(ctx), 'cli.failed', { name: 'Claude' });
        else if (typeof ev.result === 'string') resultText = ev.result;
      }
    },
  });

  if (!text && resultText) { text = resultText; ctx.onText(text); }
  if (res.spawnError) errorMsg = tx(loc(ctx), 'cli.spawnFailed', { bin: 'claude', detail: res.stderr });
  else if (res.timedOut) errorMsg = res.error || `${tx(loc(ctx), 'cli.timedOut', { bin: 'claude' })}\n${truncate(res.stderr, 2000)}`;
  else if (res.code !== 0 && !text) errorMsg = errorMsg || `${tx(loc(ctx), 'cli.exitCode', { bin: 'claude', code: String(res.code) })}\n${truncate(res.stderr, 2000)}`;
  return { text, thinking, sessionId, usage, error: errorMsg };
}

function describeClaudeTool(block: any, locale: TextLocale) {
  const i = block.input || {};
  switch (block.name) {
    case 'Bash': return tx(locale, 'act.run', { detail: truncate(i.command, 120) });
    case 'Read': return tx(locale, 'act.read', { detail: i.file_path || '' });
    case 'Edit': return tx(locale, 'act.edit', { detail: i.file_path || '' });
    case 'Write': return tx(locale, 'act.write', { detail: i.file_path || '' });
    case 'Glob': return tx(locale, 'act.glob', { detail: i.pattern || '' });
    case 'Grep': return tx(locale, 'act.grep', { detail: i.pattern || '' });
    default: return tx(locale, 'act.tool', { detail: block.name });
  }
}

// ---------- Codex CLI ----------
async function runCodex(agent: AgentConfig, ctx: RunContext): Promise<RunResult> {
  const args = ['exec'];
  let prompt = ctx.prompt;
  if (ctx.sessionId) {
    args.push('resume', ctx.sessionId, '-');
  } else {
    args.push('-', '-C', ctx.cwd, '-s', agent.canEdit ? 'workspace-write' : 'read-only');
    // Codex 沒有系統提示參數,把角色設定放進第一則訊息。
    if (ctx.systemPrompt) prompt = `${ctx.systemPrompt}\n\n---\n\n${prompt}`;
  }
  args.push('--json', '--skip-git-repo-check');
  const run = resolveRunOptions('codex', agent.model, agent.effort);
  if (run.model) args.push('-m', run.model);
  if (run.effort) args.push('-c', `model_reasoning_effort="${run.effort}"`);
  reportRunNote(ctx, run);
  if (ctx.sessionId) args.push('-c', `sandbox_mode="${agent.canEdit ? 'workspace-write' : 'read-only'}"`);
  if (agent.canEdit) args.push('-c', 'approval_policy="never"');

  const items = new Map(); // id -> item(含順序)
  let order = 0;
  let sessionId = ctx.sessionId || null;
  let usage: any = null;
  let errorMsg: any = null;

  const renderText = () => [...items.values()].filter((it: any) => it.type === 'agent_message').sort((a: any, b: any) => a._o - b._o).map((it: any) => it.text || '').join('\n\n');
  const renderThinking = () => [...items.values()].filter((it: any) => it.type === 'reasoning').sort((a: any, b: any) => a._o - b._o).map((it: any) => it.text || '').join('\n\n');

  const res = await runProcess('codex', args, { cwd: ctx.cwd, stdin: prompt, timeoutMs: ctx.timeoutMs, locale: loc(ctx) }, {
    onProc: ctx.onProc,
    onLine: (line: any) => {
      const ev = parseJson(line);
      if (!ev) return;
      if (ev.type === 'thread.started' && ev.thread_id) {
        const id = String(ev.thread_id);
        sessionId = id;
        ctx.onSession(id);
        return;
      }
      if (ev.type && ev.type.startsWith('item.') && ev.item) {
        const it = ev.item;
        const prev = items.get(it.id);
        it._o = prev ? prev._o : order++;
        items.set(it.id, it);
        if (it.type === 'agent_message') ctx.onText(renderText());
        else if (it.type === 'reasoning') ctx.onThinking(renderThinking());
        else if (it.type === 'command_execution') {
          ctx.onActivity({ id: it.id, kind: 'tool', title: tx(loc(ctx), 'act.run', { detail: truncate(it.command, 120) }), detail: it.command, status: ev.type === 'item.completed' ? (it.exit_code === 0 || it.exit_code == null ? 'done' : 'error') : 'running', result: truncate(it.aggregated_output, 1500) });
        } else if (it.type === 'file_change') {
          const files = (it.changes || []).map((c: any) => `${c.kind || ''} ${c.path || ''}`).join('\n');
          ctx.onActivity({ id: it.id, kind: 'tool', title: tx(loc(ctx), 'act.changes', { n: (it.changes || []).length }), detail: files, status: ev.type === 'item.completed' ? 'done' : 'running' });
        } else if (it.type === 'mcp_tool_call' || it.type === 'web_search') {
          ctx.onActivity({ id: it.id, kind: 'tool', title: it.type === 'web_search' ? tx(loc(ctx), 'act.webSearch', { detail: truncate(it.query, 100) }) : tx(loc(ctx), 'act.tool', { detail: `${it.server || ''}/${it.tool || ''}` }), detail: truncate(JSON.stringify(it.arguments || it, null, 1), 1200), status: ev.type === 'item.completed' ? 'done' : 'running' });
        } else if (it.type === 'error') {
          errorMsg = it.message || tx(loc(ctx), 'cli.reportedError', { name: 'Codex' });
        }
        return;
      }
      if (ev.type === 'turn.completed') usage = ev.usage || null;
      if (ev.type === 'turn.failed') errorMsg = (ev.error && ev.error.message) || tx(loc(ctx), 'cli.turnFailed', { name: 'Codex' });
      if (ev.type === 'error') errorMsg = ev.message || tx(loc(ctx), 'cli.reportedError', { name: 'Codex' });
    },
  });

  const text = renderText();
  if (res.spawnError) errorMsg = tx(loc(ctx), 'cli.spawnFailed', { bin: 'codex', detail: res.stderr });
  else if (res.timedOut) errorMsg = res.error || `${tx(loc(ctx), 'cli.timedOut', { bin: 'codex' })}\n${truncate(res.stderr, 2000)}`;
  else if (res.code !== 0 && !text) errorMsg = errorMsg || `${tx(loc(ctx), 'cli.exitCode', { bin: 'codex', code: String(res.code) })}\n${truncate(res.stderr, 2000)}`;
  return { text, thinking: renderThinking(), sessionId, usage, error: errorMsg };
}

// ---------- 自訂指令 ----------
// 指令範本可用 {model}、{effort} 佔位;提示詞從 stdin 送入,stdout 視為純文字回覆。
async function runCustom(agent: AgentConfig, ctx: RunContext): Promise<RunResult> {
  const cmd = (agent.customCommand || '').replace(/\{model\}/g, agent.model || '').replace(/\{effort\}/g, agent.effort || '');
  if (!cmd.trim()) return { text: '', sessionId: null, usage: null, error: tx(loc(ctx), 'cli.customNotSet') };
  let prompt = ctx.prompt;
  if (ctx.systemPrompt) prompt = `${ctx.systemPrompt}\n\n---\n\n${prompt}`;
  let text = '';
  const res = await runProcess(cmd, [], { cwd: ctx.cwd, stdin: prompt, shell: true, timeoutMs: ctx.timeoutMs, locale: loc(ctx) }, {
    onProc: ctx.onProc,
    onLine: (line: any) => { text += (text ? '\n' : '') + line; ctx.onText(text); },
  });
  let errorMsg: any = null;
  const what = tx(loc(ctx), 'cli.customCommand');
  if (res.spawnError) errorMsg = tx(loc(ctx), 'cli.spawnFailed', { bin: what, detail: res.stderr });
  else if (res.timedOut) errorMsg = res.error || `${tx(loc(ctx), 'cli.timedOut', { bin: what })}\n${truncate(res.stderr, 2000)}`;
  else if (res.code !== 0 && !text) errorMsg = `${tx(loc(ctx), 'cli.exitCode', { bin: what, code: String(res.code) })}\n${truncate(res.stderr, 2000)}`;
  return { text, thinking: '', sessionId: null, usage: null, error: errorMsg };
}


const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const builtinAdapters: Adapter[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    type: 'builtin',
    bin: 'claude',
    supportsResume: true,
    supportsEdit: true,
    // 唯讀模式(--permission-mode dontAsk)會拒絕讀取工作目錄以外的檔案，附件要放一份副本到工作目錄
    capabilities: { attachments: ['filePath'], attachmentsNeedCwd: true },
    efforts: CLAUDE_EFFORTS,
    listModels: () => listModels('claude'),
    check: (opts) => checkCli('claude', undefined, opts?.locale),
    usageShape: 'anthropic',
    run: runClaude,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    type: 'builtin',
    bin: 'codex',
    supportsResume: true,
    supportsEdit: true,
    capabilities: { attachments: ['filePath'], attachmentsNeedCwd: false },
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    listModels: () => listModels('codex'),
    check: (opts) => checkCli('codex', undefined, opts?.locale),
    usageShape: 'codex',
    run: runCodex,
  },
  createCursorAdapter(),
  {
    id: 'custom',
    label: '自訂指令',
    type: 'builtin',
    bin: null,
    supportsResume: false,
    supportsEdit: true,
    usesCustomCommand: true, // 不宣告 usageShape:自訂指令的 usage 語意未知,交給特徵辨識
    efforts: [],
    listModels: () => ({ models: [], source: 'none' }),
    run: runCustom,
  },
];

export { builtinAdapters };
