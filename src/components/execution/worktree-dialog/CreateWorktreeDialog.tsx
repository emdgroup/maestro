import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { NewWorktreeFields } from "@/components/common/workspace-mode/NewWorktreeFields";
import { findBranchConflict } from "@/components/common/workspace-mode/branch-conflict";
import {
  generateSessionName,
  validateBranchSuffix,
  MAESTRO_BRANCH_PREFIX,
} from "@/lib/generateSessionName";
import { useProjectBranchesQuery, taskQueryKeys } from "@/services/task.service";
import { useDefaultBaseBranch } from "@/hooks/useDefaultBaseBranch";
import {
  useCreateWorktreeMutation,
  useWorktreesQuery,
  worktreeQueryKeys,
} from "@/services/worktree.service";
import type { BranchMode } from "@/types/bindings";

interface CreateWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  repoPath: string;
}

/**
 * Creating a workspace from the Workspaces view.
 *
 * Shares `NewWorktreeFields` with the task and session dialogs so the same question is asked the
 * same way in all three. It passes no `onUseExistingWorkspace`: this dialog exists to create a
 * workspace and has no mode select to switch, so "use the one that already exists" is not an offer
 * it can make.
 */
export function CreateWorktreeDialog({
  open,
  onOpenChange,
  projectId,
  repoPath,
}: CreateWorktreeDialogProps) {
  const queryClient = useQueryClient();
  const [baseBranch, setBaseBranch] = useState("");
  const [branchMode, setBranchMode] = useState<BranchMode>("Create");
  const [branchSuffix, setBranchSuffix] = useState("");
  // Regenerated per open rather than per render, so the placeholder does not churn while typing.
  const [generatedSuffix, setGeneratedSuffix] = useState(generateSessionName);
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: branchData } = useProjectBranchesQuery(projectId);
  const defaultBaseBranch = useDefaultBaseBranch(projectId) || "main";
  const { data: worktrees = [] } = useWorktreesQuery(projectId, repoPath);
  const createMutation = useCreateWorktreeMutation();

  useEffect(() => {
    if (!open) return;
    void queryClient.invalidateQueries({
      queryKey: [...taskQueryKeys.base, "branches", projectId],
    });
    // The conflict check is only as fresh as this list, and a worktree may have been created since
    // the view last loaded.
    void queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.base });
    setBaseBranch(defaultBaseBranch);
    setBranchMode("Create");
    setBranchSuffix("");
    setGeneratedSuffix(generateSessionName());
    setCreateError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const typed = branchSuffix.trim();
  const suffixError = branchMode === "Create" ? validateBranchSuffix(typed) : null;
  const conflict =
    branchMode === "Checkout"
      ? findBranchConflict(baseBranch, worktrees, repoPath, branchData?.[0])
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Workspace</DialogTitle>
          <DialogDescription>
            A worktree of its own, on a new branch or on one that already exists.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <NewWorktreeFields
            branchMode={branchMode}
            onBranchModeChange={setBranchMode}
            branch={baseBranch}
            onBranchChange={setBaseBranch}
            branchSuffix={branchSuffix}
            onBranchSuffixChange={setBranchSuffix}
            generatedSuffix={generatedSuffix}
            worktrees={worktrees}
            repoPath={repoPath}
          />
          {createError && <p className="text-sm text-destructive mt-3">{createError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!baseBranch || !!suffixError || conflict !== null || createMutation.isPending}
            onClick={() => {
              setCreateError(null);
              createMutation.mutate(
                {
                  projectId,
                  taskId: null,
                  baseBranch,
                  newBranchName:
                    branchMode === "Checkout"
                      ? null
                      : `${MAESTRO_BRANCH_PREFIX}${typed || generatedSuffix}`,
                  // Only the generated name may be made unique — a typed one is used verbatim.
                  uniqueSuffix: branchMode === "Create" && !typed,
                  repoPath,
                },
                {
                  onSuccess: () => onOpenChange(false),
                  onError: (error) => setCreateError(String(error)),
                },
              );
            }}
          >
            {createMutation.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
