[繁體中文](adapters.md) | **English**

# Adding CLIs and APIs

AI Roundtable ships with Claude Code, Codex CLI, Cursor CLI and GitHub Copilot CLI. Other AIs can be connected through extensions without touching the source:

| Type | Suited to | Can edit files | File |
| --- | --- | --- | --- |
| CLI | AI CLIs with a non-interactive mode, e.g. Grok CLI, Kimi Code CLI, Gemini CLI | Yes | `.json`, `"type": "cli"` |
| API | OpenAI-compatible Chat Completions APIs, e.g. DeepSeek, Kimi, Grok, OpenRouter, Ollama | No by default; file editing requires explicitly enabled restricted tools and a reviewer gate | `.json`, `"type": "openai"` |
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
| `timeoutMs` | No | Per-model-turn timeout, default 20 minutes; background work such as model downloads does not use this value. The extension editor's “Time limit per turn” sets the same field in minutes, and the timeout error points there |
| `usageShape` | No | Convention for usage fields, see [Usage normalization](#usage-normalization). Detected from the fields when omitted |
| `capabilities` | No | Attachment capabilities, see below |
| `docsUrl` | No | Install or setup page. When this CLI or service is missing, the interface offers "Open install guide" |

### The next step when something is wrong

Whenever an environment problem is detected (not installed, not signed in, unreachable, missing key), the
interface uses one card: a plain sentence about what happened, plus one action the user can take. A JS
plugin can return `fix` from `check()` / `testConnection()` and from `run()`:

```js
return { ok: false, state: 'unauthenticated', hint: 'Run my-cli login first', fix: { command: 'my-cli login' } };
```

`fix` holds one of three, most specific first: `command` (a single command, typed into the built-in
terminal but **never run automatically**), `settingsTab` (something to do inside the app, e.g. `'clis'`
for an API key) and `url` (official documentation). JSON templates use the `fixCommand` and `docsUrl`
fields instead. When `run()` returns no `fix`, the app asks `check()` once after a failed turn and fills
it in — so most extensions need to do nothing.

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
| `maxHistoryMessages` | `80` | Number of history messages kept; must be a positive integer. Zero, negative values, and fractions fail validation |
| `unreachableHint` | Generic hint | Guidance shown when a credential-free HTTP endpoint cannot be reached, e.g. `Run ollama serve first` |
| `fixCommand` | None | A single command that fixes the problem, e.g. `ollama serve`. The interface shows a "Run in terminal" button next to the status; it types the command into the built-in terminal without running it |
| `docsUrl` | None | Install or setup page. When this CLI or service is not present, the interface offers "Open install guide" |
| `supportsEdit` | `false` | Must be explicitly `true` together with `fileTools.enabled: true`; the execution flow must still pass the reviewer gate |
| `fileTools.enabled` | `false` | Enables restricted `read_file`, `replace_text`, and `write_file` tools; no shell or `apply_patch` is exposed |

### Ollama and Qwen3.8

The bundled `ollama-api.json` template targets the multimodal `qwen3.8:27b-mlx` model (about 18 GB and 27.3B parameters), allows 20 minutes per turn, keeps at most 16 history messages, and recommends at least 32 GB of memory. It always sends `reasoning_effort: "none"` and disables effort overrides, reducing latency and preventing reasoning text from interfering with `[ASK]` / `[AGREED]` control markers.

In a live comparison with the same short prompt, omitting the parameter produced 118 characters of separate `reasoning`, 82 completion tokens, and took 5709ms. With `reasoning_effort: "none"`, the response had no reasoning, used 6 tokens, and took 856ms. Ollama keeps thinking in the separate `reasoning` field instead of mixing it into the answer, so it cannot accidentally trigger the answer parser's `[ASK]` / `[AGREED]` markers.

```bash
ollama pull qwen3.8:27b-mlx
ollama serve
```

Then add the Ollama template under "Settings → CLIs & extensions" and select `qwen3.8:27b-mlx` in the member settings. The model list comes from `http://localhost:11434/v1/models`. If the app reports that the endpoint is unreachable, make sure `ollama serve` is running. The template sends png / jpeg / webp / gif images as OpenAI `image_url` data URIs; other attachments are handled as text.

A simplified setup UI can use one backend method without exposing the endpoint or JSON. Call `registry.quickSetupOllama()` first to receive `{ models, recommendedModel }` and show only the model choice. Then call `registry.quickSetupOllama({ model })` to create or update the configuration. Its `adapterId` and `selectedModel` can be written directly into the member settings. Discovery uses the existing configuration's `baseUrl`. Updating preserves environment preferences such as endpoint, credentials, timeout, and history limit, while model capabilities, thinking behavior, and attachment support come from the latest template so stale settings cannot restore ineffective controls or disable images. A returned `name:latest` model also accepts the bare `name` as an alias; other tags are never guessed or substituted.

The built-in OpenAI-compatible templates (Ollama, DeepSeek, OpenRouter, Grok, Kimi, and the blank API template) all explicitly declare `supportsEdit: true` and `fileTools.enabled: true`. The adapter provides three restricted tools: `read_file`, the preferred exact-and-unique `replace_text`, and `write_file` for small new files or whole-file replacement. The first version deliberately exposes neither a shell nor `apply_patch`. Every path must stay inside the working directory. Version-control internals such as `.git`, `.hg`, and `.svn` are always blocked to prevent indirect command execution through hooks or configuration; symlink aliases are checked again after realpath resolution. Paths that get executed automatically are additionally **blocked for writes but readable** (reading `package.json` is a legitimate way to understand a project; writing it is what makes code run): any path containing `.husky`, `.vscode`, `.idea`, `.claude`, `.github`, `.devcontainer`, or `node_modules`; the root-level `package.json`, `.npmrc`, `.yarnrc*`, `.pnpmfile.cjs`, `Makefile`, `lefthook.*`, and `.pre-commit-config.*`; and any existing file that already carries an executable bit (mode `0o111`). `.husky/pre-commit` and `.git/hooks/pre-commit` do the same thing, so blocking only the latter achieves nothing. Editing an existing file requires a prior read and its SHA-256; a concurrent change causes the write to be rejected. Files are capped at 256 KB, one `read_file` returns at most 65536 UTF-16 code units (a larger `limit` is clamped instead of failing; `truncated` is set only when content is omitted), `replace_text.oldText` must contain at least 24 characters, and calls plus returned output have per-turn hard limits. Both successful and failed calls produce transcript-ready records for another reviewer. Added/removed counts use a line-level shortest-edit diff. Pathological large reorders that hit the computation guard are explicitly marked as approximate, and reviewers should rely on the red/green diff in that case.

The tools are not sent merely because the template or member enables editing. Three conditions must all hold: the template explicitly enables `supportsEdit` and `fileTools.enabled`, the member allows editing, and the divide run has another eligible reviewer. The orchestrator passes `RunContext.fileToolsEnabled: true` only after confirming reviewer availability; an executor cannot review its own changes. Successful and failed operations enter the transcript as a `tool-audit` system message, so the reviewer sees actual operations rather than only the model's prose report. Full `read_file` contents are not duplicated. Preflight availability does not guarantee a successful review: if review times out, crashes, or returns no text, the execution message is marked “not reviewed” and the user should inspect the red/green diff.

**Model abilities.** A template that supports tools does not mean the member's chosen model does (the same Ollama template can run qwen, which calls tools, or gemma3, which does not). The app checks free sources: Ollama's `POST /api/show` reports `capabilities` directly, and if the endpoint's model list carries capability data (for example OpenRouter's `supported_parameters` and `architecture.input_modalities`) it is used as is. Paid endpoints never get chat requests automatically: only when the user presses Test in the member settings are 3 tiny requests sent (a baseline request first, then one with tools and one with an image), and the result is stored in `model-capabilities.json`. A model known to lack tool calling is treated as a read-only member (`effectiveCanEdit` is false), and its reviews get file contents inline instead of tools; a model known not to see images is not sent images, its attachment block says it cannot see them, and the pre-send warning names it.

Cross-review turns are the exception: a reviewer on an API template with file tools enabled gets a **read-only** `read_file` (`RunContext.readOnlyFileTools`). Reading changes nothing, so it needs neither the member's edit permission nor the reviewer gate, and `write_file` or `replace_text` are rejected even if the model calls them. A template that supports tools does not mean the member's chosen model does, so the orchestrator always inlines the files under review in the prompt as well; if the endpoint rejects the request with tools (HTTP 400, 404 or 422), the adapter resends once without tools and tells the model no tools are available. The inlined content is for that turn only and is replaced with a one-line note when the conversation history is saved.

Remote API members take exactly the same path as local Ollama: the model only emits tool arguments, while path resolution and the actual writes always run on the user's machine inside the app. The same sandbox limits therefore apply to remote providers — working-directory boundary, blocked version-control internals, and the SHA-256 precondition on writes. Conversely, those tool arguments now originate from a remote model and must be treated as untrusted input: the sandbox is the only boundary, and nothing should rely on the model policing itself.

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
