import { Button } from "./ui/button";
import { EnhancedRecentProject } from "../types/bindings";
import { Folder, X, ChevronLeft } from "lucide-react";

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

  // Extract folder name from path for display
  const getFolderName = (path: string) => {
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
  };

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
              <li key={project.path} className="relative group">
                <Button
                  onClick={() => onProjectClick(project.path)}
                  disabled={loading}
                  variant="outline"
                  className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4 pr-12"
                >
                  <div className="flex flex-col items-start gap-1 w-full">
                    <span className="font-semibold">{getFolderName(project.path)}</span>
                    <span className="text-xs text-muted-foreground truncate w-full">
                      {project.path}
                    </span>
                  </div>
                </Button>
                {onRemoveProject && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveProject(project.path);
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md hover:bg-destructive/10 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Remove from recent projects"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
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
