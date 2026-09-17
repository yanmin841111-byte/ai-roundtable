[繁體中文](adapters.md) | **English**

# Adding CLIs and APIs

AI Roundtable ships with Claude Code, Codex CLI and Cursor CLI. Other AIs can be connected through extensions without touching the source:

| Type | Suited to | Can edit files | File |
| --- | --- | --- | --- |
| CLI | AI CLIs with a non-interactive mode, e.g. Grok CLI, Kimi Code CLI, Gemini CLI | Yes | `.json`, `"type": "cli"` |
| API | OpenAI-compatible Chat Completions APIs, e.g. DeepSeek, Kimi, Grok, OpenRouter, Ollama | No, discussion and review only | `.json`, `"type": "openai"` |
| JS plugin | Anything JSON cannot describe | Up to you | `.js` |

## Quick start

1. Bottom-left "⚙ Settings" → "CLIs & extensions" → "+ Add", then pick a template.
2. The template is copied into your extensions folder and the editor opens. Edit it and click "Save & load".
3. When a definition is wrong, the editor and the settings page show the reason.
4. Pick the new extension in the member editor's "AI CLI" menu.

The extensions folder is `~/Library/Application Support/AI Roundtable/adapters/`, which you can open from "Settings → Data & logs". You can also add or edit files there directly and click ↻ Reload under "Settings → CLIs & extensions".

During development, the `AI_ROUNDTABLE_ADAPTERS_DIR` environment variable points the app at a different folder.

