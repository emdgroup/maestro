import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { EnhancedRecentProject, SshConnection } from "../types/bindings";
import { ArrowLeft, Folder, Globe, X, Pencil } from "lucide-react";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";

interface RemoteProjectsListProps {
  connection: SshConnection;
  recentProjects: EnhancedRecentProject[];
  onProjectClick: (path: string) => void;
  onSelectNewClick: () => void;
  onBack: () => void;
  onRemoveProject?: (path: string) => void;
  onConnectionRenamed?: () => void;
  loading?: boolean;
}

export function RemoteProjectsList({
  connection,
  recentProjects,
  onProjectClick,
  onSelectNewClick,
  onBack,
  onRemoveProject,
  onConnectionRenamed,
  loading = false,
}: RemoteProjectsListProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");

  // Filter to only show projects for this connection
  const connectionProjects = recentProjects.filter(
    (p) => p.is_remote && p.host === connection.host && p.username === connection.username
  );

  // Extract folder name from path for display
  const getFolderName = (path: string) => {
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
  };

  const handleStartEdit = () => {
    setIsEditing(true);
    setEditName(connection.display_name || connection.connection_string);
  };

  const handleSaveEdit = async () => {
    if (!editName.trim()) {
      toast.error("Name cannot be empty");
      return;
    }

    try {
      await safeInvoke("rename_ssh_connection", {
        connectionId: connection.id,
        displayName: editName.trim(),
      });
      setIsEditing(false);
      if (onConnectionRenamed) {
        onConnectionRenamed();
      }
      toast.success("Connection renamed");
    } catch (error) {
      toast.error(`Failed to rename: ${error}`);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditName("");
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveEdit();
    } else if (e.key === "Escape") {
      handleCancelEdit();
    }
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
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <Globe className="w-5 h-5 text-muted-foreground" />
        {isEditing ? (
          <div className="flex-1 flex items-center gap-2">
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={handleEditKeyDown}
              onBlur={handleSaveEdit}
              className="flex-1 font-mono text-sm h-8"
              autoFocus
            />
          </div>
        ) : (
          <>
            <h2 className="text-lg font-semibold truncate flex-1">
              {connection.display_name || connection.connection_string}
            </h2>
            <button
              onClick={handleStartEdit}
              className="p-1.5 rounded-md hover:bg-accent transition-colors"
              title="Edit connection name"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      <div className="flex-1 overflow-auto mb-4">
        {connectionProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No recent projects for this connection
          </p>
        ) : (
          <ul className="space-y-2">
            {connectionProjects.map((project) => (
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
          <Folder className="w-4 h-4 mr-2" />
          {loading ? "Loading..." : "Select Project"}
        </Button>
      </div>
    </div>
  );
}
