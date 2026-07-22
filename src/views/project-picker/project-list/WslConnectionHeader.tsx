import { useState } from "react";
import { Terminal, MoreVertical, Trash2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { useWslConnections, useDeleteWslConnection } from "@/services/connection.service";
import { toast } from "sonner";

interface WslConnectionHeaderProps {
  connectionId: number;
  onDelete: () => void;
}

export function WslConnectionHeader({ connectionId, onDelete }: WslConnectionHeaderProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const { data: connections } = useWslConnections();
  const connection = connections?.find((c) => c.id === connectionId);
  const { mutate: deleteConnection, isPending: deletePending } = useDeleteWslConnection();

  const handleDelete = () => {
    if (!connection) return;
    deleteConnection(connection.id, {
      onSuccess: () => {
        setShowDeleteDialog(false);
        toast.success("Connection removed successfully");
        onDelete();
      },
    });
  };

  return (
    <>
      <Terminal className="w-5 h-5 text-muted-foreground" />
      {connection && (
        <>
          <h2 className="text-lg font-semibold truncate flex-1">
            {connection.display_name ?? connection.distro_name}
          </h2>
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
              <DropdownMenuItem variant="destructive" onClick={() => setShowDeleteDialog(true)}>
                <Trash2 className="size-4" />
                Remove connection
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {connection && (
        <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove WSL Connection</AlertDialogTitle>
              <AlertDialogDescription>
                <span className="font-mono">
                  {connection.display_name ?? connection.distro_name}
                </span>{" "}
                will be removed from Maestro. The WSL instance itself is not affected. This will
                also remove all associated projects from recent history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                variant="destructive"
                disabled={deletePending}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
