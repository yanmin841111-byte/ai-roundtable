[繁體中文](CONTRIBUTING.md) | **English**

# Contributing

Thanks for helping improve AI Roundtable. Bug reports, extension templates, documentation fixes and code are all welcome.

## Reporting problems

Search the [issues](https://github.com/yanmin841111-byte/ai-roundtable/issues) first. When opening a new one, include:

- macOS version, Node.js version, and the CLIs and versions involved (the CLI status in the bottom-left corner shows them)
- Steps to reproduce, expected result, actual result
- Relevant error messages or screenshots

Before pasting logs or config files, remove API keys, tokens, private paths and project contents. Do not report security problems in a public issue; follow [SECURITY.en.md](SECURITY.en.md) instead.

## Development setup

```bash
git clone https://github.com/yanmin841111-byte/ai-roundtable.git
cd ai-roundtable
npm install
npm start
npm test
```

The code is TypeScript. `npm start` builds into `dist/` and then launches Electron; after a change, run `npm start` again. Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Type-check both tsconfigs (main process and interface) |
| `npm test` | Run `test/*.test.ts` directly through `tsx`, no build needed |
| `npm run build` | Compile the main process with `tsc`, bundle the interface with esbuild, copy static files to `dist/` |
| `npm run smoke:dist` | Confirm the CommonJS output in `dist/` loads |
| `npm run e2e` | Build, then launch the real Electron app and run a full roundtable, attachments, @-mentions and history with fake members (`test/e2e/`); no CLI needs to be installed |
| `npm run harness:ui` | Build, then run the interface scenarios (`test/harness/scenarios/`) to check that status lights, badges, review verdicts, model abilities and the like tell the truth, keeping screenshots; fake members only, about 1–2 minutes, also run in CI |
| `npm run eval` | Review-quality evaluation: a real model reviews a fixed set of tasks and gets a score (see [eval/README.en.md](eval/README.en.md)); needs a real model, not run in CI |

Handy environment variables and flags during development:

| Setting | Purpose |
| --- | --- |
| `--user-data-dir=<folder>` | Start with a separate data folder so your own members, history and API keys are untouched, e.g. `npm start -- --user-data-dir=/tmp/ar-dev` |
| `AI_ROUNDTABLE_ADAPTERS_DIR` | Use a different extensions folder, handy while developing an extension |
| `AI_ROUNDTABLE_DEBUG=1` | Print the interface's console messages to the terminal |
| `AI_ROUNDTABLE_SHOT=<png>` | Take a screenshot after launch; with `AI_ROUNDTABLE_SHOT_JS` you can run a snippet of JS in the interface first (for example to insert demo messages) |
| `AI_ROUNDTABLE_SHOTS_DIR` | Where `harness:ui` stores its screenshots (default: `ai-roundtable-shots/` in the system temp folder) |

## Sending a pull request

1. Branch from `main`; one PR per change.
2. Add tests for behaviour changes. Run `npm run typecheck` and `npm test` before sending, and `npm run e2e` and `npm run harness:ui` when the flow or the interface changed.
3. Attach screenshots for interface changes, checked in both the light and the dark theme.
4. When a user-visible feature or setting changes, update `README.md`, `docs/` and the "Unreleased" section of `CHANGELOG.md` (and their English counterparts).
5. In the PR description, say what changed, why, and how you verified it.

Commit messages start with an English imperative verb and summarize the change in the first line, e.g. `Add Cursor CLI adapter`.

## Code and copy conventions

- Interface text, code comments and documentation are written in Traditional Chinese; the English documents are translations.
- Interface wording follows [docs/ui-copy.md](docs/ui-copy.md); update that file when adding or changing copy.
- Copy is not written inline: interface text lives in `renderer/i18n.ts` (HTML uses `data-i18n` markers), and the main process's system messages, prompts and export text live in `src/text.ts`. Both files must provide Traditional Chinese and English.
- Styles use only the existing colour variables in `renderer/style.css` (`--panel`, `--accent`, `--border` and so on). New components must work in the light, dark and "system" themes and respect `prefers-reduced-motion`.
- The main process validates and accesses files; paths, ids and numbers coming from the renderer are never trusted.
- Comments explain why, not what the code does.
- Tests are plain Node.js scripts (`test/*.test.ts`) with no test framework; any file under `test/` ending in `.test.ts` is run by `npm test`.
- IPC argument and result types are centralized in `IpcContract` in `src/ipc-types.ts`. Change it first when adding or modifying a channel; a mismatch with `handle()` in the main process or `invoke()` in `preload.ts` fails to compile.
- User JS plugins (`adapters/templates/*.js`) are loaded by the main process at runtime and stay plain JavaScript; they are not built.

## Extension templates

Useful CLI or API definitions are welcome in `adapters/templates/`; the fields are described in [docs/adapters.en.md](docs/adapters.en.md). In the PR, please state:

- Which CLI or API version you tested against; if untested, say so in the template's `description`
- Whether the service supports resuming, editing files, images and so on, and what the `capabilities` are based on

## Evaluation scores

Scores for the model you use are welcome: run `npm run eval -- --runs 10 --save` and send the one file it creates in `eval/results/` as a PR. The file holds only the model name, versions, the date and per-task scores, never any conversation. See [eval/README.en.md](eval/README.en.md).

## License

Contributions are released under the [MIT License](LICENSE).
