import React, { useState } from "react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { SshConnection } from "../types/bindings";
import { Server, Pencil, MoreVertical, Trash2, KeyRound } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUpdateSshConnectionMutation } from "@/hooks/useSshConnectionsQuery";
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

interface ConnectionHeaderProps {
  connection: SshConnection;
  onDelete: () => void;
  onEditName: (name: string) => void;
}

/**
 * Header component for displaying and managing an SSH connection.
 * Handles rename, delete, and forget password operations.
 */
export function ConnectionHeader({ connection, onDelete, onEditName }: ConnectionHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Use TanStack Query mutation for rename
  const updateConnectionMutation = useUpdateSshConnectionMutation();

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

    // Use mutation - it will automatically invalidate cache and update UI everywhere
    await updateConnectionMutation.mutateAsync({
      connectionId: connection.id,
      displayName: editName.trim(),
    });

    setIsEditing(false);

    // Also update local state in ConnectionContext
    onEditName(editName.trim());
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
      await invoke("delete_ssh_connection", {
        connectionId: connection.id,
      });
      setShowDeleteDialog(false);
      toast.success("Connection deleted");
      // Notify parent that connection was deleted
      onDelete();
    } catch (error) {
      toast.error(`Failed to delete connection: ${error}`);
    }
  };

  const handleForgetPassword = async () => {
    try {
      await invoke("forget_saved_password", {
        connectionId: connection.id,
      });
      toast.success("Password forgotten");
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
              <DropdownMenuItem variant="destructive" onClick={() => setShowDeleteDialog(true)}>
                <Trash2 className="size-4" />
                Delete connection
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

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
