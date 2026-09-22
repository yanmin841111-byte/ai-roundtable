[繁體中文](README.md) | **English**

# AI Roundtable

A macOS desktop app that seats multiple AI coding CLIs (Claude Code, Codex CLI,
Cursor CLI, or any custom command) at one table to discuss a task, divide the
work, execute it, and review each other.

> Members debate a task, split the work, execute in parallel, and review each
> other's output. You watch the whole conversation live and can jump in at any
> time.

![AI Roundtable screenshot](docs/screenshot.png)

## Features

- **Several AIs at one table**: Claude Code, Codex CLI and Cursor CLI are built
  in; Grok, Kimi, DeepSeek, Gemini, OpenRouter, Ollama and more can be added
  from templates in one click.
- **Extensible**: describe any CLI or OpenAI-compatible API in JSON, or write a
  JS plugin; edit and reload extensions inside the app.
- **Per-member settings**: role and personality, model, reasoning effort, and
  whether the member may edit files.
- **Lineups**: save who takes part, their roles, the lead, the flow and the work
  mode, and switch back with one click.
- **Work mode**: "Writing code" verifies the changes automatically and locks
  existing tests; "General task" (documents, analysis, brainstorming) skips
  both.
- **Test-first flow**: turn the acceptance criteria into tests, lock them, then
  implement until they pass.
- **Project conventions**: `CLAUDE.md` or `AGENTS.md` in the working directory
  goes into every member's system prompt.
- **Counterexamples**: a reviewer can attach an executable script that has to
  fail against the current code. The app runs it: only a real failure counts, and
  one that unexpectedly passes is marked unsubstantiated rather than used to
  force a fix. Whether it got fixed is decided by the app re-running it, not by
  any member's claim.
- **Counterexample corpus**: confirmed counterexamples are stored in
  `.roundtable/counterexamples.json` in the working directory, so they travel
  with the project, can be committed, and run again before every future task.
- **Ratchet**: syntax checks, verify commands and counterexamples become one set
  of gates, measured before the task, after execution and after repair. Any gate
  that goes from passing to failing is rolled back automatically. Gates that were
  already failing are not this task's responsibility.
- **A way out**: when a member gets stuck or breaks things, revert the working
  directory to how it was before the task, in one click.
- **Discuss → divide → execute in parallel → cross-review → summarize**,
  streamed live, including tool calls and thinking.
- **Interject any time**: messages sent while a task runs are shown to the next
  member to speak.
- **@-mention a member**: type `@Name` so only that member replies or acts,
  skipping the discussion flow; several members at once run in parallel.
- **Attachments**: drag and drop or click 📎 to attach images, text files or
  PDFs; each member gets a file path or inline content depending on its
  capabilities.
- **One-click fixes for environment problems**: a CLI that is not installed or
  not signed in, a local model that is not running, a Mac where git cannot run —
  all of them say plainly what happened in the same place, with a "Run in
  terminal" button that types the fix into the built-in terminal (typed, never
  auto-run) or opens the official install guide when no single command applies.
  A member's model settings say up front whether that CLI or API works instead
  of failing after you send a task — and when a turn does fail, the same button
  sits right under the error in the conversation.
- **Built-in terminal**: press ⌘J (or the "Terminal" button) for a real terminal
  docked on the right, opened in the same working directory — tabs, drag to
  resize, follows the theme — so `git diff` or `npm test` never means leaving
  the app.
- **History**: every task is saved when it ends; preview, export to Markdown, or
  "Resume this conversation" to keep discussing.
- **Side-by-side parallel replies**: in parallel phases such as execution and
  review, member messages sit three to a row.
- **Usage totals**: input, cached, output tokens and cost normalized across CLIs
  and APIs.
- **Interface language**: Traditional Chinese and English, optionally following
  the system; system messages, member prompts and exports switch with it.
- **Uses the CLI subscriptions you already have**; no extra API keys needed.
  Keys for API members are encrypted with the operating system's secure storage.

## What the evidence supports

