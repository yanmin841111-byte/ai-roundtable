'use strict';
// 內建轉接器:Claude Code、Codex CLI、自訂 shell 指令。
// 每個轉接器都遵守 registry.js 描述的介面。

const { runProcess, parseJson, truncate, checkCli } = require('./process');
const { listModels, resolveRunOptions } = require('../models');

// 強度被調整或略過時,在對話泡泡裡留一筆紀錄,讓使用者知道實際送出的設定。
function reportRunNote(ctx, run) {
  if (run.note) ctx.onActivity({ id: 'run-options', kind: 'note', title: run.note, status: 'done' });
}

// ---------- Claude Code ----------
async function runClaude(agent, ctx) {
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
  let resultText = null;
  let usage = null;
  let errorMsg = null;
  const toolNames = {};

  const res = await runProcess('claude', args, { cwd: ctx.cwd, stdin: ctx.prompt, timeoutMs: ctx.timeoutMs }, {
    onProc: ctx.onProc,
    onLine: (line) => {
      const ev = parseJson(line);
      if (!ev) return;
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
        sessionId = ev.session_id;
        ctx.onSession && ctx.onSession(sessionId);
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
            ctx.onActivity({ id: block.id, kind: 'tool', title: describeClaudeTool(block), detail: truncate(JSON.stringify(block.input, null, 1), 1500), status: 'running' });
          }
        }
        return;
      }
      if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_result') {
            const content = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('\n') : (block.content || '');
            ctx.onActivity({ id: block.tool_use_id, kind: 'tool', status: block.is_error ? 'error' : 'done', result: truncate(content, 1500) });
          }
        }
        return;
      }
      if (ev.type === 'result') {
        usage = { total_cost_usd: ev.total_cost_usd, ...(ev.usage || {}) };
        if (ev.is_error) errorMsg = ev.result || ev.error || '執行失敗';
        else if (typeof ev.result === 'string') resultText = ev.result;
      }
    },
  });

  if (!text && resultText) { text = resultText; ctx.onText(text); }
  if (res.spawnError) errorMsg = `無法啟動 claude:${res.stderr}`;
  else if (res.timedOut) errorMsg = res.error || `claude 執行逾時\n${truncate(res.stderr, 2000)}`;
  else if (res.code !== 0 && !text) errorMsg = errorMsg || `claude 結束代碼 ${res.code}\n${truncate(res.stderr, 2000)}`;
  return { text, thinking, sessionId, usage, error: errorMsg };
}

function describeClaudeTool(block) {
  const i = block.input || {};
  switch (block.name) {
    case 'Bash': return `執行指令:${truncate(i.command, 120)}`;
    case 'Read': return `讀取檔案:${i.file_path || ''}`;
    case 'Edit': return `編輯檔案:${i.file_path || ''}`;
    case 'Write': return `寫入檔案:${i.file_path || ''}`;
    case 'Glob': return `搜尋檔名:${i.pattern || ''}`;
    case 'Grep': return `搜尋內容:${i.pattern || ''}`;
    default: return `工具:${block.name}`;
  }
}

