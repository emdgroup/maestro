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
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { useProjectBranchesQuery, taskQueryKeys } from "@/services/task.service";
import { useCreateWorktreeMutation } from "@/services/worktree.service";

interface CreateWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  repoPath: string;
}

export function CreateWorktreeDialog({
  open,
  onOpenChange,
  projectId,
  repoPath,
}: CreateWorktreeDialogProps) {
  const queryClient = useQueryClient();
  const [baseBranch, setBaseBranch] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: branchData } = useProjectBranchesQuery(projectId);
  const branches = branchData ? [...branchData[0].local, ...branchData[0].remote] : [];
  const currentBranch = branchData?.[1] ?? "main";
  const createMutation = useCreateWorktreeMutation();

  useEffect(() => {
    if (!open) return;
    void queryClient.invalidateQueries({
      queryKey: [...taskQueryKeys.base, "branches", projectId],
    });
    setBaseBranch(currentBranch);
    setNewBranchName("");
    setCreateError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Worktree</DialogTitle>
          <DialogDescription>
            Check out a branch in a new git worktree. Optionally create a new branch from it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="base-branch">Base branch</Label>
            <Select value={baseBranch} onValueChange={(v) => setBaseBranch(v ?? "")}>
              <SelectTrigger id="base-branch">
                <SelectValue placeholder="Select a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-branch-name">New branch name (optional)</Label>
            <Input
              id="new-branch-name"
              placeholder="feature/my-branch"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to check out the base branch directly.
            </p>
          </div>
          {createError && <p className="text-sm text-destructive">{createError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!baseBranch || createMutation.isPending}
            onClick={() => {
              setCreateError(null);
              createMutation.mutate(
                {
                  projectId,
                  taskId: null,
                  baseBranch,
                  newBranchName: newBranchName.trim() || null,
                  repoPath,
                },
                {
                  onSuccess: () => {
                    onOpenChange(false);
                    setBaseBranch("");
                    setNewBranchName("");
                    setCreateError(null);
                  },
                  onError: (error) => {
                    setCreateError(String(error));
                  },
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
