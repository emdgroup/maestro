import React, { useState, useRef } from "react";
import { motion, LayoutGroup } from "framer-motion";
import { LayoutDashboard, Bot, GitBranch, Settings, FolderOpen } from "lucide-react";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import type { Project } from "@/types/bindings";
import { useRecentProjects } from "@/services/project.service";
import { invoke } from "@tauri-apps/api/core";
import type { ViewType } from "@/store/navigationStore";

interface AppHeaderProps {
  currentProject: Project;
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
  onProjectChange?: (project: Project) => void;
  onBackToPicker?: () => void;
  agentCount?: number;
  autoMode?: boolean;
  onAutoModeChange?: (enabled: boolean) => void;
}

const VIEWS: Array<{
  id: ViewType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "kanban", label: "Tasks", icon: LayoutDashboard },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "worktrees", label: "Worktrees", icon: GitBranch },
  { id: "settings", label: "Settings", icon: Settings },
];

export function AppHeader({
  currentProject,
  activeView,
  onViewChange,
  onProjectChange,
  onBackToPicker,
  agentCount = 0,
  autoMode: autoModeProp,
  onAutoModeChange,
}: AppHeaderProps) {
  // Load recent projects on-demand (only when header is rendered)
  const { data: recentProjects = [] } = useRecentProjects(currentProject?.connection_id);

  // Internal auto mode state (used when no external state is provided)
  const [internalAutoMode, setInternalAutoMode] = useState(false);
  const autoMode = autoModeProp !== undefined ? autoModeProp : internalAutoMode;

  const handleAutoModeToggle = async () => {
    const next = !autoMode;
    if (onAutoModeChange) {
      onAutoModeChange(next);
    } else {
      setInternalAutoMode(next);
    }
    // Trigger queue drain when enabling auto mode
    if (next && currentProject) {
      try {
        const taskIds = await invoke<number[]>("drain_ready_queue", {
          projectId: currentProject.id,
          projectPath: currentProject.path,
        });
        if (taskIds.length > 0) {
          console.log("[auto-mode] drain_ready_queue returned task IDs to start:", taskIds);
        }
      } catch (err) {
        console.error("[auto-mode] drain_ready_queue failed:", err);
      }
    }
  };

  const [highlightedId, setHighlightedId] = useState<number | string | null>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleItemFocus = (id: number | string) => {
    clearTimeout(blurTimeoutRef.current);
    setHighlightedId(id);
  };

  const handleItemBlur = () => {
    blurTimeoutRef.current = setTimeout(() => setHighlightedId(null), 0);
  };

  // Special value for "back to picker" option
  const BACK_TO_PICKER_VALUE = "__back_to_picker__";

  const handleValueChange = (value: Project | string | null) => {
    if (value === BACK_TO_PICKER_VALUE && onBackToPicker) {
      onBackToPicker();
    } else if (value && typeof value !== "string" && onProjectChange) {
      onProjectChange(value);
    }
  };

  return (
    <header className="grid grid-cols-[1fr_auto_1fr] h-12 shrink-0 items-center border-b px-4 gap-4">
      {/* Left section: Logo + divider + Project Dropdown */}
      <div className="flex items-center gap-3 min-w-0">
        <Select value={currentProject} onValueChange={handleValueChange}>
          <SelectTrigger className="h-7 gap-2 min-w-20 max-w-[20rem] border-none bg-muted text-xs">
            <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
            <SelectValue placeholder="Select project">{currentProject.name}</SelectValue>
          </SelectTrigger>
          <SelectContent className="min-w-sm max-w-lg">
            <LayoutGroup id="project-dropdown">
              {recentProjects
                .filter((p) => p.id !== currentProject.id)
                .map((project) => (
                  <SelectItem
                    key={project.id}
                    value={project}
                    className="cursor-pointer focus:bg-transparent focus:text-foreground not-data-[variant=destructive]:focus:**:text-foreground"
                    onFocus={() => handleItemFocus(project.id)}
                    onBlur={handleItemBlur}
                    before={
                      highlightedId === project.id ? (
                        <motion.div
                          layoutId="project-hover-pill"
                          className="absolute inset-x-1 inset-y-0.5 rounded bg-muted"
                          transition={{ type: "spring", stiffness: 500, damping: 35 }}
                        />
                      ) : null
                    }
                  >
                    <div className="relative z-10 flex items-center gap-2">
                      <div className="flex flex-col gap-0.5 py-1 flex-1 min-w-0">
                        <div className="font-medium text-foreground">{project.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{project.path}</div>
                      </div>
                    </div>
                  </SelectItem>
                ))}
              {onBackToPicker && (
                <>
                  {recentProjects.length > 1 && <SelectSeparator />}
                  <SelectItem
                    value={BACK_TO_PICKER_VALUE}
                    className="cursor-pointer focus:bg-transparent focus:text-foreground not-data-[variant=destructive]:focus:**:text-foreground"
                    onFocus={() => handleItemFocus(BACK_TO_PICKER_VALUE)}
                    onBlur={handleItemBlur}
                    before={
                      highlightedId === BACK_TO_PICKER_VALUE ? (
                        <motion.div
                          layoutId="project-hover-pill"
                          className="absolute inset-x-1 inset-y-0.5 rounded bg-muted"
                          transition={{ type: "spring", stiffness: 500, damping: 35 }}
                        />
                      ) : null
                    }
                  >
                    <div className="relative z-10 flex items-center gap-2 py-1">
                      <FolderOpen className="size-3.5" />
                      <span>Close project</span>
                    </div>
                  </SelectItem>
                </>
              )}
            </LayoutGroup>
          </SelectContent>
        </Select>
      </div>

      {/* Center section: Tab Navigation */}
      <nav className="flex items-center flex-1 justify-center">
        <div className="relative grid grid-cols-4 rounded-lg bg-muted p-1">
          <motion.span
            className="absolute inset-y-1 left-1 rounded-md bg-background shadow-sm"
            style={{ width: "calc((100% - 0.5rem) / 4)" }}
            animate={{ x: `calc(${VIEWS.findIndex((v) => v.id === activeView)} * 100%)` }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
          />
          {VIEWS.map((view) => {
            const Icon = view.icon;
            const isActive = activeView === view.id;
            return (
              <button
                key={view.id}
                onClick={() => onViewChange(view.id)}
                className={`relative z-10 flex w-full items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium outline-none ${isActive ? "" : "cursor-pointer hover:bg-background/50"}`}
              >
                <motion.span
                  animate={{ color: isActive ? "var(--foreground)" : "var(--muted-foreground)" }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-1.5"
                >
                  <Icon className="size-3.5" />
                  {view.label}
                </motion.span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Right section: Auto/Manual toggle + Status indicator + Theme switcher */}
      <div className="flex items-center justify-end gap-2">
        {/* Auto/Manual mode toggle */}
        <button
          onClick={handleAutoModeToggle}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
            autoMode
              ? "bg-green-500/15 text-green-600 dark:text-green-400 hover:bg-green-500/25"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
          title={
            autoMode
              ? "Auto mode: tasks in Ready are executed automatically. Click to switch to Manual."
              : "Manual mode: tasks must be started manually. Click to enable Auto mode."
          }
        >
          <span
            className={`h-1.5 w-1.5 rounded-full shrink-0 ${
              autoMode ? "bg-green-500 animate-pulse" : "bg-muted-foreground/50"
            }`}
          />
          {autoMode ? "Auto" : "Manual"}
        </button>

        {/* Running agent count */}
        <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1">
          <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
          <span className="text-xs text-muted-foreground">{agentCount} running</span>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
