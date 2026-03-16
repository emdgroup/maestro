import React from "react";
import { motion } from "framer-motion";
import { LayoutDashboard, Bot, GitBranch, Settings, FolderOpen } from "lucide-react";
import { cn } from "@/lib";
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

type ViewType = "kanban" | "agents" | "worktrees" | "settings";

interface AppHeaderProps {
  currentProject: Project;
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
  onProjectChange?: (project: Project) => void;
  onBackToPicker?: () => void;
  agentCount?: number;
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
}: AppHeaderProps) {
  // Load recent projects on-demand (only when header is rendered)
  const { data: recentProjects = [] } = useRecentProjects(currentProject?.connection_id);

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
    <header className="flex h-12 shrink-0 items-center justify-between border-b px-4 gap-4">
      {/* Left section: Logo + divider + Project Dropdown */}
      <div className="flex items-center gap-3 shrink-0">
        <Select value={currentProject} onValueChange={handleValueChange}>
          <SelectTrigger className="h-7 gap-2 min-w-20 max-w-[20rem] border-none bg-muted text-xs">
            <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
            <SelectValue placeholder="Select project">{currentProject.name}</SelectValue>
          </SelectTrigger>
          <SelectContent className="min-w-[16rem] max-w-[24rem]">
            {recentProjects.slice(0, 5).map((project) => (
              <SelectItem
                key={project.id}
                value={project}
                className="cursor-pointer focus:bg-transparent hover:bg-transparent focus:outline-2 focus:outline-accent focus:text-foreground hover:ring-2 hover:ring-accent [&>span]:text-accent"
              >
                <div className="flex items-center gap-2 w-full">
                  <div className="flex flex-col gap-0.5 py-1 flex-1 min-w-0">
                    <div className="font-medium text-foreground">{project.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{project.path}</div>
                  </div>
                </div>
              </SelectItem>
            ))}
            {onBackToPicker && (
              <>
                <SelectSeparator />
                <SelectItem value={BACK_TO_PICKER_VALUE} className="cursor-pointer">
                  <div className="flex items-center gap-2 py-1">
                    <FolderOpen className="size-3.5" />
                    <span>Project Picker</span>
                  </div>
                </SelectItem>
              </>
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Center section: Tab Navigation */}
      <nav className="flex items-center gap-1 flex-1 justify-center">
        {VIEWS.map((view) => {
          const Icon = view.icon;
          const isActive = activeView === view.id;
          return (
            <button
              key={view.id}
              onClick={() => onViewChange(view.id)}
              className={cn(
                "relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus:border focus:border-solid focus:border-accent",
                isActive
                  ? "text-accent bg-muted"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              )}
            >
              <Icon className="size-3.5" />
              <span>{view.label}</span>
              {isActive && (
                <motion.div
                  layoutId="activeTabIndicator"
                  className="absolute inset-0 bg-muted rounded-md -z-10"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Right section: Status indicator + Theme switcher */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1">
          <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
          <span className="text-xs text-muted-foreground">{agentCount} running</span>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
