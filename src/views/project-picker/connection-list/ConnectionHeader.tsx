import React, { useEffect, useRef, useState } from "react";
import { Input } from "@/ui/input";
import { Button } from "@/ui/button";
import { Server, Pencil, MoreVertical, Trash2, KeyRound, AlertTriangle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import {
  useUpdateSshConnection,
  useDeleteSshConnection,
  useForgetSavedPassword,
  useSshConnectionById,
} from "@/services/connection.service";
import { toast } from "sonner";

interface ConnectionHeaderProps {
  connectionId: number;
  onDelete: () => void;
}

/**
 * Header component for displaying and managing an SSH connection.
 * Handles rename, delete, and forget password operations.
 */
export function ConnectionHeader({ connectionId, onDelete }: ConnectionHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const { data: connection } = useSshConnectionById(connectionId);
  const inputRef = useRef<HTMLInputElement>(null);

  // Use TanStack Query mutations for all operations
  const { mutate: editConnectionName } = useUpdateSshConnection();
  const { mutate: deleteConnection, isPending: deletePending } = useDeleteSshConnection();
  const { mutate: forgetPassword } = useForgetSavedPassword();

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleStartEdit = () => {
    if (connection) {
      setIsEditing(true);
      setEditName(connection.display_name ?? connection.connection_string);
    }
  };

  const handleSaveEdit = () => {
    if (
      connection &&
      editName.trim() !== (connection.display_name ?? connection.connection_string)
    ) {
      editConnectionName({
        connectionId: connection.id,
        displayName: editName.trim(),
      });
    }
    setIsEditing(false);
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

  const handleDeleteConnection = () => {
    if (connection) {
      deleteConnection(connection.id, {
        onSuccess: () => {
          setShowDeleteDialog(false);
          // Notify parent that connection was deleted
          toast.success("Connection deleted successfully");
          onDelete();
        },
      });
    }
  };

  const { preflightResult, preflightStatus } = useConnectionContext();
  const failedTools =
    preflightStatus === "failed-ignored"
      ? (preflightResult?.tool_checks.filter((t) => !t.available) ?? [])
      : [];
  const hasMandatoryFail = failedTools.some((t) => t.mandatory);

  // Check if connection has a saved password
  const hasSavedPassword =
    connection &&
    typeof connection.auth_method === "object" &&
    "Password" in connection.auth_method &&
    connection.auth_method.Password.save_password;

  return (
    <>
      <Server className="w-5 h-5 text-muted-foreground" />
      {isEditing ? (
        <div className="flex-1 flex items-center gap-2">
          <Input
            ref={inputRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={handleEditKeyDown}
            onBlur={handleSaveEdit}
            className="flex-1 font-mono text-sm h-8 selection:bg-accent selection:text-accent-foreground"
            autoFocus
          />
        </div>
      ) : connection ? (
        <>
          <h2 className="text-lg font-semibold truncate flex-1">
            {connection.display_name || connection.connection_string}
          </h2>
          {failedTools.length > 0 && (
            <Popover>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <PopoverTrigger className="p-1 rounded-md transition-colors cursor-pointer shrink-0" />
                  }
                >
                  <AlertTriangle
                    className={`size-4 ${hasMandatoryFail ? "text-destructive" : "text-amber-400"}`}
                  />
                </TooltipTrigger>
                <TooltipContent>Environment warnings</TooltipContent>
              </Tooltip>
              <PopoverContent side="bottom" align="end" className="w-64 gap-2">
                <p className="text-xs font-medium text-muted-foreground">Environment warnings</p>
                <ul className="flex flex-col gap-1.5">
                  {failedTools.map((t) => (
                    <li key={t.tool} className="flex items-start gap-2 text-xs">
                      <AlertTriangle
                        className={`size-3 mt-0.5 shrink-0 ${t.mandatory ? "text-destructive" : "text-amber-400"}`}
                      />
                      <span>
                        <span className="font-mono">{t.tool}</span> not found
                        {t.required_by.length > 0 && (
                          <span className="text-muted-foreground">
                            {" "}
                            — agents using this tool will be unavailable
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger className="p-1.5 rounded-md hover:text-accent transition-colors cursor-pointer" />
                }
              >
                <MoreVertical className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Connection actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent className="w-auto" align="end">
              {hasSavedPassword && (
                <>
                  <DropdownMenuItem onClick={() => forgetPassword(connection.id)}>
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
      ) : (
        <></>
      )}

      {connection && (
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
              <AlertDialogAction
                onClick={handleDeleteConnection}
                variant="destructive"
                disabled={deletePending}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
