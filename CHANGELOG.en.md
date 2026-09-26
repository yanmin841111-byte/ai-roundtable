[繁體中文](CHANGELOG.md) | **English**

# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Full Copilot model list**: member settings read every CLI-supported model from `copilot help config` (no quota used), listing `gpt-5-mini`, `claude-haiku-4.5` and `gpt-5.4-mini` first with a "low cost" label, and fall back to Auto plus those three. Actual availability still depends on organization policy. When members are missing, quick teams can create read-only Copilot members for those three models.
- **Quick teams**: the sidebar Lineups menu offers development and research presets. Preview and adjust planning, authoring and review roles for three existing members, then save and apply Multi-AI checks with independent-first discussion. Models, connections, edit permissions and other lineups remain unchanged; applying never starts a task. Missing members, an eligible development author or a working folder have setup actions. Custom commands are explicitly marked untested. Roles are prompt presets, not additional permission isolation.
- **Multi-AI checks mode**: select "Multi-AI checks" under Collaboration with at least two enabled members, from any supported providers. Discussion must reach unanimous agreement, and the lead's concrete plan must list acceptance criteria and receive every other member's approval before execution; plan revisions use the discussion round limit. Every result is reviewed by all non-authors in fresh contexts, checking each acceptance criterion; with only two members, the author also reviews in a fresh context as the second reviewer, matching the common Claude Code × Codex cross-review practice. Up to three repair rounds rerun verification and send all results back for review; failed reviews, missing approvals or failed verification block approval. Lineups preserve the mode, and result cards and history exports retain gate status and repair counts. General tasks are supported without code verification; unanimous AI approval is not human acceptance or a deployment guarantee. More members mean more review calls and model usage.
- **One-click install for built-in CLIs**: when Claude Code, Codex CLI, GitHub Copilot CLI or Cursor CLI is missing, settings, member settings and turn errors offer "Install…". Official install methods are ordered for macOS / Windows / Linux and the Homebrew, WinGet or npm already present; the exact command is shown and runs only after the user starts it. The UI sends identifiers only, and the main process builds commands from a fixed list. Afterwards the app guides sign-in and re-checks; sign-in and subscriptions remain the user's step.
- **Resizable layout**: sidebar width and input height can be dragged or adjusted with arrow keys, reset by double-click, and are saved. Limits keep room for the conversation.
- **General discussion policy**: sequential or independent-first discussion for every adapter and flow, persisted in settings and lineups. The independent round omits transcripts and resumed sessions, defers questions and consensus until all finish, and always leaves a critique round. Old settings remain sequential.
- **Multi-condition evaluation infrastructure**: independent-first discussion, sequential/independent isolated candidates, and repeated solo attempts selected by public ratchet gates under a token target. Per-candidate evidence and failing-test IDs are retained; Jaccard reports both-correct and unavailable pairs separately. Hidden scores never select a candidate. Dry runs, an approval flag and source/protocol fingerprints protect preregistration and resumption. No new formal model experiment has run.
- **Counterexample evidence on result cards**: result cards now preserve and display each counterexample's title, reviewer, confirmation state, post-repair state and bounded execution output; text exports and history carry the same evidence. Older records explicitly say the evidence was not saved instead of treating missing data as no issue.
- **Counterexamples**: alongside prose, a reviewer can attach an executable Node.js script (a ` ```counterexample ` block) that must fail against the current code. The app runs it once, giving three outcomes: a genuine failure is _confirmed_ and becomes a gate the repair round has to pass; a script that unexpectedly passes is _unsubstantiated_ — reported honestly, but never used to force a fix; a script that cannot run at all counts for neither side. Whether something got fixed is decided by the app re-running it, not by any member's claim. Scripts run from throwaway files at the top of the working directory, are deleted afterwards, and never count as a member's changes. At most 3 per review.
  Why: experiment 7 showed the reviewer's diagnosis was already good enough (once finding 5 problems during discussion, one more than were planted). The loss happened in translating that diagnosis into prose for a weaker model to act on.
- **Counterexample corpus**: confirmed counterexamples are stored in `.roundtable/counterexamples.json` inside the working directory, so they travel with the project and can be committed. They run again before every future task, which makes last month's bug visible if it is reintroduced this month. Capped at 50 entries / 256 KB; when full it says so rather than silently dropping the oldest. Retiring a stale claim is a one-line deletion.
- **Ratchet**: syntax checks, verify commands and counterexamples are flattened into one vector of boolean gates, measured before the task, after execution and after repair. Any gate going from passing to failing triggers an automatic rollback — either of the repair alone or of the whole task. Only gates measured on both sides are compared; a gate present on one side only is "unknown", never a fabricated regression. Gates that were already failing are not this task's responsibility.
  Why: experiment 7 found no difference in the primary metric, but the roundtable doubled both tails — 6/16 improved and 6/16 badly damaged, against 3/16 each for solo. The ratchet does not make models more accurate; it removes the lower half of the distribution.
- **Pre-task baseline**: in coding mode, the verify command and the corpus counterexamples run once before any member starts, recording which gates were already passing. Without it, "execution broke this" and "it was already broken" are indistinguishable — experiment 7's poker-fix solo runs took a 35/39 starting point down to 1/39, and the old check only compared post-execution against post-repair, so it never saw it.

### Changed

- **Relay merged into Multi-AI checks**: Multi-AI checks now run the approved plan's steps in order, handing each step's report to the next so nobody reads files while another member is changing them. "Relay" is no longer listed as a collaboration option; saved settings and lineups using relay become Multi-AI checks with three or more members, or Parallel with fewer. The evaluation's team-relay condition still uses the original relay flow.
- CLI members with edit permission are read-only during discussion, planning, plan approval, review and summary turns; only execution and repair turns can write.
- **Git commits off by default**: a new "Allow members to create git commits" setting. While off, plans do not include commits or pushes, and GitHub Copilot members are blocked from `git commit` and `git push` through CLI permission rules; other CLIs are only asked not to.
- Agreement accepts `[AGREED]` at the end of the final line (not inside quotes or negated). Plan approval and result reviews only reject for wrong results, unmet requirements or factually wrong statements; suggestions still pass. Plans no longer give command work to read-only members or add unrequested git commits, and read-only members rejected under Multi-AI checks can rewrite their report for another review.
- **Easier AI connections**: the settings tab is renamed "AI connections" and leads with local models and ready-made AI services; custom CLIs, JSON and file names move under advanced options. API keys can be shown or hidden, known providers link to their key pages, and basic edits keep template conditional arguments and model metadata.
- **General-purpose workspace**: terminal, export and new chat move under "More tools", Stop sits next to Send, and compact pills separate "Task type" from "Collaboration". A missing working folder shows a "Choose a working folder" button. Visuals add a subtle glow, dot grid and consistent radii; animations stop when reduced motion is requested.
- The README distinguishes unproven roundtable benefits from disproven ones, notes that Claude Code + Codex has not been measured, and limits ratchet/counterexample claims to their actual evidence.
- The rollback decision moved from "did the repair turn a passing verification into a failing one" to the ratchet above. It adds a baseline comparison and can see fine-grained gates: a project verify command is one coarse boolean, where "3 tests failing" and "10 tests failing" look identical.
- Evidence tiers: only the user's own gates (syntax checks, verify commands) and counterexamples confirmed during this task can trigger an automatic rollback. Counterexamples inherited from the corpus still run and are still reported, but do not trigger a rollback on their own — an old counterexample may test the wrong requirement, and a task may be deliberately changing that behaviour. The principle: **the more independently verifiable something is, the more weight it carries**.

### Fixed

- Failed lineup saves preserve the original main-process and UI settings, do not report successful application, and keep the team preview available for retry.
- Timeline stage headers no longer stick together, overlap, or cover messages. After scrolling past a stage, one current-stage pill remains and fades out before the next stage or "Task finished" divider.
- Member settings fields align at the top, and a missing CLI no longer repeats the same command-not-found message.
- OpenAI-compatible API turns now total token usage across tool requests and fallback retries, preserving per-request records. Missing fields remain unknown instead of treating the last response as the complete token budget usage.
- Independent-first rounds no longer mark attachments as seen by the persistent session, so the second round still receives new attachments when resuming an older session.
- Counterexample cards and exports explicitly report when no post-repair rerun occurred instead of labeling the initial result as "Passed after repair".
- A repair round that breaks any previously passing verification gate is rolled back automatically and reverified, not only when syntax breaks. The work remains incomplete.
- Two or more members who can edit files now execute in separate directories. Only non-overlapping changes are merged back. Unmerged versions are retained and marked incomplete; unavailable isolation falls back to sequential execution. Interrupted CLI work is reviewed using per-member change evidence.
- A dedicated reviewer who identified issues can take over repairs with existing edit permission and an independent third-party re-check. Test-writing and repair turns run sequentially to avoid concurrent overwrites in the shared directory.
- A built-in syntax check without a project verify command is labeled "syntax check only" instead of looking like a completed verification.

## [0.2.1] - 2026-09-22

### Fixed

- Use the existing blue concentric-ring logo as a multi-resolution macOS app icon in Finder, the Dock and installers instead of Electron's default icon. The sidebar and development mode use the same PNG; regenerate the assets with `npm run icons`.

## [0.2.0] - 2026-09-22

This release adds the built-in terminal, test-first flow, automatic verification, environment repair, rollback, lineups and an acceptance workspace, with UI and UX refinements.

### Added

- Result cards prioritize outstanding issues, verification evidence and file changes; model approval no longer implies merge readiness. Checked time, file scope, commands, exit codes and bounded output are saved. Unsupported, over-limit, unavailable and skipped-after-failure checks are distinguished. History and text exports retain the evidence; older records explicitly show when evidence is missing.
- Manual acceptance timing supports start, pause, accepted/incomplete outcomes and per-task JSON export. Records stay in local Electron localStorage, separate from the conversation, with no upload; reopening does not count offline time. Timed intervals are not automatically measured active work or evidence of reduced review effort. Existing task duration still excludes discussion and planning.
- Verification evidence is tied to a bounded content fingerprint. Returning to the app, comparing manually, accepting and exporting check whether the latest live task still matches its evidence and configured commands; this is not continuous monitoring or filesystem isolation. The fingerprint excludes dependencies, caches, version-control and app staging directories, covers at most 10,000 files and 20 MiB, and reports unknown for incomplete, unreadable or symlinked scope. It does not verify environment or requirement correctness. Historical conversations are never trusted as current evidence or command authority.
- The latest live task can be reverified after confirming the current working directory and configured commands, without model calls, automatic repair or automatic rollback. Commands can modify files; changes during checks make the evidence stale. Earlier verification records remain available, and earlier reviewer conclusions or human acceptance do not automatically apply to a new version. JSON exports distinguish historical acceptance from current-version acceptance and include verification evidence. General tasks can still record manual acceptance without claiming file-version verification.

- Cross-review now runs with a clean context: the reviewer sees the requirements, the other member's report, the actual changes and the verification result, but not the discussion or execution, and does not resume its own conversation memory. The file operations actually performed are attached to the prompt instead.
- Test-first flow (Discuss → Write tests → Implement → Cross-review): acceptance criteria become tests first, and those tests are locked during implementation.
- Project conventions: `CLAUDE.md` or `AGENTS.md` in the working directory is added to every member's system prompt.
- A way out: the result card can revert the working directory to how it was before the task; files that cannot be restored are listed.
- The verify command can be several gates (one per line, run in order); it stops at the first failure and says which gate failed and which passed before it.
- When members change the same file in parallel it is pointed out, and reviewers are asked to check that the contents are not half-overwritten.
- Work mode (switchable next to the composer): "Writing code" verifies changes automatically and locks test files that existed before the task, so a repair cannot make the result pass by editing tests; "General task" (documents, analysis, brainstorming) skips both. Lineups remember the work mode too.
- One shared flow for environment problems: whatever is wrong, the app states it plainly and offers the same next step — "Run in terminal" (the command is typed into the built-in terminal, never run automatically) or "Open install guide". What this fixes: when git cannot run on this Mac (developer tools missing, or the Xcode license not accepted), the app used to call it "this working directory is not a Git repository" and tell people to run `git init`, which never helped; it now names the real cause, offers the fix, and "File changes" falls back to the before/after comparison of the last task so the feature keeps working. Macs without the developer tools are also no longer asked to run git on every check, which avoided the system install dialog. Member model settings gained a status card: before you pick a model, it says whether that CLI or API is installed, signed in and reachable. Failures inside the conversation count too: when a turn fails, the app checks that CLI or API's health once and attaches the next step under the error message (not signed in → the sign-in command, not installed → the install guide, missing key → open settings); if the health check says everything is fine, no button is invented. The suggestion is never written into the saved transcript — environments change, and saved files can be edited by hand. The verify command is distinguished too: when the configured command does not exist, the app says it was not found and offers "Open settings", instead of reporting "failed (exit code 127)" and sending people to read code. Extension templates can declare `fixCommand` (for example `ollama serve`) and `docsUrl`, and JS plugins can return `fix` from `check()` and `run()`; the interface renders all of them the same way.
- Built-in terminal: ⌘J (or the "Terminal" button in the toolbar) opens a panel on the right, in the same working directory the members use. Each tab runs on a real pty — colors, Ctrl-C, vim and the AI CLIs all behave normally — with several tabs, a draggable left edge, theming that follows the app, and a remembered width. The pty comes from the expect that ships with macOS, so no native module is added and packaging is unchanged.
- Automatic verification: after execution and after a repair, the app checks that the changed `.js`/`.json` files load and runs the "verify command" you configure (for example `npm test`). The result goes to the reviewers, a failure must be fixed, and it appears on the result card, so "approved" is no longer just a model's opinion. The evaluation showed reviewers approving code that could not even be loaded. Inside the app the syntax check must run as node (`ELECTRON_RUN_AS_NODE`): without it `process.execPath` is Electron, `--check` is ignored, and the file is executed instead of parsed — a broken file passes and a member's test file gets run.
- Solo vs roundtable experiment (`npm run eval:ab`): the same model does the same task alone and with review and repair, several times each, scored by hidden tests the model never sees, comparing how often each gets it right and how long it takes; the reviewer can be a different model. `--journal` makes a run resumable: every finished run is one line, the same command fills in only what is missing, and entries from a different commit are never reused and are reported as skipped.
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
- A quieter graphite workspace with blue primary actions, less glow, fewer decorative gradients and smaller corners. Tool icons, keyboard focus and bilingual tooltips are consistent. Result cards place evidence and changed files before human acceptance, with expandable member details and no duplicate acceptance of the current version. Compact composer labels retain full workflow tooltips, controls wrap when the terminal opens, and attachment warnings are no longer truncated. Member rows support keyboard activation, and dark-mode primary controls have stronger contrast.
- Once the lead's plan output (usually JSON) parses, it is folded away and only the plan card is shown; output that failed to parse stays fully visible.
- System messages, errors and API adapter messages from the main process follow the interface language, and so do the file-tool descriptions, errors and memory placeholders the model reads, so an English meeting no longer gives the model mixed-language instructions.
- Status lights turn green only when things actually work: cloud API keys are verified when settings open, unreachable endpoints show an actionable hint, and member cards flag CLIs that are missing or not logged in.
- Paths in Changes are always relative to the repository root.

### Fixed

- Read-only Claude Code members failed every time: the app passed `--restricted`, which the current CLI does not have, so claude exited with "unknown option". Read-only mode only needs `--permission-mode dontAsk` (verified: it refuses when asked to write files). The fake CLI used in tests accepts any flag, so the old tests stayed green; flags are now checked against the real `claude --help`.
- For analysis-only work, a reviewer could point out that the report's conclusion was wrong yet still declare no issues because no file needed to change, letting the wrong conclusion through. The review prompt now says that a wrong statement or conclusion in the report also counts as something to fix. On this evaluation task, local Qwen went from 3 correct out of 6 runs to 6 out of 6.
- After a member's turn fails, its next turn receives the messages it missed instead of losing the context.
- Elements marked hidden no longer take up space because of a stylesheet rule (for example an empty warning box under every message).
- A series of review fixes: Chinese file names, a working folder that is a subfolder or gitignored, commits made by a member, and files already modified before the task are all listed correctly; a model that rejects tools gets the request again without them; file contents attached for a reviewer are not kept in an API member's conversation memory; pressing Stop during a snapshot really stops.
- `read_file` clamps a `limit` above 65536 instead of rejecting the call; `truncated` is set only when content is omitted. SHA checks, exact unique matching, create-only protection, and per-turn budgets remain in place.
- Code tasks ending with a built-in syntax-check failure automatically roll back and reverify: only the repair round is undone when syntax passed after execution; otherwise the whole task is restored. Failed repair turns are also rechecked. Result cards show the restored files and verification result without treating withdrawn work as delivered. Missing baselines and incomplete restores are reported explicitly. A failing verify command alone does not trigger automatic rollback.

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

[Unreleased]: https://github.com/yanmin841111-byte/ai-roundtable/compare/481bb88...HEAD
[0.2.0]: https://github.com/yanmin841111-byte/ai-roundtable/compare/v0.1.0...481bb88
[0.1.0]: https://github.com/yanmin841111-byte/ai-roundtable/releases/tag/v0.1.0
