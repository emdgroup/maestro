import { useState } from "react";
import { Input } from "./ui/input";
import { EnhancedRecentProject, SshConnection } from "../types/bindings";
import { Server, Pencil } from "lucide-react";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { ProjectListItem } from "./ProjectListItem";
import { ProjectsListLayout } from "./ProjectsListLayout";

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
    (p) => p.connection_id === connection.id
  );

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
      void handleSaveEdit();
    } else if (e.key === "Escape") {
      handleCancelEdit();
    }
  };

  return (
    <ProjectsListLayout
      headerContent={
        <>
          <Server className="w-5 h-5 text-muted-foreground" />
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
                <Pencil className="size-3.5" />
              </button>
            </>
          )}
        </>
      }
      isEmpty={connectionProjects.length === 0}
      emptyMessage="No recent projects for this connection"
      onBack={onBack}
      onSelectNewClick={onSelectNewClick}
      loading={loading}
    >
      {connectionProjects.map((project) => (
        <ProjectListItem
          key={project.path}
          path={project.path}
          onClick={() => onProjectClick(project.path)}
          onRemove={onRemoveProject ? () => onRemoveProject(project.path) : undefined}
          disabled={loading}
        />
      ))}
    </ProjectsListLayout>
  );
}
