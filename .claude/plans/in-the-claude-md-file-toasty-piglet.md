# Plan: Improve CLAUDE.md "Use Graph First" instruction adherence

## Context

The "Code Search: Use the Knowledge Graph FIRST" section in CLAUDE.md is being ignored by Claude Code sessions. The instruction needs restructuring to actually influence tool selection behavior.

## Root Causes

1. **Position**: Section is at line 53, after boilerplate. Tool-selection rules need to be in the first ~30 lines to reliably override default behavior.
2. **Trigger mismatch**: Claude doesn't always frame its actions as "searching" — it might be "reading a file to understand X" or "finding where Y is defined." The rule needs to cover all exploration intents, not just search.
3. **No decision tree**: A table of tools is informational but doesn't create a decision checkpoint. Claude needs an explicit "STOP → check graph first" gate.
4. **Competing with system prompt**: The system prompt says "Prefer dedicated tools over Bash" and mentions Grep/Glob directly. CLAUDE.md needs stronger framing to override that default ranking.

## Proposed Changes

### Move and rewrite the section — place it immediately after the 4 principles (line 10)

New version:

```markdown
## Tool Selection Priority (MANDATORY)

Before exploring code with Grep, Glob, Read, or LSP — STOP. Use code-review-graph MCP tools first. This applies to ALL code understanding tasks: finding definitions, tracing callers, understanding impact, reviewing changes.

**Decision gate:**
1. Can the graph answer this? → Use `semantic_search_nodes`, `query_graph`, `get_impact_radius`, `detect_changes`
2. Graph insufficient (string literals, full file reads, config values)? → Fall back to Grep/Glob/Read
3. Need precise type info or jump-to-definition? → Use LSP tool
4. Need pattern matching across files? → Use `ast-grep` (see `.claude/ast-grep.md`)

**Why this matters:** The graph resolves structural queries in 1 call that take 5+ text searches. Using Grep first wastes tokens and misses transitive dependencies.
```

### Key differences from current version:

- **Position**: Right after principles, before any other section
- **Trigger words**: "exploring code" not just "search" — catches Read-first behavior
- **Decision tree**: Numbered steps create a mental checkpoint
- **Includes LSP**: Covers the user's mention of LSP/goToDefinition
- **Consequence stated**: "wastes tokens and misses transitive dependencies"
- **Shorter**: No table (tables get skimmed), just a numbered list

### File to modify

- `/home/m306213/workspace/maestro/CLAUDE.md` — move section from line 53 to line 10, rewrite as above

## Verification

- Start a new Claude Code session on this project
- Ask it to find callers of a function
- Observe whether it reaches for `query_graph` before Grep
- Ask it to understand a file — observe whether `semantic_search_nodes` comes before Read
