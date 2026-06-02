import { useState } from "react";
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
import { Checkbox } from "@/ui/checkbox";
import { Spinner } from "@/ui/spinner";
import { useDeleteWorktreeMutation } from "@/services/worktree.service";
import type { WorktreeWithStatus } from "@/types/bindings";

interface DeleteWorktreeDialogProps {
  worktree: WorktreeWithStatus | null;
  projectId: number;
  onClose: () => void;
  onSuccess?: () => void;
}

export function DeleteWorktreeDialog({
  worktree,
  projectId,
  onClose,
  onSuccess,
}: DeleteWorktreeDialogProps) {
  const [deleteBranch, setDeleteBranch] = useState(true);
  const deleteMutation = useDeleteWorktreeMutation();

  const isBranchLocalOnly = worktree?.ahead_behind == null;

  return (
    <AlertDialog
      open={worktree != null}
      onOpenChange={(open) => {
        if (!open && !deleteMutation.isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete worktree?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove the worktree directory
            {worktree?.id != null && " and its database record"}.
            {worktree && (
              <>
                {" "}
                Branch: <span className="font-mono font-medium">{worktree.branch_name}</span>
              </>
            )}
            {worktree && isBranchLocalOnly && (
              <label className="flex items-center gap-2 mt-3 cursor-pointer">
                <Checkbox
                  checked={deleteBranch}
                  onCheckedChange={(checked) => setDeleteBranch(checked === true)}
                />
                <span className="text-sm text-foreground select-none">
                  Also delete branch <span className="font-mono">{worktree.branch_name}</span>
                </span>
              </label>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending} onClick={onClose}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleteMutation.isPending}
            onClick={() => {
              if (worktree == null) return;
              deleteMutation.mutate(
                {
                  projectId,
                  worktreePath: worktree.path,
                  branchName: worktree.branch_name,
                  worktreeId: worktree.id ?? null,
                  deleteBranch: isBranchLocalOnly && deleteBranch,
                },
                {
                  onSuccess: () => {
                    onClose();
                    onSuccess?.();
                  },
                },
              );
            }}
          >
            {deleteMutation.isPending ? (
              <>
                <Spinner className="size-3.5" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
