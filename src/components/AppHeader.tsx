import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  LayoutDashboard,
  Bot,
  GitBranch,
  Settings,
  FolderOpen
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Project } from "@/types/bindings";

type ViewType = "kanban" | "agents" | "worktrees" | "settings";

interface EnhancedRecentProject {
  path: string;
  name: string;
  is_remote: boolean;
  host: string | null;
  username: string | null;
  last_opened: string;
}

interface AppHeaderProps {
  currentProject: Project | null;
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
  projects?: Project[];
  recentProjects?: EnhancedRecentProject[];
  onProjectChange?: (path: string) => void;
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
  projects = [],
  recentProjects = [],
  onProjectChange,
  onBackToPicker,
  agentCount = 0,
}: AppHeaderProps) {
  // Get connection identifier for filtering
  const getConnectionId = (project: Project): string => {
    if (!project.is_remote || !project.ssh_config) {
      return "local";
    }
    return `${project.ssh_config.username}@${project.ssh_config.host}`;
  };

  // Filter projects to show only recent ones from the same connection (max 5)
  const filteredProjects = useMemo(() => {
    if (!currentProject) {
      console.log('[DEBUG] AppHeader: No current project, showing all', projects.length, 'projects');
      return projects;
    }

    const currentConnection = getConnectionId(currentProject);
    console.log('[DEBUG] AppHeader: Current project:', currentProject.name, 'Connection:', currentConnection);
    console.log('[DEBUG] AppHeader: All projects:', projects.length, projects.map(p => ({name: p.name, path: p.path, conn: getConnectionId(p)})));
    console.log('[DEBUG] AppHeader: Recent projects list:', recentProjects.length, recentProjects.map(rp => rp.path));

    // Step 1: Filter by connection
    const sameConnection = projects.filter((p) => getConnectionId(p) === currentConnection);
    console.log('[DEBUG] AppHeader: After connection filter:', sameConnection.length, sameConnection.map(p => p.name));

    // Step 2: Filter to only recent projects
    const recentPaths = new Set(recentProjects.map(rp => rp.path));
    const recentAndSameConnection = sameConnection.filter(p => recentPaths.has(p.path));
    console.log('[DEBUG] AppHeader: After recent filter:', recentAndSameConnection.length, recentAndSameConnection.map(p => p.name));

    // Step 3: Sort by recency (order in recentProjects list)
    const pathToIndex = new Map(recentProjects.map((rp, idx) => [rp.path, idx]));
    recentAndSameConnection.sort((a, b) => {
      const aIdx = pathToIndex.get(a.path) ?? Infinity;
      const bIdx = pathToIndex.get(b.path) ?? Infinity;
      return aIdx - bIdx;
    });

    // Step 4: Take top 5 most recent
    const top5 = recentAndSameConnection.slice(0, 5);
    console.log('[DEBUG] AppHeader: Final top 5:', top5.map(p => p.name));

    return top5;
  }, [projects, recentProjects, currentProject]);

  const currentProjectPath = currentProject?.path || "";
  const currentProjectName = currentProject?.name || "";

  // Special value for "back to picker" option
  const BACK_TO_PICKER_VALUE = "__back_to_picker__";

  const handleValueChange = (value: string) => {
    if (value === BACK_TO_PICKER_VALUE && onBackToPicker) {
      onBackToPicker();
    } else if (onProjectChange) {
      onProjectChange(value);
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b px-4 gap-4">
      {/* Left section: Logo + divider + Project Dropdown */}
      <div className="flex items-center gap-3 shrink-0">
        <Select value={currentProjectPath} onValueChange={handleValueChange}>
          <SelectTrigger className="h-7 gap-2 min-w-20 max-w-[20rem] border-none bg-muted text-xs">
            <FolderOpen className="h-3 w-3 text-muted-foreground shrink-0" />
            <SelectValue placeholder="Select project">
              {currentProjectName}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="min-w-[16rem] max-w-[24rem]">
            {filteredProjects.map((project) => (
                <SelectItem
                  key={project.path}
                  value={project.path}
                  className="cursor-pointer focus:bg-transparent hover:bg-transparent focus:outline-2 focus:outline-accent focus:text-foreground hover:ring-2 hover:ring-accent [&>span]:text-accent"
                >
                  <div className="flex items-center gap-2 w-full">
                    <div className="flex flex-col gap-0.5 py-1 flex-1 min-w-0">
                      <div className="font-medium text-foreground">
                        {project.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {project.path}
                      </div>
                    </div>
                  </div>
                </SelectItem>
              ))}
            {onBackToPicker && (
              <>
                <SelectSeparator />
                <SelectItem value={BACK_TO_PICKER_VALUE} className="cursor-pointer">
                  <div className="flex items-center gap-2 py-1">
                    <FolderOpen className="h-3.5 w-3.5" />
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
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
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
          <span className="text-xs text-muted-foreground">
            {agentCount} running
          </span>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
