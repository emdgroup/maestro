import { Button } from "./ui/button";
import { EnhancedRecentProject } from "../types/bindings";
import { Folder, ChevronLeft } from "lucide-react";
import { ProjectListItem } from "./ProjectListItem";

interface LocalProjectsListProps {
  recentProjects: EnhancedRecentProject[];
  onProjectClick: (path: string) => void;
  onSelectNewClick: () => void;
  onBack: () => void;
  onRemoveProject?: (path: string) => void;
  loading?: boolean;
}

export function LocalProjectsList({
  recentProjects,
  onProjectClick,
  onSelectNewClick,
  onBack,
  onRemoveProject,
  loading = false,
}: LocalProjectsListProps) {
  // Filter to only show local projects
  const localProjects = recentProjects.filter((p) => !p.is_remote);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="p-1 h-auto -ml-1"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <Folder className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Local</h2>
      </div>

      <div className="flex-1 overflow-auto mb-4">
        {localProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No recent local projects
          </p>
        ) : (
          <ul className="space-y-2">
            {localProjects.map((project) => (
              <ProjectListItem
                key={project.path}
                path={project.path}
                onClick={() => onProjectClick(project.path)}
                onRemove={onRemoveProject ? () => onRemoveProject(project.path) : undefined}
                disabled={loading}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="pt-4 border-t border-border">
        <Button
          onClick={onSelectNewClick}
          disabled={loading}
          variant="default"
          size="lg"
          className="w-full"
        >
          <Folder className="w-4 h-4" />
          {loading ? "Loading..." : "Select New Project"}
        </Button>
      </div>
    </div>
  );
}
