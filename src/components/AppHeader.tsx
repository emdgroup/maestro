import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Project } from "@/types/bindings";

interface AppHeaderProps {
  currentProject: Project | null;
  activePage: string;
  onPageChange: (page: string) => void;
  agentsRunning?: number;
  worktreesCount?: number;
}

export function AppHeader({
  currentProject,
  activePage,
  onPageChange,
  agentsRunning = 0,
  worktreesCount = 0,
}: AppHeaderProps) {
  return (
    <header className="border-b bg-card shadow-sm">
      <div className="flex items-center justify-between gap-4 p-3">
        {/* Left section: Project name + global status indicators */}
        <div className="flex items-center gap-4 min-w-0">
          <h1 className="text-lg font-semibold text-foreground truncate">
            {currentProject?.name || "No Project"}
          </h1>
          <div className="flex gap-3 text-xs text-muted-foreground whitespace-nowrap">
            <span className="flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning"></span>
              {agentsRunning} agents
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted"></span>
              {worktreesCount} worktrees
            </span>
          </div>
        </div>

        {/* Center/Right section: Page navigation tabs */}
        <Tabs value={activePage} onValueChange={onPageChange} className="flex-1">
          <TabsList className="bg-muted inline-flex">
            <TabsTrigger value="kanban" className="text-sm">
              Kanban
            </TabsTrigger>
            <TabsTrigger value="agents" className="text-sm">
              Agent Monitor
            </TabsTrigger>
            <TabsTrigger value="worktrees" className="text-sm">
              Worktree Manager
            </TabsTrigger>
            <TabsTrigger value="settings" className="text-sm">
              Settings
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
    </header>
  );
}
