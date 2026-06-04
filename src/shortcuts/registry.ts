import type { ShortcutDef, ShortcutScope } from "./types";
import type { ViewType } from "@/store/navigationStore";

export const SHORTCUTS: ShortcutDef[] = [
  // Global — tab switching
  { id: "tab-board",     key: "1",      ctrl: true,  label: "Ctrl+1", scope: "global" },
  { id: "tab-agents",    key: "2",      ctrl: true,  label: "Ctrl+2", scope: "global" },
  { id: "tab-worktrees", key: "3",      ctrl: true,  label: "Ctrl+3", scope: "global" },
  { id: "tab-settings",  key: "4",      ctrl: true,  label: "Ctrl+4", scope: "global" },

  // Global — block webview reload
  { id: "prevent-reload",       key: "r",  ctrl: true,  label: "Ctrl+R",       scope: "global" },
  { id: "prevent-reload-shift", key: "r",  ctrl: true,  shift: true, label: "Ctrl+Shift+R", scope: "global" },
  { id: "prevent-reload-f5",    key: "F5", ctrl: false, label: "F5",           scope: "global" },

  // Search focus — relevant on screens that have a search input
  { id: "focus-search",  key: "f",      ctrl: true,  label: "Ctrl+F", scope: ["board", "agents", "worktrees"] },

  // Board
  { id: "board-new",     key: "n",      ctrl: true,  label: "Ctrl+N", scope: "board" },

  // Task Detail
  { id: "task-back",     key: "Escape", ctrl: false, label: "Esc",    scope: "taskDetail" },
  { id: "task-delete",   key: "d",      ctrl: true,  label: "Ctrl+D", scope: "taskDetail" },
  { id: "task-save",     key: "s",      ctrl: true,  label: "Ctrl+S", scope: "taskDetail" },

  // Agents
  { id: "agents-new",          key: "n",      ctrl: true,  label: "Ctrl+N", scope: "agents" },
  { id: "agents-close",        key: "w",      ctrl: true,  label: "Ctrl+W", scope: "agents" },
  { id: "agents-history",      key: "h",      ctrl: true,  label: "Ctrl+H", scope: "agents" },
  { id: "agents-working",      key: "e",      ctrl: true,  label: "Ctrl+E", scope: "agents" },
  { id: "agents-review",       key: "r",      ctrl: true,  label: "Ctrl+R", scope: "agents" },
  { id: "agents-close-panel",  key: "Escape", ctrl: false, label: "Esc",    scope: "agents" },

  // Worktrees
  { id: "wt-new",       key: "n",      ctrl: true,  label: "Ctrl+N", scope: "worktrees" },
  { id: "wt-refresh",   key: "r",      ctrl: true,  label: "Ctrl+R", scope: "worktrees" },
  { id: "wt-close-diff",key: "Escape", ctrl: false, label: "Esc",    scope: "worktrees" },
];

export function getShortcutsForScope(scope: ShortcutScope): ShortcutDef[] {
  return SHORTCUTS.filter((s) => {
    const scopes = Array.isArray(s.scope) ? s.scope : [s.scope];
    return scopes.includes(scope);
  });
}

export function getShortcutById(id: string): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

export function isScopeActive(
  scope: ShortcutScope,
  activeTab: ViewType,
  activeTaskId: number | null,
): boolean {
  switch (scope) {
    case "global":
      return true;
    case "board":
      return activeTab === "kanban" && activeTaskId === null;
    case "taskDetail":
      return activeTab === "kanban" && activeTaskId !== null;
    case "agents":
      return activeTab === "agents";
    case "worktrees":
      return activeTab === "worktrees";
  }
}
