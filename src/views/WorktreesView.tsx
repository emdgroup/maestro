import { useState, useMemo, useEffect } from "react";
import { ChevronsUpDown, Group, LayoutGrid, Plus, SearchIcon } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { usePendingWorktreeId, useNavigationActions, useActiveTab } from "@/store/navigationStore";
import { useWorktreesQuery } from "@/services/worktree.service";
import { WorktreeCardGrid } from "@/components/execution/WorktreeCardGrid";
import { WorktreeDiffPanel } from "@/components/execution/WorktreeDiffPanel";
import { DeleteWorktreeDialog } from "@/components/execution/DeleteWorktreeDialog";
import { CreateWorktreeDialog } from "@/components/execution/CreateWorktreeDialog";
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
  const { data: worktrees = [], refetch: refetchWorktrees } = useWorktreesQuery(
    projectId,
    repoPath,
  );
  const activeTab = useActiveTab();
  const pendingWorktreeId = usePendingWorktreeId();
  const { clearPendingWorktree } = useNavigationActions();

  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<"grouped" | "grid">("grid");
  const [worktreeToDelete, setWorktreeToDelete] = useState<WorktreeWithStatus | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // Refresh when tab becomes active — always-mounted views don't remount on navigate so
  // refetchOnMount never fires again; this replicates the prior behaviour.
  useEffect(() => {
    if (activeTab === "worktrees") {
      void refetchWorktrees();
    }
  }, [activeTab, refetchWorktrees]);

  // Deep-link: pendingWorktreeId overrides selection on first mount
  useEffect(() => {
    if (pendingWorktreeId && worktrees.length > 0) {
      const match = worktrees.find((w) => String(w.id) === pendingWorktreeId);
      if (match) {
        setSelectedWorktreePath(match.path);
        clearPendingWorktree();
      }
    }
  }, [worktrees, pendingWorktreeId, clearPendingWorktree]);

  const filteredWorktrees = useMemo<WorktreeWithStatus[]>(() => {
    return worktrees
      .filter((wt) => {
        if (statusFilter === "All") return true;
        if (statusFilter === "Active") return wt.git_status !== "";
        if (statusFilter === "Modified") return wt.git_status !== "";
        if (statusFilter === "Idle") return wt.git_status === "";
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

  const selectedWorktree = worktrees.find((w) => w.path === selectedWorktreePath) ?? null;

  return (
    <div className="flex flex-col h-full">
      {/* Slide container */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div
          className={cn(
            "flex h-full w-[200%] transition-transform duration-300 ease-in-out",
            selectedWorktreePath != null && "-translate-x-1/2",
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
                  onClick={() => setShowCreateDialog(true)}
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
              onSelectWorktree={setSelectedWorktreePath}
              onDeleteWorktree={(path) => {
                const wt = worktrees.find((w) => w.path === path);
                setWorktreeToDelete(wt ?? null);
              }}
              repoPath={repoPath ?? ""}
              emptyMessage={
                worktrees.length === 0 ? "No worktrees yet" : "No worktrees match your filter"
              }
            />
          </div>

          {/* Screen 2 — Diff panel */}
          <div className="w-1/2 h-full flex flex-col min-w-0">
            <WorktreeDiffPanel
              worktree={selectedWorktree}
              projectId={projectId ?? null}
              onClose={() => setSelectedWorktreePath(null)}
            />
          </div>
        </div>
      </div>

      <DeleteWorktreeDialog
        key={worktreeToDelete?.path}
        worktree={worktreeToDelete}
        projectId={projectId ?? 0}
        onClose={() => setWorktreeToDelete(null)}
        onSuccess={() => setSelectedWorktreePath(null)}
      />
      <CreateWorktreeDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        projectId={projectId ?? 0}
        repoPath={repoPath ?? ""}
      />
    </div>
  );
};
