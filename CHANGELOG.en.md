[繁體中文](CHANGELOG.md) | **English**

# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- One shared flow for environment problems: whatever is wrong, the app states it plainly and offers the same next step — "Run in terminal" (the command is typed into the built-in terminal, never run automatically) or "Open install guide". What this fixes: when git cannot run on this Mac (developer tools missing, or the Xcode license not accepted), the app used to call it "this working directory is not a Git repository" and tell people to run `git init`, which never helped; it now names the real cause, offers the fix, and "File changes" falls back to the before/after comparison of the last task so the feature keeps working. Macs without the developer tools are also no longer asked to run git on every check, which avoided the system install dialog. Member model settings gained a status card: before you pick a model, it says whether that CLI or API is installed, signed in and reachable. Failures inside the conversation count too: when a turn fails, the app checks that CLI or API's health once and attaches the next step under the error message (not signed in → the sign-in command, not installed → the install guide, missing key → open settings); if the health check says everything is fine, no button is invented. The suggestion is never written into the saved transcript — environments change, and saved files can be edited by hand. The verify command is distinguished too: when the configured command does not exist, the app says it was not found and offers "Open settings", instead of reporting "failed (exit code 127)" and sending people to read code. Extension templates can declare `fixCommand` (for example `ollama serve`) and `docsUrl`, and JS plugins can return `fix` from `check()` and `run()`; the interface renders all of them the same way.
- Built-in terminal: ⌘J (or the "Terminal" button in the toolbar) opens a panel on the right, in the same working directory the members use. Each tab runs on a real pty — colors, Ctrl-C, vim and the AI CLIs all behave normally — with several tabs, a draggable left edge, theming that follows the app, and a remembered width. The pty comes from the expect that ships with macOS, so no native module is added and packaging is unchanged.
- Automatic verification: after execution and after a repair, the app checks that the changed `.js`/`.json` files load and runs the "verify command" you configure (for example `npm test`). The result goes to the reviewers, a failure must be fixed, and it appears on the result card, so "approved" is no longer just a model's opinion. The evaluation showed reviewers approving code that could not even be loaded.
- Solo vs roundtable experiment (`npm run eval:ab`): the same model does the same task alone and with review and repair, several times each, scored by hidden tests the model never sees, comparing how often each gets it right and how long it takes; the reviewer can be a different model.
- Review-quality evaluation (`npm run eval`): a real model reviews six fixed tasks (an obvious bug, a correct control, odd-looking but correct code, a bug beyond the attached-content limit, a bug outside the changed files, and analysis without edits) and gets a score. Result files hold only numbers, so they are safe to share.
- Lineups: save who takes part, their roles, the lead, the flow and the number of discussion rounds, and switch back with one click from the sidebar. A lineup only remembers which members it includes and never changes their CLI, model or keys; changes made after applying one are marked "modified".
- API members (Ollama and the cloud API templates) can read and edit files through three restricted file tools. They are offered only when the template opts in, the member allows editing, and another member can review the change; every call is recorded in the transcript so the reviewer sees what actually happened.
- In cross-review every reviewer sees the actual changes, in a way that fits it: CLI members open the files themselves; API members with file tools get a read-only `read_file` plus the file contents inline; everyone else gets the contents inline. Changes come from a snapshot of the working folder before and after execution, so git is not required.
- Review messages show a verdict badge (approved, issues raised, review failed) and what the reviewer looked at; clicking a file name opens Changes on that file.
- Model abilities: whether an API member's model can call tools and see images, shown on the member card and in member settings. Ollama is checked automatically and model data from the endpoint is used as is; paid APIs send requests only when you press Test in member settings. A model known to lack tool calling is treated as a read-only member; a model known not to see images is no longer sent images, and the pre-send warning names it.
- Changes works when the working folder is not a git repository (the default workspace is not): small text files are remembered in memory when a task starts, and Changes lists what changed since the latest task started, line by line.
- The extension editor has a “Time limit per turn” field (in minutes), and an extension's timeout error says where to raise it.
- Task result card: when a divide task finishes, one card shows each member's outcome and review verdict, the files this task changed (click to open them in Changes), and the time and tokens it took.
- Failed @ direct replies can be retried with one click.
- Long turns show what is happening, the elapsed time, and a notice when nothing has progressed for a while.
- Claude Code and Codex that are installed but not logged in are detected, with the command to run to log in.
- A warning before sending when an attached image cannot reach a member.
- Development: `npm run harness:ui` drives the real app through interface scenarios and keeps screenshots; CI runs it too and uploads the screenshots on failure.

