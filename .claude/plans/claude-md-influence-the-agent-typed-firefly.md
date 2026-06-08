# Plan: Fix CLAUDE.md worktree path resolution

## Context

When agents work in git worktrees, the instruction "save to the project's `.claude/plans/` folder" causes them to write files to the **main repo root** (e.g., `/home/m306213/workspace/maestro/.claude/plans/`) instead of the **worktree's own `.claude/plans/`**. This results in files being created outside the isolated worktree.

## Fix

Edit `/home/m306213/.claude/CLAUDE.md` — reword the File Conventions section to be explicitly CWD-relative:

```markdown
## File Conventions

When generating HTML preview files, save them to `.claude/plans/` relative to the current working directory. No write permission needed for files in `.claude/plans/` — create them directly, even in plan mode.
```

Key change: Remove "the project's" phrasing and add "relative to the current working directory" to eliminate ambiguity when CWD is a worktree.

## Verification

- Start a worktree session
- Ask agent to create an HTML preview
- Confirm file lands in `<worktree-root>/.claude/plans/`, not main repo
