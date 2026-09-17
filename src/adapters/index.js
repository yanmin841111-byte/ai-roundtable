'use strict';
// CLI 轉接層:把每個 AI CLI 的呼叫方式與輸出格式統一成同一個介面。
//
// runTurn(agent, { prompt, systemPrompt, sessionId, cwd, callbacks })
//   -> Promise<{ text, sessionId, usage, error }>
// callbacks: onText(fullText), onThinking(fullText), onActivity(activity), onSession(id), onProc(child)

const { spawn } = require('child_process');
const { listModels, resolveRunOptions } = require('../models');

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
const CLI_CHECK_TIMEOUT_MS = 5000;

const CLI_TYPES = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    supportsResume: true,
  },
  codex: {
    label: 'Codex CLI',
    bin: 'codex',
    supportsResume: true,
  },
  custom: {
    label: '自訂指令',
    bin: null,
    supportsResume: false,
  },
};

function truncate(s, n = 600) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function formatTimeout(timeoutMs) {
  return timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} 秒`;
}

// 逐行讀取 stdout,每行嘗試解析 JSON。
function lineReader(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  });
  stream.on('end', () => {
    const line = buf.trim();
    if (line) onLine(line);
  });
}

function parseJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function killProcess(child, signal = 'SIGTERM', nativeKill = null) {
  if (!child || !child.pid) return false;
  try {
    if (process.platform === 'win32') (nativeKill || child.kill.bind(child))(signal);
    else process.kill(-child.pid, signal);
    return true;
  } catch {
    try { return (nativeKill || child.kill.bind(child))(signal); } catch { return false; }
  }
}

function attachProcessGroupKill(child) {
  const nativeKill = child.kill.bind(child);
  child.kill = (signal = 'SIGTERM') => killProcess(child, signal, nativeKill);
  return child;
}

function runProcess(bin, args, { cwd, stdin, shell, timeoutMs = DEFAULT_TURN_TIMEOUT_MS, killGraceMs = DEFAULT_KILL_GRACE_MS }, cb) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let timeoutTimer = null;
    let killTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    try {
      child = attachProcessGroupKill(spawn(bin, args, { cwd, shell: !!shell, detached: true, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }));
    } catch (e) {
      return finish({ code: -1, stderr: String(e), spawnError: e });
    }
    cb.onProc && cb.onProc(child);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => finish({ code: -1, stderr: stderr + '\n' + String(e), spawnError: e }));
    lineReader(child.stdout, cb.onLine);
    child.on('close', (code) => finish({ code, stderr, timedOut, error: timedOut ? `執行逾時(${formatTimeout(timeoutMs)})` : null }));
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stderr += `\n執行逾時(${formatTimeout(timeoutMs)}),已送出 SIGTERM。`;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          stderr += '\n逾時行程未結束,已送出 SIGKILL。';
          child.kill('SIGKILL');
          setTimeout(() => finish({ code: -1, stderr, timedOut, error: `執行逾時(${formatTimeout(timeoutMs)})` }), 250);
        }, killGraceMs);
      }, timeoutMs);
    }
    if (stdin != null) {
      child.stdin.on('error', () => {});
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

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

async function runTurn(agent, ctx) {
  const noop = () => {};
  ctx = { onText: noop, onThinking: noop, onActivity: noop, onSession: noop, onProc: noop, ...ctx };
  switch (agent.cli) {
    case 'claude': return runClaude(agent, ctx);
    case 'codex': return runCodex(agent, ctx);
    default: return runCustom(agent, ctx);
  }
}

// 檢查 CLI 是否可用
function checkCli(bin) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child) child.kill('SIGTERM');
      finish({ ok: false, error: '逾時' });
    }, CLI_CHECK_TIMEOUT_MS);
    try { child = attachProcessGroupKill(spawn(bin, ['--version'], { detached: true, env: process.env })); } catch (e) { return finish({ ok: false, error: String(e) }); }
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => finish({ ok: code === 0, version: out.trim().split('\n')[0] }));
  });
}

// 回傳給介面用的 CLI 描述,每個 CLI 附上目前可用的模型清單與來源(cache / fallback / none)。
function cliCatalog() {
  const out = {};
  for (const [key, type] of Object.entries(CLI_TYPES)) {
    const { models, source } = listModels(key);
    out[key] = { ...type, models, modelSource: source };
  }
  return out;
}

module.exports = { CLI_TYPES, runTurn, checkCli, cliCatalog };