### Changed

- Cross-review closes two gaps found by the `eval:ab` evaluation: a member whose execution stopped partway after changing files used to skip review, leaving broken files unchecked, and is now reviewed; after a repair, the original reviewer re-checks the work, which counts as approved only if the re-check passes, and anything still wrong goes into the summary. Reviewers are also asked to check each requirement of the task, and suggestions that do not affect correctness no longer count as something to fix.
- The license changed from MIT to [PolyForm Noncommercial 1.0.0](LICENSE): free for personal, research, education and non-profit use; commercial use is not permitted. Versions published before the change (including v0.1.0) remain under MIT.
- A visual refresh across the interface: cool-toned neutrals, brand-blue gradients and glows, a faint dot-grid background, a frosted top bar, thinner lines and tabular numerals; both the light and dark themes were retuned.
- Once the lead's plan output (usually JSON) parses, it is folded away and only the plan card is shown; output that failed to parse stays fully visible.
- System messages, errors and API adapter messages from the main process follow the interface language, and so do the file-tool descriptions, errors and memory placeholders the model reads, so an English meeting no longer gives the model mixed-language instructions.
- Status lights turn green only when things actually work: cloud API keys are verified when settings open, unreachable endpoints show an actionable hint, and member cards flag CLIs that are missing or not logged in.
- Paths in Changes are always relative to the repository root.

### Fixed

- For analysis-only work, a reviewer could point out that the report's conclusion was wrong yet still declare no issues because no file needed to change, letting the wrong conclusion through. The review prompt now says that a wrong statement or conclusion in the report also counts as something to fix. On this evaluation task, local Qwen went from 3 correct out of 6 runs to 6 out of 6.
- After a member's turn fails, its next turn receives the messages it missed instead of losing the context.
- Elements marked hidden no longer take up space because of a stylesheet rule (for example an empty warning box under every message).
- A series of review fixes: Chinese file names, a working folder that is a subfolder or gitignored, commits made by a member, and files already modified before the task are all listed correctly; a model that rejects tools gets the request again without them; file contents attached for a reviewer are not kept in an API member's conversation memory; pressing Stop during a snapshot really stops.

## [0.1.0] - 2026-09-17

First release.

### Added

- Roundtable flow: members discuss in turn, the lead divides the work, members execute in parallel, cross-review, a repair round, and a summary; plus a "Discuss only, no execution" mode.
- Built-in Claude Code, Codex CLI, Cursor CLI and custom-command adapters, with model lists read from each CLI's local cache.
- Extension system: describe a CLI or an OpenAI-compatible API in JSON, or write a JS plugin; templates for Grok, Kimi, DeepSeek, Gemini, OpenRouter, Ollama and blank starters.
- Basic settings tab and API connection test in the extension editor, with API keys encrypted using the operating system's secure storage.
- Attachments: drag and drop or pick images, text files and PDFs; members get a path, inline text or an image depending on their capabilities.
- History: tasks are saved automatically when they end and can be previewed, deleted, exported to Markdown, and resumed.
- `@Name` mentions: only the mentioned members reply; a mention during a running task is guaranteed a reply before the task ends.
- Parallel replies (execution, review, repair, and several mentioned members) are shown three to a row.
- Usage normalization and totals across CLIs and APIs.
- Light, dark and system themes, and a text size setting.
- Interface language: Traditional Chinese and English (optionally following the system); system messages, prompts and exported Markdown switch with it.

### Changed

- The main process, interface and tests are written in strict TypeScript; `npm start` builds into `dist/` first, and the interface is bundled by esbuild.
- IPC type definitions are shared by the main process and the interface.
- GitHub Actions CI runs type checks, tests, the build and the end-to-end run (`npm run e2e`, a full flow with fake members) on every push and pull request.
- The built-in Claude Code and Codex CLI adapters have tests that replay recorded stream-json events.
- `npm run dist` writes Apple Silicon and Intel dmgs to `release/` (ad-hoc signed, not notarized); pushing a `v*` tag builds them and attaches them to a GitHub Release.

### Security

- The plain-text `apiKey` field in extension files is disabled; it is migrated to secure storage on load, and the file is rewritten only after the key is safely stored.
- A corrupt `secrets.json` is backed up first instead of being overwritten by the next key.
- Paths for attachments, history and extension files are always validated in the main process.

[Unreleased]: https://github.com/yanmin841111-byte/ai-roundtable/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yanmin841111-byte/ai-roundtable/releases/tag/v0.1.0
