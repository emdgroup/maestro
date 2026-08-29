/// Shared pill and popover-item classes for the metadata controls on a task.
///
/// This file used to also hold a `TogglePill` component, whose only user was the task's worktree
/// on/off toggle. That question now has three answers rather than two and is asked by the
/// workspace selector, so only the styles the pickers share are left.
export const PILL =
  "flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-xs transition-colors";

export const POPOVER_ITEM =
  "flex items-center gap-2 w-full px-2 py-1 text-xs rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
