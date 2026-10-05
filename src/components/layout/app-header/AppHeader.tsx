import React from "react";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { motion, LayoutGroup } from "framer-motion";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import { LayoutDashboard, Bot, FolderGit2, Library, Settings } from "lucide-react";
import { ThemeToggle } from "@/components/common/theme-toggle/ThemeToggle";
import { AccentColorPicker } from "@/components/common/accent-color-picker/AccentColorPicker";
import { AccentBubbles } from "@/components/common/accent-bubbles/AccentBubbles";
import type { Project } from "@/types/bindings";
import type { ViewType } from "@/store/navigationStore";
import { WindowControls } from "@/components/layout/window-chrome/WindowControls";
import { ProjectPath } from "./ProjectPath";

interface AppHeaderProps {
  currentProject: Project;
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
  /** Settings is a dialog now, so it sits beside the theme controls rather than in the tab row. */
  onOpenSettings: () => void;
  /**
   * The connection stopped answering but is still open — reported here rather than as a
   * blocking overlay, because nothing has necessarily failed.
   */
  connectionQuiet?: boolean;
}

const VIEWS: Array<{
  id: ViewType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "kanban", label: "Tasks", icon: LayoutDashboard },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "collections", label: "Collections", icon: Library },
  // The id stays `worktrees` — it is the persisted startup-tab value and the shortcut scope. Only
  // the label changes, because "worktree" is git vocabulary and this tab is for everyone.
  { id: "worktrees", label: "Workspaces", icon: FolderGit2 },
];

export function AppHeader({
  currentProject,
  activeView,
  onViewChange,
  onOpenSettings,
  connectionQuiet = false,
}: AppHeaderProps) {
  return (
    // The header doubles as the window's drag region — Tauri only starts a drag when the event
    // target itself carries the attribute, so the controls nested below still receive their
    // clicks. The three section wrappers repeat it or their empty space would be dead.
    <header
      data-tauri-drag-region
      className="relative isolate grid grid-cols-[1fr_auto_1fr] h-[52px] shrink-0 items-center px-4 pb-1 gap-4"
    >
      {/* Project-colour dressing: bubbles behind the accent gradient, both absolutely
          positioned and -z-10, so the grid layout and the content above are untouched. */}
      <AccentBubbles variant="header" className="-z-10" />
      <span aria-hidden className="header-gradient -z-10" />
      {/* Left section: Home / connection / project */}
      <ProjectPath project={currentProject} />

      {/* Center section: Tab Navigation */}
      <nav data-tauri-drag-region className="flex items-center flex-1 justify-center">
        <LayoutGroup id="tab-nav">
          <div className="grid grid-cols-4 rounded-lg bg-muted/60 p-1 gap-1">
            {VIEWS.map((view) => {
              const Icon = view.icon;
              const isActive = activeView === view.id;
              return (
                <ShortcutHint
                  key={view.id}
                  shortcutId={
                    {
                      kanban: "tab-board",
                      agents: "tab-agents",
                      worktrees: "tab-worktrees",
                      collections: "tab-collections",
                    }[view.id]
                  }
                  placement="below"
                >
                  <Button
                    variant="ghost"
                    onClick={() => onViewChange(view.id)}
                    className={cn(
                      "relative flex w-full items-center justify-center rounded-md px-3 py-1.5 h-auto text-xs font-medium",
                      isActive ? "hover:bg-transparent" : "hover:bg-background/50",
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="active-tab-pill"
                        className="absolute inset-0 rounded-md bg-background shadow-sm"
                        transition={{ type: "spring", stiffness: 400, damping: 35 }}
                      />
                    )}
                    <motion.span
                      animate={{ color: isActive ? "var(--accent)" : "var(--muted-foreground)" }}
                      transition={{ duration: 0.15 }}
                      className="relative z-10 flex items-center gap-1.5"
                    >
                      <Icon className="size-3.5" />
                      {view.label}
                    </motion.span>
                  </Button>
                </ShortcutHint>
              );
            })}
          </div>
        </LayoutGroup>
      </nav>

      {/* Right section: Status indicator + Theme switcher */}
      <div data-tauri-drag-region className="flex items-center justify-end gap-2">
        {connectionQuiet && (
          <Tooltip>
            <TooltipTrigger
              render={
                <div className="flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-600 dark:text-amber-400" />
              }
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
              Not responding
            </TooltipTrigger>
            <TooltipContent>
              No reply from this connection for a while. Sessions are still open, and an agent that
              is busy can look like this.
            </TooltipContent>
          </Tooltip>
        )}

        <AccentColorPicker />
        <ThemeToggle />
        {/* Same trigger treatment as the picker screen's cog, so the icon row is one set of
            controls rather than a button variant dropped next to two icon buttons. */}
        <ShortcutHint shortcutId="open-settings" placement="below">
          <button
            type="button"
            // Wrapped rather than passed straight through: the store's action takes an optional
            // page id, which would otherwise be handed the click event.
            onClick={() => onOpenSettings()}
            className="flex items-center justify-center h-7 w-7 rounded-full hover:bg-muted/80 transition-colors [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-muted-foreground cursor-pointer"
            aria-label="Settings"
          >
            <Settings />
          </button>
        </ShortcutHint>
        <WindowControls className="-mr-2 ml-1" />
      </div>
    </header>
  );
}
