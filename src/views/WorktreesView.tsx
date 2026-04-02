import { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, Group, LayoutGrid, Plus, SearchIcon } from "lucide-react";
import { cn } from "@/lib";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui";
import { usePendingWorktreeId, useNavigationActions } from "@/store/navigationStore";
import {
  useWorktreesQuery,
  useDeleteWorktreeMutation,
  useCreateWorktreeMutation,
} from "@/services/worktree.service";
import { useProjectBranchesQuery, taskQueryKeys } from "@/services/task.service";
import { WorktreeCardGrid } from "@/components/execution/WorktreeCardGrid";
import { WorktreeDiffPanel } from "@/components/execution/WorktreeDiffPanel";
import type { WorktreeWithStatus } from "@/types/bindings";

export const STATUS_FILTERS = ["All", "Active", "Modified", "Idle"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

interface WorktreesViewProps {
  projectId?: number;
  repoPath?: string;
}

/**
 * WorktreesView - Page-level orchestrator for the worktree management screen.
 * Uses a card grid layout grouped by base_branch with collapsible sections.
 * A slide container animates between the card grid and the diff panel (Plan 03).
 */
export const WorktreesView: React.FC<WorktreesViewProps> = ({ projectId, repoPath }) => {
  const { data: worktrees = [] } = useWorktreesQuery(projectId, repoPath);
  const pendingWorktreeId = usePendingWorktreeId();
  const { clearPendingWorktree } = useNavigationActions();
  const queryClient = useQueryClient();

  const [selectedWorktreeId, setSelectedWorktreeId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<"grouped" | "grid">("grouped");

  // Delete dialog state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  // Create dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [originBranch, setOriginBranch] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const deleteMutation = useDeleteWorktreeMutation();
  const createMutation = useCreateWorktreeMutation();

  const { data: branchData } = useProjectBranchesQuery(projectId ?? 0);
  const branches = branchData?.[0] ?? [];
  const currentBranch = branchData?.[1] ?? "main";

  // Deep-link: pendingWorktreeId overrides selection on first mount
  useEffect(() => {
    if (pendingWorktreeId && worktrees.length > 0) {
      const match = worktrees.find((w) => String(w.id) === pendingWorktreeId);
      if (match && match.id != null) {
        setSelectedWorktreeId(match.id);
        clearPendingWorktree();
      }
    }
  }, [worktrees, pendingWorktreeId, clearPendingWorktree]);

  const filteredWorktrees = useMemo<WorktreeWithStatus[]>(() => {
    return worktrees
      .filter((wt) => {
        if (statusFilter === "All") return true;
        if (statusFilter === "Active") return wt.agent_status === "running";
        if (statusFilter === "Modified") return wt.git_status !== "";
        if (statusFilter === "Idle") return wt.agent_status !== "running" && wt.git_status === "";
        return true;
      })
      .filter(
        (wt) => search.trim() === "" || wt.branch_name.toLowerCase().includes(search.toLowerCase()),
      );
  }, [worktrees, statusFilter, search]);

  const groupedWorktrees = useMemo(() => {
    const groupMap = new Map<string, WorktreeWithStatus[]>();
    for (const wt of filteredWorktrees) {
      const key = wt.base_branch ?? wt.branch_name;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(wt);
    }
    return Array.from(groupMap.entries()).map(([groupKey, items]) => ({ groupKey, items }));
  }, [filteredWorktrees]);

  const flatWorktrees = useMemo(() => {
    return [...filteredWorktrees].sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA;
    });
  }, [filteredWorktrees]);

  const toggleGroup = (group: string) =>
    setCollapsedGroups((prev) => ({ ...prev, [group]: !prev[group] }));

  const toggleAll = () => {
    const groupKeys = groupedWorktrees.map((g) => g.groupKey);
    const anyExpanded = groupKeys.some((k) => !collapsedGroups[k]);
    setCollapsedGroups(Object.fromEntries(groupKeys.map((k) => [k, anyExpanded])));
  };

  const pendingDeleteWorktree = worktrees.find((w) => w.id === pendingDeleteId) ?? null;
  const selectedWorktree = worktrees.find((w) => w.id === selectedWorktreeId) ?? null;

  return (
    <div className="flex flex-col h-full">
      {/* Slide container */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div
          className={cn(
            "flex h-full w-[200%] transition-transform duration-300 ease-in-out",
            selectedWorktreeId != null && "-translate-x-1/2",
          )}
        >
          {/* Screen 1 — Card grid */}
          <div className="w-1/2 h-full flex flex-col min-w-0">
            {/* Action bar */}
            <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0">
              <div className="flex items-center gap-2">
                <InputGroup>
                  <InputGroupInput
                    type="text"
                    placeholder="Search branches..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 w-48 text-sm"
                  />
                  <InputGroupAddon align="inline-start">
                    <SearchIcon className="text-muted-foreground" />
                  </InputGroupAddon>
                </InputGroup>
                <ToggleGroup variant="outline" size="sm" value={[statusFilter]}>
                  {STATUS_FILTERS.map((f) => (
                    <ToggleGroupItem
                      key={f}
                      value={f}
                      pressed={statusFilter === f}
                      onClick={() => setStatusFilter(f)}
                      className="text-xs px-3"
                    >
                      {f}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <div className="flex items-center gap-2">
                {viewMode === "grouped" && (
                  <Button variant="ghost" size="sm" className="h-8" onClick={toggleAll}>
                    <ChevronsUpDown className="w-3.5 h-3.5 mr-1" />
                    <span className="text-xs">Collapse all</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={() => setViewMode((prev) => (prev === "grouped" ? "grid" : "grouped"))}
                >
                  {viewMode === "grouped" ? (
                    <LayoutGrid className="w-3.5 h-3.5 mr-1" />
                  ) : (
                    <Group className="w-3.5 h-3.5 mr-1" />
                  )}
                  <span className="text-xs">
                    {viewMode === "grouped" ? "Grid view" : "Grouped view"}
                  </span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    void queryClient.invalidateQueries({
                      queryKey: [...taskQueryKeys.all, "branches", projectId],
                    });
                    setOriginBranch(currentBranch);
                    setNewBranchName("");
                    setCreateError(null);
                    setShowCreateDialog(true);
                  }}
                >
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  New Worktree
                </Button>
              </div>
            </div>

            <WorktreeCardGrid
              viewMode={viewMode}
              flatWorktrees={flatWorktrees}
              groups={groupedWorktrees}
              collapsedGroups={collapsedGroups}
              onToggleGroup={toggleGroup}
              onSelectWorktree={setSelectedWorktreeId}
              onDeleteWorktree={(id) => {
                setPendingDeleteId(id);
                setShowDeleteDialog(true);
              }}
              emptyMessage={
                worktrees.length === 0 ? "No worktrees yet" : "No worktrees match your filter"
              }
            />
          </div>

          {/* Screen 2 — Diff panel */}
          <div className="w-1/2 h-full flex flex-col min-w-0">
            <WorktreeDiffPanel
              worktree={selectedWorktree}
              onClose={() => setSelectedWorktreeId(null)}
            />
          </div>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worktree?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the worktree directory and its database record.
              {pendingDeleteWorktree && (
                <>
                  {" "}
                  Branch:{" "}
                  <span className="font-mono font-medium">
                    {pendingDeleteWorktree.branch_name}
                  </span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setPendingDeleteId(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowDeleteDialog(false);
                if (pendingDeleteId != null) {
                  deleteMutation.mutate(
                    { worktreeId: pendingDeleteId, repoPath: repoPath ?? "" },
                    {
                      onSuccess: () => {
                        setSelectedWorktreeId(null);
                        setPendingDeleteId(null);
                      },
                    },
                  );
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Worktree dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Worktree</DialogTitle>
            <DialogDescription>
              Check out a branch in a new git worktree. Optionally create a new branch from it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="origin-branch">Origin branch</Label>
              <Select value={originBranch} onValueChange={(v) => setOriginBranch(v ?? "")}>
                <SelectTrigger id="origin-branch">
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
                Leave blank to check out the origin branch directly.
              </p>
            </div>
            {createError && <p className="text-sm text-destructive">{createError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              disabled={!originBranch || createMutation.isPending}
              onClick={() => {
                setCreateError(null);
                createMutation.mutate(
                  {
                    projectId: projectId ?? 0,
                    taskId: null,
                    originBranch,
                    newBranchName: newBranchName.trim() || null,
                    repoPath: repoPath ?? "",
                  },
                  {
                    onSuccess: () => {
                      setShowCreateDialog(false);
                      setOriginBranch("");
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
    </div>
  );
};
