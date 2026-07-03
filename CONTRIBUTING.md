# Contributing to Maestro

Maestro is an open-source desktop app for orchestrating AI coding agents. We welcome contributions from everyone — whether it's a bug fix, a new feature, better docs, or more test coverage. This guide tells you everything you need to get started.

Licensed under [Apache 2.0](LICENSE).

## Code of Conduct

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it before contributing.

## Before you start — CLA

All contributors must sign the Contributor License Agreement (CLA) before a PR can be merged. The CLA covers intellectual property rights and ensures we can distribute your contributions under the Apache 2.0 license.

> [Sign the CLA](https://cla-assistant.io/emdgroup/maestro) before opening a pull request.

## Ways to contribute

### Bug reports

Open a [bug report issue](https://github.com/emdgroup/maestro/issues/new?template=bug_report.yml). Include steps to reproduce, expected vs. actual behavior, and your OS/version. The more detail, the faster it gets fixed.

### Feature requests

Open a [GitHub Discussion](https://github.com/emdgroup/maestro/discussions) **before** writing any code. Describe the problem you're solving and your proposed approach. This prevents wasted effort on PRs that won't be accepted. Once there's maintainer agreement, open an issue and proceed.

### Docs and tests

Straight to a pull request — no prior discussion required for documentation fixes or test coverage improvements.

## Development setup

**Prerequisites:**

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Rust stable ([rustup.rs](https://rustup.rs))
- Tauri v2 CLI (`cargo install tauri-cli --version "^2"`)
- Platform-specific Tauri deps — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

**Clone and run:**

```bash
git clone https://github.com/emdgroup/maestro.git
cd maestro
pnpm install
pnpm tauri:dev
```

This starts both the Vite dev server and the Rust backend with hot-reload.

## Project structure

| Path                | What's there                                                      |
| ------------------- | ----------------------------------------------------------------- |
| `src/`              | React + TypeScript frontend (views, components, services, stores) |
| `src-tauri/`        | Rust Tauri backend (IPC handlers, DB, SSH, ACP sessions)          |
| `maestro-server/`   | Standalone binary that manages AI agent subprocesses              |
| `maestro-protocol/` | Shared message types between Tauri and maestro-server             |

See [`AGENTS.md`](AGENTS.md) for a deeper architecture walkthrough.

## Making changes

**Branch off `main`** using a short descriptive name:

```
feat/parallel-agent-view
fix/worktree-sync-race
docs/contributing-guide
test/task-status-transitions
```

**Commit style** — conventional commits:

```
feat: add parallel agent view
fix: resolve worktree sync race on reconnect
docs: add contributing guide
test: cover task status transitions
```

**Checks to run before pushing:**

```bash
pnpm lint          # oxlint
pnpm format        # oxfmt
pnpm test          # Vitest unit tests
cargo test         # Rust tests (run from repo root or src-tauri/)
```

**Changed a Rust model?** Regenerate TypeScript bindings:

```bash
pnpm tauri:gen
```

Commit the updated `src/types/bindings.ts` alongside your model change.

## Opening a pull request

1. Push your branch and open a PR against `main`.
2. Fill in the [PR template](.github/PULL_REQUEST_TEMPLATE.md) — Summary, Test Plan, Release Notes.
3. **PR title rules:**
   - Imperative mood, correctly capitalized (`Add parallel agent view`, not `adds view` or `Adding view`)
   - No conventional commit prefix in the title (`fix:` belongs in commits, not PR titles)
   - No trailing punctuation
   - Optionally prefix with a crate/area name when scope is clear (`maestro-server: Fix session leak`)
4. Ensure CI passes before requesting review.
5. At least one maintainer review is required to merge. We aim to respond within 7 days.

## Getting help

Stuck on setup or unsure whether your idea fits? Start a thread in [GitHub Discussions](https://github.com/emdgroup/maestro/discussions) — it's the best place for design questions and general Q&A.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
