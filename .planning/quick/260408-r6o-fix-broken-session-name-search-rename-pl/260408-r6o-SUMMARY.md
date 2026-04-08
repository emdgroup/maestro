---
quick_id: 260408-r6o
status: complete
commit: fb2a172
date: 2026-04-08
---

# Summary: Fix broken session name search + rename placeholder

## Changes

- `src/components/execution/AgentMonitor.tsx`: filter now uses
  `task_name ?? branch_name ?? "Interactive"` so interactive sessions
  are searchable by their branch name.
- `src/views/AgentsView.tsx`: placeholder renamed from "Search agents..."
  to "Search sessions..."

## Verified

Two-line fix. Root cause was a mismatch between display logic and filter
logic — display already used `branch_name` as fallback, filter didn't.
