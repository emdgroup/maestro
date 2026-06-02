import { useState, useMemo, useEffect, useRef } from "react";
import { useShortcuts } from "@/utils/hooks/useShortcuts";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { ChevronsUpDown, GitBranch, Group, LayoutGrid, Plus, RefreshCw, SearchIcon } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { usePendingWorktreeId, useNavigationActions, useActiveTab } from "@/store/navigationStore";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useGitInitProject } from "@/services/project.service";
import { useIsGitRepo, useSelectedProject, useSelectedProjectActions } from "@/store/projectStore";
import { WorktreeCardGrid } from "@/components/execution/worktree-card/WorktreeCardGrid";
import { WorktreeDiffPanel } from "@/components/execution/diff/WorktreeDiffPanel";
import { DeleteWorktreeDialog } from "@/components/execution/worktree-dialog/DeleteWorktreeDialog";
import { CreateWorktreeDialog } from "@/components/execution/worktree-dialog/CreateWorktreeDialog";
import type { WorktreeWithStatus } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";
import { toast } from "sonner";

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
  const isGitRepo = useIsGitRepo();
  const selectedProject = useSelectedProject();
  const { mutateAsync: gitInitProject, isPending: isInitializing } = useGitInitProject();
  const { setSelectedProject } = useSelectedProjectActions();
  const {
    data: worktrees = [],
    refetch: refetchWorktrees,
    isLoading,
    isFetching,
  } = useWorktreesQuery(isGitRepo ? projectId : undefined, isGitRepo ? repoPath : undefined);
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
  const searchInputRef = useRef<HTMLInputElement>(null);

  useShortcuts("worktrees", {
    "wt-new":       () => setShowCreateDialog(true),
    "wt-refresh":   () => { void refetchWorktrees(); },
    "wt-close-diff": () => { if (selectedWorktreePath !== null) setSelectedWorktreePath(null); },
    "focus-search": () => { searchInputRef.current?.focus(); searchInputRef.current?.select(); },
  });

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

  if (!isGitRepo) {
    const handleInitGit = async () => {
      if (!repoPath || !projectId) return;
      try {
        await gitInitProject({
          path: repoPath,
          connectionId: selectedProject?.connection_id ?? null,
          wslConnectionId: selectedProject?.wsl_connection_id ?? null,
        });
        const project = await api.openProject(projectId);
        setSelectedProject(project, true);
        toast.success("Git initialized successfully");
      } catch (error) {
        toast.error(`Failed to initialize git: ${String(error)}`);
      }
    };

    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
        <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center">
          <GitBranch className="w-6 h-6 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Git Repository Required</h3>
          <p className="text-xs text-muted-foreground max-w-sm">
            Worktree isolation requires a git repository. Initialize git in this project to enable
            branch management, worktree isolation, and code review features.
          </p>
        </div>
        <Button onClick={handleInitGit} disabled={isInitializing} size="sm">
          {isInitializing ? "Initializing..." : "Initialize Git"}
        </Button>
      </div>
    );
  }

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
                <ShortcutHint shortcutId="focus-search">
                  <InputGroup>
                    <InputGroupInput
                      ref={searchInputRef}
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
                </ShortcutHint>
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
                <ShortcutHint shortcutId="wt-refresh">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-8 w-8"
                    title="Refresh worktrees"
                    disabled={isFetching}
                    onClick={() => void refetchWorktrees()}
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
                  </Button>
                </ShortcutHint>
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
                <ShortcutHint shortcutId="wt-new">
                  <Button
                    variant="accent"
                    size="sm"
                    className="h-8 text-xs bg-clip-border"
                    onClick={() => setShowCreateDialog(true)}
                  >
                    <Plus className="w-3.5 h-3.5 mr-1" />
                    New Worktree
                  </Button>
                </ShortcutHint>
              </div>
            </div>

            {isLoading ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                <Spinner className="size-5" />
                <span>Loading worktrees...</span>
              </div>
            ) : (
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
            )}
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
