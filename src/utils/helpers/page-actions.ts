import { Plus, Save, RotateCcw } from "lucide-react";
import type { ActionBarAction } from "@/components/common";

export type ViewType = "kanban" | "agents" | "worktrees" | "settings";

/**
 * Get page-specific action bar actions based on the active view
 */
export function getPageActions(
  activePage: ViewType,
  callbacks: {
    onAddTask: () => void;
    onResetSettings: () => void;
    onSaveSettings: () => Promise<void>;
  },
): ActionBarAction[] {
  switch (activePage) {
    case "kanban":
      return [
        {
          id: "add-task",
          label: "Add Task",
          icon: Plus,
          variant: "accent",
          onClick: callbacks.onAddTask,
          align: "right",
        },
      ];
    case "agents":
      return [];
    case "worktrees":
      return [];
    case "settings":
      return [
        {
          id: "reset",
          label: "Reset to Defaults",
          icon: RotateCcw,
          variant: "ghost",
          onClick: callbacks.onResetSettings,
        },
        {
          id: "save",
          label: "Save",
          icon: Save,
          variant: "accent",
          onClick: callbacks.onSaveSettings,
          align: "right",
        },
      ];
    default:
      return [];
  }
}
