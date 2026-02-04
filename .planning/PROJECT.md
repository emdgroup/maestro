# AI Agent Orchestrator

## What This Is

A desktop orchestration tool for managing autonomous AI coding agents. Users queue tasks on a Kanban board, and agents execute them in isolated git worktrees with real-time monitoring and human review gates. Built on Claude Code CLI with an extensible architecture for multi-agent workflows.

## Core Value

Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control—eliminating blocking waits while maintaining safety through worktree isolation and human-in-the-loop review.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Project initialization with git worktree setup
- [ ] Kanban board UI (Backlog → Ready → In Progress → Review → Done)
- [ ] Manual task creation with description, context, acceptance criteria
- [ ] GitHub/Jira issue import with auto-sync on project open
- [ ] Task configuration (model selection, MCP allowlist, Skills selection)
- [ ] Hybrid worktree pool management (pre-create pool, expand dynamically)
- [ ] Agent session execution using Claude Code CLI
- [ ] Real-time monitoring (live terminal output + file diff viewer)
- [ ] Embedded terminal with attach/detach for manual control
- [ ] Review workflow with IDE integration (open worktree in VS Code)
- [ ] Merge approval workflow with automatic worktree cleanup
- [ ] Autonomous mode (agent picks next Ready task after merge approval)
- [ ] Project settings UI for Claude Code configuration
- [ ] Project-level MCP server management (add, remove, enable, disable)
- [ ] Project-level Skills management (add, remove)
- [ ] Task-level MCP/Skills override (restrict per task)
- [ ] SQLite state persistence per project
- [ ] Error handling (pause for human intervention on agent failures)
- [ ] Project-level model default with task-level override

### Out of Scope

- Multi-project switching — defer to v2 (MVP focuses on single project workflow)
- Remote session management — defer to v2 (SSH tunneling architecture designed but not implemented)
- OpenCode and other CLI tools — defer to v2 (MVP is Claude Code only)
- Plugin marketplace — defer to v2 (leverage existing Claude Code plugin architecture)
- Multi-user collaboration — defer to v2+ (single user focus)
- Cloud relay for remote sessions — defer to v3+ (SSH tunneling sufficient)
- Custom worktree retention policies — defer to v2 (clean up immediately after merge)
- Webhook integration for issue sync — defer to v2 (auto-sync on open sufficient)

## Context

This tool synthesizes patterns from six existing tools evaluated by the user:
- **opcode**: Session management GUI with analytics
- **Crystal**: Multi-session parallel development
- **Automaker**: Kanban-driven workflow
- **AutoCoder**: Long-running autonomous agents
- **Auto-Claude**: QA validation pipeline
- **VibeTree**: Terminal management per worktree

Key architectural decisions stem from this research:
- Tauri over Electron (lighter, faster—inspired by opcode)
- Worktree isolation (Crystal, Auto-Claude pattern)
- Kanban orchestration (Automaker pattern)
- Autonomous loop with human gates (AutoCoder pattern)
- Terminal integration (VibeTree pattern)

The user has existing knowledge of the Claude Code ecosystem and evaluated these tools to identify gaps. This tool fills the gap for a unified orchestration layer with both on-demand and autonomous execution modes.

## Constraints

- **Tech Stack**: Tauri 2 + React + Rust backend + Node.js sidecar (for Claude Code CLI integration)
- **State Storage**: SQLite database per project (single .db file in `.toolstate/` directory)
- **MVP Scope**: Single local project only—no multi-project switching in v1
- **CLI Integration**: Claude Code CLI only in v1—architecture must support future CLI tools
- **Remote Protocol**: SSH tunneling (design for v2, not implement in v1)
- **Version Control**: Requires git repository (auto-initialize if needed)
- **Platform**: Desktop-first (macOS, Windows, Linux via Tauri)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tauri over Electron | Lighter weight (Rust vs Chromium), faster startup, better security model | — Pending |
| Rust + Node sidecar | Rust for performance, Node.js for Claude Code CLI integration (spawning processes, parsing output) | — Pending |
| SQLite for state | Queryable, single file, no server overhead, good tooling | — Pending |
| Hybrid worktree pool | Pre-create 3-5 worktrees for instant allocation, expand dynamically if exhausted, avoids pool exhaustion | — Pending |
| Cleanup after merge | Delete worktree + branch immediately after merge to main (prevents stale branches, keeps repo clean) | — Pending |
| React over Svelte | User preference despite Svelte's lighter weight and better Tauri integration | — Pending |
| GitHub-style workflow | Backlog → Ready → In Progress → Review → Done (familiar pattern, explicit review gate) | — Pending |
| Project-level defaults + task overrides | MCP/model/skills set at project level, restrict per task (balances convenience with control) | — Pending |
| IDE integration for review | Open worktree in VS Code for review (leverages familiar tools, full editing capability) | — Pending |
| Pause on agent error | Stop execution, notify user, wait for intervention (safety over autonomy) | — Pending |
| Auto-sync issues on open | GitHub/Jira issues sync when opening project (simpler than webhooks, good-enough freshness) | — Pending |

---
*Last updated: 2026-02-04 after initialization*