// ---------- Codex CLI ----------
async function runCodex(agent, ctx) {
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
  let usage = null;
  let errorMsg = null;

  const renderText = () => [...items.values()].filter((it) => it.type === 'agent_message').sort((a, b) => a._o - b._o).map((it) => it.text || '').join('\n\n');
  const renderThinking = () => [...items.values()].filter((it) => it.type === 'reasoning').sort((a, b) => a._o - b._o).map((it) => it.text || '').join('\n\n');

  const res = await runProcess('codex', args, { cwd: ctx.cwd, stdin: prompt, timeoutMs: ctx.timeoutMs }, {
    onProc: ctx.onProc,
    onLine: (line) => {
      const ev = parseJson(line);
      if (!ev) return;
      if (ev.type === 'thread.started' && ev.thread_id) {
        sessionId = ev.thread_id;
        ctx.onSession && ctx.onSession(sessionId);
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
          ctx.onActivity({ id: it.id, kind: 'tool', title: `執行指令:${truncate(it.command, 120)}`, detail: it.command, status: ev.type === 'item.completed' ? (it.exit_code === 0 || it.exit_code == null ? 'done' : 'error') : 'running', result: truncate(it.aggregated_output, 1500) });
        } else if (it.type === 'file_change') {
          const files = (it.changes || []).map((c) => `${c.kind || ''} ${c.path || ''}`).join('\n');
          ctx.onActivity({ id: it.id, kind: 'tool', title: `修改檔案(${(it.changes || []).length})`, detail: files, status: ev.type === 'item.completed' ? 'done' : 'running' });
        } else if (it.type === 'mcp_tool_call' || it.type === 'web_search') {
          ctx.onActivity({ id: it.id, kind: 'tool', title: it.type === 'web_search' ? `搜尋網路:${truncate(it.query, 100)}` : `工具:${it.server || ''}/${it.tool || ''}`, detail: truncate(JSON.stringify(it.arguments || it, null, 1), 1200), status: ev.type === 'item.completed' ? 'done' : 'running' });
        } else if (it.type === 'error') {
          errorMsg = it.message || 'Codex 回報錯誤';
        }
        return;
      }
      if (ev.type === 'turn.completed') usage = ev.usage || null;
      if (ev.type === 'turn.failed') errorMsg = (ev.error && ev.error.message) || 'Codex 回合失敗';
      if (ev.type === 'error') errorMsg = ev.message || 'Codex 錯誤';
    },
  });

  const text = renderText();
  if (res.spawnError) errorMsg = `無法啟動 codex:${res.stderr}`;
  else if (res.timedOut) errorMsg = res.error || `codex 執行逾時\n${truncate(res.stderr, 2000)}`;
  else if (res.code !== 0 && !text) errorMsg = errorMsg || `codex 結束代碼 ${res.code}\n${truncate(res.stderr, 2000)}`;
  return { text, thinking: renderThinking(), sessionId, usage, error: errorMsg };
}

// ---------- 自訂指令 ----------
// 指令範本可用 {model}、{effort} 佔位;提示詞從 stdin 送入,stdout 視為純文字回覆。
async function runCustom(agent, ctx) {
  const cmd = (agent.customCommand || '').replace(/\{model\}/g, agent.model || '').replace(/\{effort\}/g, agent.effort || '');
  if (!cmd.trim()) return { text: '', sessionId: null, usage: null, error: '尚未設定自訂指令' };
  let prompt = ctx.prompt;
  if (ctx.systemPrompt) prompt = `${ctx.systemPrompt}\n\n---\n\n${prompt}`;
  let text = '';
  const res = await runProcess(cmd, [], { cwd: ctx.cwd, stdin: prompt, shell: true, timeoutMs: ctx.timeoutMs }, {
    onProc: ctx.onProc,
    onLine: (line) => { text += (text ? '\n' : '') + line; ctx.onText(text); },
  });
  let errorMsg = null;
  if (res.spawnError) errorMsg = `無法啟動指令:${res.stderr}`;
  else if (res.timedOut) errorMsg = res.error || `自訂指令執行逾時\n${truncate(res.stderr, 2000)}`;
  else if (res.code !== 0 && !text) errorMsg = `指令結束代碼 ${res.code}\n${truncate(res.stderr, 2000)}`;
  return { text, thinking: '', sessionId: null, usage: null, error: errorMsg };
}


const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const builtinAdapters = [
  {
    id: 'claude',
    label: 'Claude Code',
    type: 'builtin',
    bin: 'claude',
    supportsResume: true,
    supportsEdit: true,
    efforts: CLAUDE_EFFORTS,
    listModels: () => listModels('claude'),
    check: () => checkCli('claude'),
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
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    listModels: () => listModels('codex'),
    check: () => checkCli('codex'),
    usageShape: 'codex',
    run: runCodex,
  },
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

module.exports = { builtinAdapters };
