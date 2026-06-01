export type ShortcutScope = "global" | "board" | "taskDetail" | "agents" | "worktrees";

export interface ShortcutDef {
  id: string;
  /** Lowercase key name (e.g. "n", "escape") or "Escape" for the escape key */
  key: string;
  ctrl: boolean;
  /** Display label shown in the hint tooltip (e.g. "Ctrl+N", "Esc") */
  label: string;
  scope: ShortcutScope | ShortcutScope[];
}