**This project's evaluations have not demonstrated that multiple AIs reviewing each
other outperform a solo agent. That is not the same as disproving it.** Same-model
experiments 3, 5 and 6 were invalidated because repair turns lacked file tools.
Experiment 7, a small executor with Claude Code reviewing, did not support H3
(primary difference -6.7 percentage points, p = 0.631). The flagship Claude Code +
Codex combination has not been measured. See the [experiment log](eval/EXPERIMENTS.md).

The ratchet guards only measured, comparable gates, subject to check coverage and
successful rollback; it does not establish task correctness. A repaired counterexample
passing proves that particular check now passes, not that every requirement is met.

## Requirements

- macOS (other platforms are untested)
- Node.js 20.6.0 or newer (development and CI use Node.js 22)
- At least one AI source:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
    [Codex CLI](https://github.com/openai/codex) or
    [Cursor CLI](https://cursor.com/cli) (`cursor-agent`), installed and logged
    in
  - or any other CLI / API through an extension

## Quick start

```bash
git clone https://github.com/yanmin841111-byte/ai-roundtable.git
cd ai-roundtable
npm install
npm start
```

The bottom-left corner shows the CLIs it detected and their versions. If one is
missing, make sure the command is on the `PATH` of your login shell.

To package a .dmg:

```bash
npm run dist
```

The output is `release/AI Roundtable-<version>-arm64.dmg` (Apple Silicon) and
`-x64.dmg` (Intel). You can also download them from
[Releases](https://github.com/yanmin841111-byte/ai-roundtable/releases). There
is no Apple developer certificate, so the app is only ad-hoc signed and not
notarized; the first time, macOS says the developer cannot be verified. Click
Done, then open System Settings → Privacy & Security, click "Open Anyway" at the
bottom and confirm (on macOS 14 and earlier, right-click the app in Finder →
Open also works). After that it opens normally.

## How a task runs

After you send a task, depending on the mode:

- **Discuss → Write tests → Implement → Cross-review**: the same as the flow
  below with one step added after the division of work: each member first turns
  its own acceptance criteria into tests. Those tests are locked during
  implementation, so the only way to make them pass is to change the
  implementation.
- **Discuss → Divide & execute → Cross-review**
  1. Members speak in turn, each seeing everything said before. A member who
     thinks there is agreement ends its reply with `[AGREED]`; when everyone
     agrees in the same round the work is divided, otherwise division is forced
     once "Max discussion rounds" is reached.
     Settings also offer "Independent first, then critique": the first round receives
     only the task, attachments and project rules, without resuming old sessions.
     Questions and critique wait until everyone finishes; at least two rounds run.
     Lineups remember this setting. This isolates context, not CLI permissions.
  2. The lead outputs a JSON work plan, keeping each member on different files
     where possible.
  3. When two or more members can edit files, they execute **in parallel** in
     separate directories. Only non-overlapping changes are merged back.
     Overlapping or unsafe-to-merge versions remain at the reported paths and
     the work is marked incomplete. If isolation cannot be prepared, members
     run **sequentially** in the original directory and the app says so.
  4. **The app verifies the work itself** (only in "Writing code" mode): changed
     `.js` and `.json` files are syntax-checked so they can be loaded, and if a
     "verify command" is set (for example `npm test`) it runs in the working
     directory. No model is involved in this step. Test files that existed
     before the task are locked during the repair round, so tests pass by
     changing the implementation, not the tests.
  5. Each member reviews the next member's work. Reviews run with a **clean
     context**: only the requirements, the other member's report, the actual
     changes and the verification result — not the discussion or the execution,
     so the reviewer is not led by what the other member said. A member whose
     execution stopped partway but already changed files is reviewed too.
  6. Review issues or failed verification trigger one repair round, followed by
     verification and re-checking. A dedicated reviewer who identified issues
     takes over repairs when allowed to edit and a third member can independently
     re-check. Otherwise the original author repairs and the original reviewer
     re-checks. Test-writing and repair turns run sequentially. Remaining issues
     go into the summary.
  7. The lead summarizes.
- **Discuss only, no execution**: after agreement or the round limit, the lead
  summarizes.

Isolation prefers Git worktrees. Non-Git directories and repository subdirectories
use bounded copies (256 KB per file, 20 MB total). An incomplete copy falls back to
sequential execution instead of silently omitting files. Dependencies and caches
are not copied, so isolated directories may need their own dependency installation.
This separates working directories; it is not a security sandbox for CLI tools.

In "Writing code" mode, divide and test-first runs attempt automatic rollback
before the summary if built-in syntax checks still fail, or if the repair round
turns any previously passing verification gate into a failure: only the repair round is
undone when execution had no syntax errors; otherwise the task is restored to
its starting point. A verify command that already failed after execution, and did
not get worse, does not trigger rollback. A syntax-only pass is labeled as such
and is not merge-ready. The result card shows post-rollback verification, and withdrawn work remains
incomplete. Rollback uses bounded in-memory snapshots (256 KB per file, 20 MB
total), not a complete backup. Missing baselines, incomplete restores, and a
changed working-directory identity are reported; post-rollback verification is
skipped when the directory cannot be trusted.

When a message contains `@Name`, only the mentioned members reply (in parallel
if there are several). If you mention someone while a task is running, they see
the message on their next turn; if they do not get a turn before the task ends,
they reply once at the end.

You can send messages at any time while a task runs; they are shown to the next
member to speak. "Stop" terminates every CLI process. "New chat" clears the
conversation and each member's session memory.

## Member settings

Click a member card in the sidebar to edit it:

| Field                | Description                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI CLI               | Built-in Claude Code, Codex CLI, Cursor CLI, custom command, or an extension you added                                                                          |
| Model / version      | Read from each CLI's local model cache; only current, non-retired models are listed. Choose "Other" to type any model name                                      |
| Effort               | Options depend on the model; unsupported levels are lowered to the nearest supported one or skipped, and noted in the conversation                              |
| Role and personality | Goes into the system prompt and sets the member's stance and tone                                                                                               |
| Allow editing files  | When on, Claude runs with `--dangerously-skip-permissions`, Codex with `workspace-write`, Cursor with `--force`; when off, read-only (Cursor uses `--mode ask`) |
| Custom command       | The prompt goes to stdin and stdout is the reply; `{model}` and `{effort}` are available, e.g. `gemini -m {model} -p -`                                         |

The lead is chosen in Settings and is responsible for dividing the work and
summarizing.

**Project conventions**: `CLAUDE.md` or `AGENTS.md` in the working directory
(the first one found) is added to every member's system prompt, so you do not
have to restate the project's conventions every time. Long files are truncated,
and the conversation says so.

**Lineups**: the "Lineups" button next to Members saves the current setup: which
members take part, their roles and personalities, the lead, the flow and the
number of discussion rounds. One click switches back: the lineup's members are
enabled with the roles saved in it, and the others are paused. A lineup only
remembers which members it includes; it never changes their CLI, model or keys.
When the setup changes after a lineup is applied, the button marks it "modified"
so you can update the lineup or save a new one.

## Adding other CLIs and APIs

Bottom-left "⚙ Settings" → "CLIs & extensions" → "+ Add" adds another AI from a
template:

| Template                                          | Type   | Needs                                                                           |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| Grok CLI, Kimi Code CLI, Gemini CLI               | CLI    | The CLI installed                                                               |
| DeepSeek, Kimi (Moonshot), Grok (xAI), OpenRouter | API    | An API key (entered in the extension editor, or an environment variable)        |
| Ollama                                            | API    | Ollama running locally; run `ollama pull qwen3.8:27b-mlx` first for Qwen3.8 MLX |
| Blank CLI, blank API, Aider JS plugin             | Custom | Fill it in yourself                                                             |

- Ollama `qwen3.8:27b-mlx` (about 18 GB; at least 32 GB of memory recommended)
  can discuss, understand images, review, and perform restricted file edits
  through the bundled template; run `ollama serve` first. The template disables
  thinking by default. Editing requires all three conditions: the template
  enables tools, the member allows editing, and the divide run has another
  eligible reviewer. Only read, exact-text replacement, and small-file write
  tools are exposed, with path confinement and SHA-256 conflict protection.
  Operations enter an audit record for another member to review. If review does
  not complete successfully, the UI explicitly marks the change “not reviewed”;
  check the red/green diff yourself.
- When a definition is wrong, the settings page and the editor show the reason.
- The CLI templates follow the official docs and have not all been tested
  against the real CLIs.

Every field is described in [docs/adapters.en.md](docs/adapters.en.md).

## Model lists

Model list logic lives in `src/models.ts`; aliases and effort rules in
`src/model-rules.ts` (shared by the main process and the interface).

- Claude Code: `~/.claude/cache/model-catalog/*.json`, models whose `section` is
  `main`; with several files, the newest valid one wins.
- Codex: `~/.codex/models_cache.json`, excluding models whose `visibility` is
  not `list` or that have an `upgrade` (retired).
- Cursor CLI: runs `cursor-agent --list-models`, refreshed every 10 minutes.
  Cursor encodes effort in the model name (e.g. `claude-opus-5-thinking-high`),
  so there is no separate effort setting.
- Results are cached by file modification time and not re-read while the file is
  unchanged; the member editor re-fetches every time it opens, so an updated CLI
  cache is picked up without restarting.
- If no cache can be read, a built-in list is used and the editor says so.

## Attachments

Drag files onto the input box or click 📎. Supported: png / jpg / webp / gif /
txt / md / json / csv / log / pdf. Defaults: at most 10 files per message, 20 MB
per file, 50 MB in total. Validation happens in the main process (extension and
file content are both checked).

Attachments are stored in the app's data folder, never in the working directory.
How they reach a member depends on its capabilities:

- Local CLIs get the file path and read it themselves. CLIs with a restricted
  read scope (Claude Code, Gemini CLI) get a temporary copy under
  `.roundtable-runtime/` in the working directory, removed when the task ends,
  is stopped, or the app quits.
- APIs get text files inline; endpoints that declare image support get images
  attached, with an automatic text-only retry if the image is rejected. PDFs go
  only to CLIs that can read files; API members are told they cannot read them.

## Memory

Claude resumes with `--resume <session_id>`, Codex with
`codex exec resume <thread_id>`, Cursor with `--resume <chatId>`, so later turns
send only the new messages and save tokens. OpenAI-compatible APIs keep the
conversation history in app memory. Custom commands have no session, so they get
the full transcript every turn, capped by "Transcript limit".

CLI sessions are not written to history. When you resume a saved conversation,
each member's first turn receives the full transcript truncated to the limit
(the original task is always kept), after which only new messages are sent
again.

## ⚠️ Security notes

Extensions run commands with your user account's permissions, and JS plugins
have full Node.js access. Only install extensions you trust.

With "Allow editing files and running commands" on, Claude Code runs with
`--dangerously-skip-permissions`, Codex runs in the `workspace-write` sandbox
without confirmation prompts, and Cursor CLI auto-approves commands with
`--force`. The AI can create, modify and delete files and run commands inside
the working directory.

- Use a dedicated folder as the working directory; do not point it at an
  important project or your home directory.
- API keys entered in the extension editor are encrypted with the operating
  system's secure storage (the macOS keychain) and saved in `secrets.json`; they
  are never written to the extension JSON. A plain-text `apiKey` left in an
  extension file by older versions is migrated automatically on load.
- Keep the working directory under git so you can inspect and revert what the AI
  did.
- If you only want to watch a discussion, turn the option off or use "Discuss
  only, no execution".

## Notes

- Every CLI uses your existing login and subscription quota, and multi-round
  discussions burn through it quickly. Use a cheaper model and lower effort for
  discussion, and raise the effort for execution; when only one member is
  needed, use `@Name` instead of the full flow.
- Parallel execution can still conflict when several members edit the same file;
  the division prompt asks the lead to avoid overlap, but for complex tasks keep
  the working directory under git.

## Data locations

Everything is under `~/Library/Application Support/AI Roundtable/`; `sessions/`
and `adapters/` can be opened from "Settings → Data & logs":

| Path           | Contents                                                  |
| -------------- | --------------------------------------------------------- |
| `config.json`  | Members and settings                                      |
| `sessions/`    | Conversation logs (one JSON per conversation)             |
| `attachments/` | Attachments, removed together with their conversation log |
| `adapters/`    | Extension definitions                                     |
| `secrets.json` | Encrypted API keys                                        |

## Project layout

| Path                                                                        | Description                                                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main.ts`, `preload.ts`                                                     | Electron main process and the IPC bridge                                                                                                               |
| `src/ipc-types.ts`, `renderer/api.d.ts`                                     | IPC types shared by the main process and the interface                                                                                                 |
| `renderer/`                                                                 | The interface (HTML / CSS / TypeScript, bundled by esbuild); `app.ts` is the main program, `diff-view.ts` and `task-card.ts` are standalone components |
| `src/orchestrator.ts`                                                       | Discussion, division, execution, review and @-mention flow                                                                                             |
| `src/flow/`                                                                 | Self-contained parts of the flow: review pairing and verdicts, transcript truncation, git changes, plan parsing, message restore, the result card      |
| `src/snapshot.ts`, `src/task-changes.ts`                                    | Working-directory snapshots and "what did this task change"                                                                                            |
| `src/verify.ts`, `src/counterexample.ts`, `src/ratchet.ts`, `src/corpus.ts` | Automatic verification, executable counterexamples raised by reviewers, the "never get worse" ratchet, and the per-project counterexample corpus       |
| `src/adapters/`                                                             | Built-in adapters, extension loading, generic CLI / API adapters                                                                                       |
| `src/attachments.ts`, `src/session-log.ts`, `src/secrets.ts`                | Attachments, history, API key storage                                                                                                                  |
| `src/terminal.ts`, `src/pty.exp`, `renderer/terminal.ts`                    | Terminal tabs: the pty (borrowed from the expect that ships with macOS, so no native module) and the right-hand panel                                  |
| `src/git-check.ts`, `renderer/env-fix.ts`                                   | Environment problems: whether git can run on this machine, and the shared card that states what happened plus one thing to do about it                 |
| `src/models.ts`, `src/model-rules.ts`, `src/usage.ts`                       | Model lists, effort rules, usage normalization                                                                                                         |
| `adapters/templates/`                                                       | Extension templates shown under "+ Add"                                                                                                                |
| `docs/`                                                                     | Extension guide, interface copy spec, and [what is next](docs/next.en.md)                                                                              |
| `test/`                                                                     | Tests run by `npm test`; `test/e2e/` is the end-to-end run                                                                                             |
| `test/harness/`                                                             | Isolated real-Electron checks and screenshots; see the [harness guide](test/harness/README.md) for scenarios and usage                                 |
| `eval/`                                                                     | Review-quality evaluation and the solo-vs-roundtable experiment: real models on a fixed set of tasks; long runs resume from a journal                  |
| `dist/`                                                                     | Output of `npm run build`, which is what the app loads (not committed)                                                                                 |

## Contributing

Issues and pull requests are welcome; see
[CONTRIBUTING.en.md](CONTRIBUTING.en.md). Report security problems privately as
described in [SECURITY.en.md](SECURITY.en.md). Changes are listed in
[CHANGELOG.en.md](CHANGELOG.en.md).

## License

[PolyForm Noncommercial 1.0.0](LICENSE): individuals, research, education and
non-profit organizations may use, modify and share it for free; **commercial use
is not permitted**. For a commercial license, please
[contact the author](https://github.com/yanmin841111-byte).

The source is public, but because commercial use is restricted, this is not an
"open source" license as the OSI defines it. Versions published before the
switch to this license (including v0.1.0) were released under the MIT License,
and code obtained from those versions remains under MIT.