## Common fields

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Unique identifier: letters, digits and `. _ -`. Member settings store this value. Using `claude` or `codex` overrides the built-in adapter |
| `type` | Yes for JSON | `cli` or `openai` |
| `label` | No | Display name |
| `description` | No | Description shown in templates and member settings |
| `models` | No | Model list, see below; `openai` extensions may use `"auto"` |
| `efforts` | No | Effort levels offered when the model is typed manually or has no effort restriction |
| `timeoutMs` | No | Per-turn timeout, default 10 minutes |
| `usageShape` | No | Convention for usage fields, see [Usage normalization](#usage-normalization). Detected from the fields when omitted |
| `capabilities` | No | Attachment capabilities, see below |

### Attachment capabilities

```json
"capabilities": {
  "attachments": ["filePath"],
  "attachmentsNeedCwd": false
}
```

`attachments` may contain `filePath`, `imageInline` and `textInline`. CLIs usually use `filePath`; an OpenAI-compatible API without a declaration gets `textInline` only, so add `imageInline` only when the model accepts images (if the endpoint rejects an image with 400/415/422, the image is dropped and the request is retried as text). Set `attachmentsNeedCwd` to `true` only when the CLI cannot read absolute paths outside the working directory.

### Model list

Entries may be strings or objects:

```json
"models": [
  "simple-model",
  { "id": "pro-model", "label": "Pro", "description": "Description", "aliases": ["pro"], "efforts": ["low", "high"], "defaultEffort": "high" }
]
```

- For models with `efforts`, an unsupported level is lowered to the nearest supported one and noted in the conversation.
- An empty `efforts` array means the model has no effort setting, so no effort argument is sent.
- Omitting `efforts` means no restriction; the user's choice is sent as is.

## Usage normalization

Every CLI and API reports usage with different field names and meanings. `src/usage.ts` normalizes them to one shape at the `runTurn` boundary so the interface and exports can total them safely across members:

| Normalized field | Meaning |
| --- | --- |
| `inputTokens` | **The complete input, including cache reads and cache writes** |
| `cachedInputTokens` | The part read from cache (a subset of `inputTokens`) |
| `cacheWriteTokens` | The part written to cache (a subset of `inputTokens`, disjoint from `cachedInputTokens`) |
| `outputTokens` | Output |
| `costUsd` | Cost, reported by only some sources |
| `shape` | The convention that was applied, or `unknown` |
| `raw` | The original object, always kept as is |

**A field that was not reported is `null`, never `0`.** "This source did not report the number" and "this number is definitely zero" mean different things when totalling; consumers only add up records that actually have a value, and show how many members and turns each column covers.

### Field mapping per convention

| `usageShape` | Source | `inputTokens` | `cachedInputTokens` | `cacheWriteTokens` |
| --- | --- | --- | --- | --- |
| `anthropic` | Claude Code | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` |
| `codex` | Codex CLI | `input_tokens` (already includes cache) | `cached_input_tokens` | Not reported (`null`) |
| `cursor` | Cursor CLI | `inputTokens` + `cacheReadTokens` + `cacheWriteTokens` | `cacheReadTokens` | `cacheWriteTokens` |
| `openai` | OpenAI-compatible API | `prompt_tokens` (already includes cache) | `prompt_tokens_details.cached_tokens` | Not reported (`null`) |

Anthropic's three fields are disjoint, so **their sum is the full prompt**. Taking only `input_tokens + cache_read_input_tokens` badly under-reports turns that write to the cache: one real measurement was 38058 vs 28099, 26% less.

`total_cost_usd` is currently reported only by Claude Code. It was verified to be the **cost of a single invocation**, not a session total (two turns in one session: the second `--resume` turn cost 0.020398, less than the first turn's 0.113749, which a running total could never do), so adding it up per message is correct.

### When `usageShape` is omitted

The shape is detected from the fields, and only when the signature is unambiguous:

1. `cache_read_input_tokens` or `cache_creation_input_tokens` present → `anthropic`
2. `prompt_tokens` or `completion_tokens` present → `openai`
3. `cached_input_tokens` present → `codex`
4. `cacheReadTokens` or `cacheWriteTokens` present → `cursor`
5. Only `input_tokens` and `output_tokens`, with no cache field at all → `codex` (the cache is zero, so "includes cache" and "excludes cache" give the same number; this is not a guess)
6. Nothing matches → `unknown`

`unknown` records keep `raw` and list their original fields in the interface and exports, but are **excluded from cross-source totals**, and the total says how many were left out. A wrong assumption is more dangerous than not totalling, so nothing is guessed.

## CLI type

```json
{
  "id": "grok",
  "label": "Grok CLI",
  "type": "cli",
  "bin": "grok",
  "input": "arg",
  "systemPrompt": "prepend",
  "args": [
    "-p", "{prompt}",
    "--output-format", "streaming-json",
    "--cwd", "{cwd}",
    ["-m", "{model}"],
    ["--effort", "{effort}"],
    ["--resume", "{sessionId}"],
    { "if": "canEdit", "then": ["--always-approve"] }
  ],
  "output": {
    "format": "jsonl",
    "rules": [
      { "match": { "type": "text" }, "text": "data" },
      { "match": { "type": "end" }, "sessionId": "sessionId" },
      { "match": { "type": "error" }, "error": "message" }
    ]
  }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `bin` | Required | Command name or full path |
| `args` | `[]` | Arguments, see below |
| `input` | `stdin` | How the prompt is passed: `stdin`; `arg` (use `{prompt}`); `file` (written to a temp file, use `{promptFile}`); `none` |
| `systemPrompt` | `prepend` | How the role prompt is passed: `prepend` puts it before the prompt when not resuming; `arg` uses `{systemPrompt}`; `none` drops it |
| `output.format` | `text` | `text`: every line is reply text; `jsonl`: one JSON event per line; `json`: parse the whole output at the end |
| `output.rules` | `[]` | Rules that extract content from JSON events, see below |
| `output.sessionIdPattern` | None | Regular expression applied to stdout and stderr to capture the session id (first group) |
| `output.nonJsonLines` | `ignore` | What to do with non-JSON lines in `jsonl` mode: `ignore` or `text` |
| `supportsResume` | Auto | `true` when a `sessionId` rule or `sessionIdPattern` exists. Without resume support, the full transcript is sent every turn |
| `supportsEdit` | `true` | When `false`, members cannot enable "Allow editing files" |
| `env` | None | Extra environment variables; values may use placeholders |
| `shell` | `false` | Run through a shell |
| `successExitCodes` | `[0]` | Exit codes treated as success |
| `versionArgs` | `["--version"]` | Arguments used to check the install; `null` only checks the command exists; `false` skips the check |

### Arguments and placeholders

Available placeholders: `{prompt}`, `{promptFile}`, `{systemPrompt}`, `{model}`, `{effort}`, `{sessionId}`, `{cwd}`, `{canEdit}`, `{agentName}`. Write `{{` and `}}` for literal braces.

Each element of `args` may be:

| Form | Behaviour |
| --- | --- |
| `"--flag"` or `"{model}"` | A single argument; skipped when it contains a placeholder whose value is empty |
| `["-m", "{model}"]` | An argument group; the whole group is skipped when any placeholder is empty |
| `{ "if": "canEdit", "then": [...], "else": [...] }` | Chosen by condition |

Conditions: `"name"` has a value, `"!name"` has none, `"name=value"` equals, `"name!=value"` differs; an array means all must hold.

### Output rules

Every JSON event is run through all rules whose `match` applies, in order.

| Field | Description |
| --- | --- |
| `match` | Match conditions; keys are dot paths. Values may be literals, arrays (any of), or `{"$exists": true}`, `{"$startsWith": "x"}`, `{"$regex": "..."}`, `{"$ne": x}`, `{"$in": [...]}` |
| `each` | Apply to every element of an array in the event; later paths are relative to each element, and `$event` refers to the whole event |
| `text` | Path to reply text |
| `mode` | `append` joins fragments (default), `message` starts a new paragraph, `replace` replaces everything |
| `thinking` / `thinkingMode` | Path and mode for thinking content |
| `sessionId` | Path to the session id |
| `usage` | Path to the usage object |
| `error` | Path to the error message |
| `activity` | Show as a tool action: `id`, `title`, `detail`, `result`, `status` (`running`, `done`, `error`). Values are template strings, e.g. `"Tool: {function.name}"`; the same `id` updates the same entry |

## API type (OpenAI-compatible)

```json
{
  "id": "deepseek",
  "label": "DeepSeek API",
  "type": "openai",
  "baseUrl": "https://api.deepseek.com",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "models": [{ "id": "deepseek-v4-pro", "efforts": ["low", "high", "max"] }],
  "effortBody": { "thinking": { "type": "enabled" }, "reasoning_effort": "{effort}" }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `baseUrl` | Required | API root URL |
| `secretRef` | None | Reference written automatically after the API key is stored securely under "Settings → CLIs & extensions"; do not put the key itself here |
| `apiKeyEnv` | None | Environment variable holding the API key, used when nothing is stored securely |
| `headers` | None | Extra HTTP headers |
| `path` | `/chat/completions` | Chat endpoint |
| `models` | None | Model list, or `"auto"` to fetch from `modelsPath` (refreshed every 10 minutes) |
| `modelsPath` | `/models` | Model list endpoint |
| `modelFilter` | None | Regular expression that filters the automatic list |
| `defaultModel` | None | Used when the member has no model selected |
| `body` | None | Extra request fields; strings may use `{model}` and `{effort}` |
| `effortBody` | `{"reasoning_effort": "{effort}"}` | Merged into the request when an effort is selected |
| `systemRole` | `system` | Role used for the role prompt |
| `reasoningFields` | `["reasoning_content", "reasoning"]` | Fields carrying thinking content in the stream |
| `stream` | `true` | Whether to stream |
| `streamUsage` | `true` | Ask for usage while streaming; set to `false` for services that do not support it |
| `history` | `true` | Keep the conversation history in memory to resume; when off, the full transcript is sent every turn |
| `maxHistoryMessages` | `80` | Number of history messages kept |

### Setting the API key

Most users can enter it in the API key field under "Settings → CLIs & extensions"; the app encrypts it with the operating system's secure storage and never writes the plain text into the extension JSON. Alternatively, add to `~/.zshrc`:

```bash
export DEEPSEEK_API_KEY="sk-..."
```

It is picked up after restarting the app, including when launched from Finder or the Dock.

## JS plugins

When JSON is not enough, write a `.js` file. See [adapters/templates/aider-plugin.js](../adapters/templates/aider-plugin.js) for an example.

```js
module.exports = {
  id: 'my-agent',
  label: 'My Agent',
  bin: 'my-agent',          // when set, the install is checked automatically
  supportsResume: false,
  supportsEdit: true,
  // attachment capabilities, same format as JSON; when omitted, derived from supportsEdit
  // (can edit files → filePath + textInline, otherwise textInline)
  capabilities: { attachments: ['filePath'], attachmentsNeedCwd: false },
  models: ['a', 'b'],       // or listModels(kit) / refreshModels(kit)
  async run(agent, ctx, kit) {
    // agent: model, effort, canEdit, name…
    // ctx: prompt, systemPrompt, sessionId, cwd, timeoutMs, attachments (metadata with readable paths)
    //      onText(full text), onThinking(full text), onActivity(action), onSession(id), onProc(stoppable process)
    return { text: 'reply', thinking: '', sessionId: null, usage: null, error: null };
  },
};
```

You may also export `(kit) => ({ ... })`. `kit` provides `runProcess`, `buildArgs`, `render`, `getPath`, `matches`, `truncate`, `createStopHandle`, `resolveEffort` and more, defined in [src/adapters/kit.ts](../src/adapters/kit.ts).

For long-running work, pass the process or a `kit.createStopHandle(() => abort())` to `ctx.onProc` so that "Stop" can actually stop it.

## Security

- Extensions run commands with your account's permissions. JS plugins run inside the app's main process with full Node.js access. Only install extensions you can read and trust.
- When a member has "Allow editing files" on, CLI extensions usually pass an auto-approve flag such as `--yolo` or `--always-approve`.
- Enter API keys in the extension editor's API key field (stored encrypted) or use environment variables; do not write them into extension files. The plain-text `apiKey` field is disabled: it is migrated to secure storage on load, and if the migration fails the extension fails to load with the reason shown.

## Sharing extensions

An extension is a single file, so it can be shared directly. Pull requests with useful definitions for `adapters/templates/` are welcome.

The Grok CLI, Kimi Code CLI and Gemini CLI templates were written from the official documentation and have not been tested by the author against the real CLIs. If the arguments or output format differ, please report or fix them.
