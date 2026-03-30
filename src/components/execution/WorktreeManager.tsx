import { useState, useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib";
import { parseDiffString } from "@/lib";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Plus, Trash2 } from "lucide-react";
import { useNavigate } from "@/store/navigationStore";
import { useWorktreeDiffQuery, useDeleteWorktreeMutation, useCreateWorktreeMutation } from "@/services/worktree.service";
import { DiffViewer } from "@/components/execution/DiffViewer";
import type { WorktreeWithStatus } from "@/types/bindings";

export const STATUS_FILTERS = ["All", "Active", "Modified", "Idle"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

function parseDiffStat(
  raw: string | null,
): { files: number; insertions: number; deletions: number } | null {
  if (!raw) return null;
  const filesMatch = raw.match(/(\d+) files? changed/);
  const insMatch = raw.match(/(\d+) insertions?\(\+\)/);
  const delMatch = raw.match(/(\d+) deletions?\(-\)/);
  if (!filesMatch && !insMatch && !delMatch) return null;
  return {
    files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

interface WorktreeManagerProps {
  worktrees: WorktreeWithStatus[];
  selectedWorktreeId: number | null;
  onSelect: (worktreeId: number | null) => void;
  repoPath: string;
  projectId: number;
  search: string;
  statusFilter: StatusFilter;
}

export function WorktreeManager({
  worktrees,
  selectedWorktreeId,
  onSelect,
  repoPath,
  projectId,
  search,
  statusFilter,
}: WorktreeManagerProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const navigate = useNavigate();

  const deleteMutation = useDeleteWorktreeMutation();
  const createMutation = useCreateWorktreeMutation();

  const filteredWorktrees = useMemo(() => {
    return worktrees
      .filter((wt) => {
        if (statusFilter === "All") return true;
        if (statusFilter === "Active") return wt.agent_status === "running";
        if (statusFilter === "Modified") return wt.git_status !== "";
        if (statusFilter === "Idle")
          return wt.agent_status !== "running" && wt.git_status === "";
        return true;
      })
      .filter(
        (wt) =>
          search.trim() === "" ||
          wt.branch_name.toLowerCase().includes(search.toLowerCase()),
      );
  }, [worktrees, statusFilter, search]);

  const selectedWorktree = worktrees.find((w) => w.id === selectedWorktreeId) ?? null;

  const { data: diffString, isLoading: diffLoading, error: diffError } = useWorktreeDiffQuery(
    selectedWorktree?.id ?? null,
  );

  const diffFiles = useMemo(() => {
    if (!diffString) return [];
    return parseDiffString(diffString);
  }, [diffString]);

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-72 flex flex-col border-r border-border bg-card shrink-0">
        {/* New Worktree button row */}
        <div className="px-3 py-2 border-b border-border">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs w-full"
            onClick={() => setShowCreateDialog(true)}
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            New Worktree
          </Button>
        </div>

        {/* Worktree list */}
        <div className="flex-1 overflow-y-auto">
          {worktrees.length === 0 && (
            <div className="text-xs text-muted-foreground py-8 text-center">
              No worktrees found
            </div>
          )}
          {worktrees.length > 0 && filteredWorktrees.length === 0 && (
            <div className="text-xs text-muted-foreground py-8 text-center">
              No worktrees match your filter
            </div>
          )}
          {filteredWorktrees.map((wt) => {
            const diffStat = parseDiffStat(wt.diff_stat);
            return (
              <div
                key={wt.path}
                onClick={() => onSelect(wt.id)}
                className={cn(
                  "px-3 py-3 cursor-pointer border-l-2 transition-colors",
                  wt.id === selectedWorktreeId
                    ? "border-ring bg-muted/20"
                    : "border-transparent hover:bg-muted/10",
                )}
              >
                {/* Line 1: status dot + branch name + badges */}
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-block w-2 h-2 rounded-full shrink-0",
                      wt.git_status === "" ? "bg-success" : "bg-warning",
                    )}
                  />
                  <span className="text-sm font-medium truncate font-mono">
                    {wt.branch_name}
                  </span>
                  {wt.is_zombie && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-warning/15 text-warning font-medium">
                      Zombie
                    </span>
                  )}
                  {wt.is_orphan && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                      Orphan
                    </span>
                  )}
                </div>

                {/* Line 2: task name (clickable) or "No task" */}
                <div className="mt-0.5 pl-4">
                  {wt.task_name && wt.task_id ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate({ taskId: String(wt.task_id) });
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground hover:underline truncate"
                    >
                      {wt.task_name}
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">No task</span>
                  )}
                </div>

                {/* Line 3: diff shortstat (dirty worktrees only) */}
                {diffStat && (
                  <div className="text-xs mt-0.5 pl-4">
                    <span className="text-muted-foreground">{diffStat.files} files changed</span>
                    {diffStat.insertions > 0 && (
                      <span className="text-success ml-1">+{diffStat.insertions}</span>
                    )}
                    {diffStat.deletions > 0 && (
                      <span className="text-destructive ml-1">-{diffStat.deletions}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedWorktree ? (
          <>
            {/* Detail header */}
            <div className="px-4 py-3 border-b border-border bg-muted/30 shrink-0">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold font-mono">{selectedWorktree.branch_name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    {selectedWorktree.task_name && selectedWorktree.task_id ? (
                      <button
                        onClick={() => navigate({ taskId: String(selectedWorktree.task_id) })}
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {selectedWorktree.task_name}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">No task linked</span>
                    )}
                    {selectedWorktree.agent_status === "running" && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning/15 text-warning font-medium">
                        Running
                      </span>
                    )}
                    {selectedWorktree.created_at && (
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(selectedWorktree.created_at), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                </div>
                {/* Clean up button */}
                <AlertDialog>
                  <AlertDialogTrigger render={<Button variant="destructive" size="sm" className="h-8 text-xs" />}>
                    <Trash2 className="w-3.5 h-3.5 mr-1" />
                    Clean up
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete worktree?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will remove the worktree directory and its database record.
                        Branch: <span className="font-mono font-medium">{selectedWorktree.branch_name}</span>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          if (selectedWorktree.id != null) {
                            deleteMutation.mutate(
                              { worktreeId: selectedWorktree.id, repoPath },
                              { onSuccess: () => onSelect(null) },
                            );
                          }
                        }}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>

            {/* Diff body */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {diffLoading ? (
                <DiffViewer diffFile={null} loading={true} />
              ) : selectedWorktree.git_status === "" ? (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  No uncommitted changes
                </div>
              ) : diffFiles.length > 0 ? (
                <div className="p-4 space-y-4">
                  {diffFiles.map((file, i) => (
                    <DiffViewer key={i} diffFile={file} loading={false} />
                  ))}
                </div>
              ) : (
                <DiffViewer
                  diffFile={null}
                  loading={false}
                  error={diffError ? String(diffError) : undefined}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Select a worktree to view details
          </div>
        )}
      </div>

      {/* Create Worktree dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Worktree</DialogTitle>
            <DialogDescription>
              Check out an existing branch in a new git worktree.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="branch-name">Branch name</Label>
              <Input
                id="branch-name"
                placeholder="feature/my-branch"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newBranchName.trim() || createMutation.isPending}
              onClick={() => {
                createMutation.mutate(
                  {
                    projectId,
                    taskId: null,
                    originBranch: newBranchName.trim(),
                    newBranchName: null,
                    repoPath,
                  },
                  {
                    onSuccess: () => {
                      setShowCreateDialog(false);
                      setNewBranchName("");
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
    </div>
  );
}
