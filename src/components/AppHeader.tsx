import { useMemo } from "react";
import {
  LayoutDashboard,
  Bot,
  GitBranch,
  Settings,
  FolderOpen,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Project } from "@/types/bindings";

type ViewType = "kanban" | "agents" | "worktrees" | "settings";

interface AppHeaderProps {
  currentProject: Project | null;
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
  projects?: Project[];
  onProjectChange?: (path: string) => void;
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
  projects = [],
  onProjectChange,
  agentCount = 0,
}: AppHeaderProps) {
  // Format project list for display
  const projectOptions = useMemo(
    () => projects.map((p) => ({ value: p.path, label: p.name })),
    [projects]
  );

  const currentProjectPath = currentProject?.path || "";

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b px-4 gap-4">
      {/* Left section: Logo + divider + Project Dropdown */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="text-sm font-semibold tracking-tight text-foreground">
          GSD Agent Orchestrator
        </span>
        <div className="h-4 w-px bg-border" />
        <Select value={currentProjectPath} onValueChange={onProjectChange}>
          <SelectTrigger className="h-7 w-[160px] border-none bg-muted text-xs">
            <FolderOpen className="mr-1.5 h-3 w-3 text-muted-foreground" />
            <SelectValue placeholder="Select project" />
          </SelectTrigger>
          <SelectContent>
            {projectOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Center section: Tab Navigation */}
      <nav className="flex items-center gap-1 flex-1">
        {VIEWS.map((view) => {
          const Icon = view.icon;
          const isActive = activeView === view.id;
          return (
            <button
              key={view.id}
              onClick={() => onViewChange(view.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{view.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Right section: Status indicator + New Agent button */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1">
          <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
          <span className="text-xs text-muted-foreground">
            {agentCount} running
          </span>
        </div>
        <Button
          size="sm"
          className="h-7 gap-1.5 text-xs bg-accent hover:bg-accent/90 text-accent-foreground"
        >
          <Plus className="h-3 w-3" />
          New Agent
        </Button>
      </div>
    </header>
  );
}
