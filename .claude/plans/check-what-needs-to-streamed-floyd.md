# Remove code-review-graph and gsd from Maestro

## Context

User wants to strip two Claude Code integrations from the project:
- **code-review-graph**: MCP server providing structural graph analysis; referenced in CLAUDE.md as mandatory first tool for code exploration
- **gsd**: "Get Shit Done" framework v1.42.3; ~12 hooks, 200+ files, manifest/state tracking in `.claude/`

Neither is part of the Maestro app itself — they're DX tooling layered on top of Claude Code. Removing them simplifies the project's Claude Code config and eliminates their hook overhead on every session.

---

## What to Remove

### code-review-graph

| File | Action |
|------|--------|
| `.mcp.json` | Remove `"code-review-graph"` server entry |
| `.gitignore` | Remove `# Added by code-review-graph` + `.code-review-graph/` lines |
| `.code-review-graph/` | Delete entire directory |
| `.claude/settings.local.json` | Remove `mcp__code-review-graph__semantic_search_nodes_tool` from allowlist |
| `CLAUDE.md` | Delete "Tool Selection Priority (MANDATORY)" section (lines ~13–27) |
| `.claude/skills/explore-codebase.md` | Delete file (skill wraps code-review-graph tools) |

### gsd

All files are under `.claude/` in the project root:

| Path | Action |
|------|--------|
| `.claude/settings.json` | Remove all `gsd-*` hook entries from `SessionStart`, `PreToolUse`, `PostToolUse` |
| `.claude/hooks/gsd-check-update.js` | Delete |
| `.claude/hooks/gsd-check-update-worker.js` | Delete |
| `.claude/hooks/gsd-context-monitor.js` | Delete |
| `.claude/hooks/gsd-phase-boundary.sh` | Delete |
| `.claude/hooks/gsd-prompt-guard.js` | Delete |
| `.claude/hooks/gsd-read-guard.js` | Delete |
| `.claude/hooks/gsd-read-injection-scanner.js` | Delete |
| `.claude/hooks/gsd-session-state.sh` | Delete |
| `.claude/hooks/gsd-statusline.js` | Delete |
| `.claude/hooks/gsd-update-banner.js` | Delete |
| `.claude/hooks/gsd-validate-commit.sh` | Delete |
| `.claude/hooks/gsd-workflow-guard.js` | Delete |
| `.claude/gsd-install-state.json` | Delete |
| `.claude/gsd-file-manifest.json` | Delete |
| `.claude/.gsd-profile` | Delete |
| `.claude/gsd-local-patches/` | Delete entire directory |
| `.claude/gsd-migration-journal/` | Delete entire directory |

### Out of scope (user-level, not project)

These live in `~/.claude/` and affect all projects — not touched unless user explicitly wants:
- `~/.claude/hooks/gsd-*` (12 files)
- `~/.claude/skills/gsd-*` (66 skills)
- `~/.claude/settings.json` gsd hook entries

---

## CLAUDE.md Changes

Remove this entire section from `CLAUDE.md`:

```
## Tool Selection Priority (MANDATORY)

Before exploring code with Grep, Glob, Read, or LSP — STOP. Use code-review-graph MCP tools first. This applies to ALL code understanding tasks: finding definitions, tracing callers, understanding impact, reviewing changes.

**Decision gate:**
1. Can the graph answer this? → Use `semantic_search_nodes`, `query_graph`, `get_impact_radius`, `detect_changes`
2. Need precise type info or jump-to-definition? → Use LSP tool
3. Code pattern search? → Use `ast-grep` (see `.claude/ast-grep.md`)
4. String literals, config files, full file reads? → Fall back to Grep/Glob/Read

**Why this matters:** The graph resolves structural queries in 1 call that take 5+ text searches. Using Grep first wastes tokens and misses transitive dependencies.
```

---

## settings.json Changes

Keep all non-gsd hooks (e.g. caveman). Strip only entries where `command` path contains `gsd-`.

---

## Verification

1. Open new Claude Code session in maestro — no gsd banner, no hook output
2. `cat .mcp.json` — no code-review-graph entry
3. `ls .claude/hooks/` — no `gsd-*` files
4. `ls .code-review-graph/` — directory gone
5. Grep CLAUDE.md — no "code-review-graph" string
