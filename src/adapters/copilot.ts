import { randomUUID } from 'crypto';
import type { Activity, AgentConfig } from '../ipc-types';
import type { Model } from '../model-rules';
import type { Adapter, RunContext, RunResult } from './types';
import { checkCli, parseJson, runProcess, truncate } from './process';
import { tx } from '../text';

// 公司授權常用的較低成本模型;實際可用清單仍由組織政策決定,不可用時 CLI 會回報錯誤。
export const COPILOT_LOW_COST_MODELS = ['gpt-5-mini', 'claude-haiku-4.5', 'gpt-5.4-mini'] as const;
const MODELS_TTL_MS = 10 * 60 * 1000;

function copilotModel(id: string): Model {
  const lowCost = (COPILOT_LOW_COST_MODELS as readonly string[]).includes(id);
  return { id, label: id, efforts: id === 'auto' ? [] : ['low', 'medium', 'high'], defaultEffort: '', aliases: [], description: '', ...(lowCost ? { lowCost } : {}) };
}

// `copilot help config` 的 `model` 段落列出 CLI 支援的模型,每行 `- "id"`;不送模型請求。
export function parseCopilotModels(output: string): Model[] {
  const ids: string[] = [];
  let inModel = false;
  for (const line of String(output || '').split('\n')) {
    if (/^\s*`model`:/.test(line)) { inModel = true; continue; }
    if (!inModel) continue;
    const match = line.match(/^\s*-\s*"([A-Za-z0-9][\w.\-]*)"\s*$/);
    if (!match) break;
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  const cheap = COPILOT_LOW_COST_MODELS.filter((id) => ids.includes(id));
  return [copilotModel('auto'), ...[...cheap, ...ids.filter((id) => !cheap.includes(id as never) && id !== 'auto')].map(copilotModel)];
}

export function copilotArgs(
  agent: Pick<AgentConfig, 'canEdit' | 'model' | 'effort'>,
  ctx: { cwd?: string; sessionId?: string | null; newSessionId?: string | null; attachments?: Array<{ path: string | null }>; allowGit?: boolean },
): string[] {
  const args = ['--output-format', 'json', '--stream', 'on', '--no-ask-user', '--no-auto-update'];
  if (agent.model) args.push('--model', agent.model);
  if (agent.effort) args.push('--reasoning-effort', agent.effort);
  if (ctx.cwd) args.push('-C', ctx.cwd);
  if (ctx.sessionId) args.push('--resume', ctx.sessionId);
  else if (ctx.newSessionId) args.push('--session-id', ctx.newSessionId);
  for (const attachment of ctx.attachments || []) {
    if (attachment.path) args.push('--attachment', attachment.path);
  }
  if (agent.canEdit) {
    args.push('--allow-all-tools');
    // 禁止規則優先於 --allow-all-tools
    if (!ctx.allowGit) args.push('--deny-tool=shell(git commit)', '--deny-tool=shell(git push)');
  }
  else args.push('--available-tools=view,glob,grep', '--allow-tool=read', '--deny-tool=write', '--deny-tool=shell', '--disable-builtin-mcps');
  return args;
}

export function createCopilotAdapter({ bin = 'copilot' }: { bin?: string } = {}): Adapter {
  const fallback = [copilotModel('auto'), ...COPILOT_LOW_COST_MODELS.map(copilotModel)];
  let fetched: { models: Model[] | null; at: number; pending: Promise<void> | null } = { models: null, at: 0, pending: null };

  async function refreshModels(force = false) {
    if (!force && fetched.at && Date.now() - fetched.at < MODELS_TTL_MS) return;
    if (fetched.pending) return fetched.pending;
    fetched.pending = (async () => {
      let out = '';
      await runProcess(bin, ['help', 'config'], { timeoutMs: 15000, killGraceMs: 1000 }, { onLine: (line) => { out += line + '\n'; } });
      const models = parseCopilotModels(out);
      fetched = { models: models.length > 1 ? models : fetched.models, at: Date.now(), pending: null };
    })();
    return fetched.pending;
  }

  async function run(agent: AgentConfig, ctx: RunContext): Promise<RunResult> {
    const locale = ctx.locale || 'zh-Hant';
    const prompt = ctx.systemPrompt && !ctx.sessionId ? `${ctx.systemPrompt}\n\n---\n\n${ctx.prompt}` : ctx.prompt;
    const messages = new Map<string, string>();
    const reasoning = new Map<string, string>();
    const tools = new Map<string, Activity>();
    const seen = new Set<string>();
    const requests: unknown[] = [];
    const newSessionId = ctx.sessionId ? null : randomUUID();
    let sessionId = ctx.sessionId || null;
    let text = '';
    let thinking = '';
    let error: string | null = null;
    let authFailed = false;
    let completed = false;
    const failed = () => tx(locale, 'cli.failed', { name: 'GitHub Copilot CLI' });

    const res = await runProcess(bin, copilotArgs(agent, { ...ctx, newSessionId }), {
      cwd: ctx.cwd, stdin: prompt, timeoutMs: ctx.timeoutMs, locale,
      env: {
        COPILOT_ALLOW_ALL: 'false',
        GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: 'false',
        GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP: 'false',
        GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'false',
      },
    }, {
      onProc: ctx.onProc,
      onLine: (line) => {
        const event = parseJson(line);
        if (!event || typeof event !== 'object') return;
        if (typeof event.id === 'string') {
          if (seen.has(event.id)) return;
          seen.add(event.id);
        }
        const data = event.data || {};
        const child = !!(event.agentId || data.parentToolCallId);
        if (event.type === 'session.start' && !child && typeof data.sessionId === 'string' && data.sessionId !== sessionId) {
          sessionId = data.sessionId;
          ctx.onSession(data.sessionId);
        }
        if ((event.type === 'assistant.message_delta' || event.type === 'assistant.message') && !child) {
          const content = event.type === 'assistant.message_delta' ? data.deltaContent : data.content;
          if (typeof data.messageId !== 'string' || typeof content !== 'string') return;
          messages.set(data.messageId, event.type === 'assistant.message_delta' ? (messages.get(data.messageId) || '') + content : content);
          text = [...messages.values()].filter(Boolean).join('\n\n');
          ctx.onText(text);
        }
        if ((event.type === 'assistant.reasoning_delta' || event.type === 'assistant.reasoning') && !child) {
          const content = event.type === 'assistant.reasoning_delta' ? data.deltaContent : data.content;
          if (typeof data.reasoningId !== 'string' || typeof content !== 'string') return;
          reasoning.set(data.reasoningId, event.type === 'assistant.reasoning_delta' ? (reasoning.get(data.reasoningId) || '') + content : content);
          thinking = [...reasoning.values()].filter(Boolean).join('\n\n');
          ctx.onThinking(thinking);
        }
        if (event.type === 'tool.execution_start' && typeof data.toolCallId === 'string') {
          const activity: Activity = {
            id: data.toolCallId, kind: 'tool',
            title: tx(locale, 'act.tool', { detail: data.toolName || 'unknown' }),
            detail: truncate(JSON.stringify(data.arguments || {}, null, 1), 1500), status: 'running',
          };
          tools.set(data.toolCallId, activity);
          ctx.onActivity(activity);
        }
        if (event.type === 'tool.execution_complete' && typeof data.toolCallId === 'string') {
          const activity: Activity = {
            ...tools.get(data.toolCallId), id: data.toolCallId, kind: 'tool',
            status: data.success === true ? 'done' : 'error',
            result: truncate(data.error?.message || data.result?.detailedContent || data.result?.content || '', 1500),
          };
          tools.set(data.toolCallId, activity);
          ctx.onActivity(activity);
        }
        if (event.type === 'assistant.usage') requests.push(data);
        if (event.type === 'session.error' && !child) {
          error = typeof data.message === 'string' ? data.message : failed();
          authFailed = data.errorType === 'authentication' || data.remediation === 'sign_in';
        }
        if (event.type === 'session.shutdown' && !child) {
          completed = true;
          if (data.shutdownType === 'error') error = data.errorReason || error || failed();
        }
        if (event.type === 'session.idle' && !child) {
          completed = true;
          if (data.aborted) error = error || failed();
        }
        if (event.type === 'result') {
          completed = true;
          if (event.is_error) error = typeof event.result === 'string' ? event.result : error || failed();
          else if (typeof event.result === 'string' && event.result) {
            text = event.result;
            ctx.onText(text);
          }
        }
      },
    });

    if (res.spawnError) error = tx(locale, 'cli.spawnFailed', { bin, detail: truncate(res.stderr, 2000) });
    else if (res.timedOut) error = res.error || tx(locale, 'cli.timedOut', { bin });
    else if (res.code !== 0) error = error || `${tx(locale, 'cli.exitCode', { bin, code: String(res.code) })}\n${truncate(res.stderr, 2000)}`;
    else if (!completed || !text.trim()) error = error || failed();
    if (!error && !sessionId && newSessionId) {
      sessionId = newSessionId;
      ctx.onSession(newSessionId);
    }
    for (const activity of tools.values()) {
      if (activity.status === 'running') ctx.onActivity({ ...activity, status: 'error', result: error || failed() });
    }
    const fix = authFailed ? { command: 'copilot login' } : undefined;
    if (authFailed) error = `${tx(locale, 'cli.notLoggedIn', { name: 'GitHub Copilot CLI', cmd: 'copilot login' })}\n\n${error || ''}`;
    return { text, thinking, sessionId, usage: requests.length ? { requests } : null, error, ...(fix ? { fix } : {}) };
  }

  return {
    id: 'copilot', label: 'GitHub Copilot CLI', type: 'builtin', bin,
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
    supportsResume: true, supportsEdit: true,
    capabilities: { attachments: ['filePath'], attachmentsNeedCwd: true },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    listModels: () => ({ models: fetched.models || fallback, source: fetched.models ? 'cli' : 'builtin' }),
    refreshModels,
    check: (opts) => checkCli(bin, undefined, opts?.locale),
    usageShape: 'unknown',
    run,
  };
}