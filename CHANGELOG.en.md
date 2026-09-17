[繁體中文](CHANGELOG.md) | **English**

# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

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
- `npm run dist` writes an unsigned dmg to `release/`; pushing a `v*` tag builds it and attaches it to a GitHub Release.

### Security

- The plain-text `apiKey` field in extension files is disabled; it is migrated to secure storage on load, and the file is rewritten only after the key is safely stored.
- A corrupt `secrets.json` is backed up first instead of being overwritten by the next key.
- Paths for attachments, history and extension files are always validated in the main process.

[Unreleased]: https://github.com/yanmin841111-byte/ai-roundtable/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yanmin841111-byte/ai-roundtable/releases/tag/v0.1.0
