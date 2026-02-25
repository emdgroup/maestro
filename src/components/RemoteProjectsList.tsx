import React, { useState } from "react";
import { Input } from "./ui/input";
import { SshConnection } from "../types/bindings";
import { Server, Pencil, MoreVertical, Trash2, KeyRound } from "lucide-react";
import { safeInvoke } from "../lib/tauri-safe";
import { toast } from "sonner";
import { ProjectListItem } from "./ProjectListItem";
import { ProjectsListLayout } from "./ProjectsListLayout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "@/components/ui/button.tsx";
import { useRecentProjects } from "@/hooks/useRecentProjects.ts";

interface RemoteProjectsListProps {
  connection: SshConnection;
  onProjectClick: (projectId: number) => void;
  onRemoveProject: (projectId: number) => void;
  onSelectNewClick: () => void;
  onBack: () => void;
  onConnectionRenamed?: () => void;
}

export function RemoteProjectsList({
  connection,
  onProjectClick,
  onSelectNewClick,
  onBack,
  onRemoveProject,
  onConnectionRenamed,
}: RemoteProjectsListProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const { recentProjects, loading } = useRecentProjects(connection.id);

  const handleStartEdit = () => {
    setIsEditing(true);
    setEditName(connection.display_name || connection.connection_string);
  };

  const handleSaveEdit = async () => {
    if (
      !editName.trim() ||
      editName.trim() === (connection.display_name ?? connection.connection_string)
    ) {
      setIsEditing(false);
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

  const handleDeleteConnection = async () => {
    try {
      await safeInvoke("delete_ssh_connection", {
        connectionId: connection.id,
      });
      setShowDeleteDialog(false);
      toast.success("Connection deleted");
      // Go back to connections list since current connection is deleted
      onBack();
    } catch (error) {
      toast.error(`Failed to delete connection: ${error}`);
    }
  };

  const handleForgetPassword = async () => {
    try {
      await safeInvoke("forget_saved_password", {
        connectionId: connection.id,
      });
      toast.success("Password forgotten");
      if (onConnectionRenamed) {
        onConnectionRenamed(); // Refresh connection details
      }
    } catch (error) {
      toast.error(`Failed to forget password: ${error}`);
    }
  };

  // Check if connection has a saved password
  const hasSavedPassword =
    typeof connection.auth_method === "object" &&
    "Password" in connection.auth_method &&
    connection.auth_method.Password.save_password;

  return (
    <>
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleStartEdit}
                  tabIndex={-1}
                  className="p-1 h-auto -ml-1 hover:text-accent"
                  aria-label="Edit connection name"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="p-1.5 rounded-md hover:text-accent transition-colors cursor-pointer"
                    title="Connection actions"
                  >
                    <MoreVertical className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-auto" align="end">
                    {hasSavedPassword && (
                      <>
                        <DropdownMenuItem onClick={handleForgetPassword}>
                          <KeyRound className="size-4" />
                          Forget password
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setShowDeleteDialog(true)}
                    >
                      <Trash2 className="size-4" />
                      Delete connection
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </>
        }
        isEmpty={recentProjects.length === 0}
        emptyMessage="No recent projects for this connection"
        onBack={onBack}
        onSelectNewClick={onSelectNewClick}
        loading={loading}
      >
        {recentProjects.map((project) => (
          <ProjectListItem
            key={project.id}
            path={project.path}
            onClick={() => onProjectClick(project.id)}
            onRemove={() => onRemoveProject(project.id)}
            disabled={loading}
          />
        ))}
      </ProjectsListLayout>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete SSH Connection</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the connection to{" "}
              <span className="font-mono">
                {connection.display_name || connection.connection_string}
              </span>
              ? This will also remove all associated projects from recent history. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConnection} variant="destructive">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
