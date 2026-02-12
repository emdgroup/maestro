import { Button } from "./ui/button";
import { EnhancedRecentProject, SshConnection } from "../types/bindings";
import { ArrowLeft, Folder, Globe } from "lucide-react";

interface RemoteProjectsListProps {
  connection: SshConnection;
  recentProjects: EnhancedRecentProject[];
  onProjectClick: (path: string) => void;
  onSelectNewClick: () => void;
  onBack: () => void;
  loading?: boolean;
}

export function RemoteProjectsList({
  connection,
  recentProjects,
  onProjectClick,
  onSelectNewClick,
  onBack,
  loading = false,
}: RemoteProjectsListProps) {
  // Filter to only show projects for this connection
  const connectionProjects = recentProjects.filter(
    (p) => p.is_remote && p.host === connection.host && p.username === connection.username
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="p-1 h-auto -ml-1"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <Globe className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold truncate">{connection.connection_string}</h2>
      </div>

      <div className="flex-1 overflow-auto mb-4">
        {connectionProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No recent projects for this connection
          </p>
        ) : (
          <ul className="space-y-2">
            {connectionProjects.map((project) => (
              <li key={project.path}>
                <Button
                  onClick={() => onProjectClick(project.path)}
                  disabled={loading}
                  variant="outline"
                  className="w-full text-left justify-start font-mono text-sm h-auto py-3 px-4"
                >
                  <div className="flex flex-col items-start gap-1 w-full">
                    <span className="font-semibold">{project.name}</span>
                    <span className="text-xs text-muted-foreground truncate w-full">
                      {project.path}
                    </span>
                  </div>
                </Button>
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
          <Folder className="w-4 h-4 mr-2" />
          {loading ? "Loading..." : "Select Project"}
        </Button>
      </div>
    </div>
  );
}
