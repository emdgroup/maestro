import { useState, useMemo, useEffect, useRef } from "react";
import { useShortcuts } from "@/utils/hooks/useShortcuts";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { ChevronsUpDown, GitBranch, Plus, RefreshCw, Scissors, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { Spinner } from "@/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/ui/resizable";
import {
  usePendingWorktreeId,
  useNavigationActions,
  useActiveTab,
  useNavigate,
} from "@/store/navigationStore";
import { useWorktreesQuery, usePrunableBranchesQuery } from "@/services/worktree.service";
import { useActiveSessionsQuery } from "@/services/execution.service";
import { useNow } from "@/utils/hooks/useNow";
import { useGitInitProject } from "@/services/project.service";
import { useIsGitRepo, useSelectedProject, useSelectedProjectActions } from "@/store/projectStore";
import { WorktreeCardGrid } from "@/components/execution/worktree-card/WorktreeCardGrid";
import { sessionsByWorktree } from "@/components/execution/worktree-card/worktree-usage";
import {
  pullRequestsByBranch,
  usePullRequestCi,
} from "@/components/execution/worktree-card/pullRequestCi";
import { PullRequestPanel } from "@/components/execution/pull-request-panel/PullRequestPanel";
import type { PullRequestEntry } from "@/components/execution/pull-request-panel/pullRequestFilters";
import {
  SpawnSessionDialog,
  type SpawnSeed,
} from "@/components/execution/spawn-session-dialog/SpawnSessionDialog";
import { useCodeHostingStatus, useProjectPullRequests } from "@/services/integration.service";
import { WorktreeDiffPanel } from "@/components/execution/diff/WorktreeDiffPanel";
import { DeleteWorktreeDialog } from "@/components/execution/worktree-dialog/DeleteWorktreeDialog";
import { CreateWorktreeDialog } from "@/components/execution/worktree-dialog/CreateWorktreeDialog";
import { PruneBranchesDialog } from "@/components/execution/worktree-dialog/PruneBranchesDialog";
import type { ConnectionKey, WorktreeWithStatus } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";
import { toast } from "sonner";

export const STATUS_FILTERS = ["All", "Active", "Modified", "Idle"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

interface WorktreesViewProps {
  projectId?: number;
  repoPath?: string;
  /** Needed only to start a session from a pull request, which the spawn dialog cannot do without. */
  connection: ConnectionKey;
}

/**
 * WorktreesView - Page-level orchestrator for the worktree management screen.
 * Uses a card grid layout grouped by base_branch with collapsible sections.
 * Selecting a worktree opens its diff over the grid, the way a task review opens over the board.
 */
export const WorktreesView: React.FC<WorktreesViewProps> = ({
  projectId,
  repoPath,
  connection,
}) => {
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
  const { data: sessions = [] } = useActiveSessionsQuery(projectId);
  // The age labels are derived at render, so something has to re-render them; one ticker here
  // drives every card rather than one timer per card.
  const now = useNow();
  const { data: prunableBranches = [], refetch: refetchPrunableBranches } =
    usePrunableBranchesQuery(isGitRepo ? projectId : undefined);
  const activeTab = useActiveTab();
  const pendingWorktreeId = usePendingWorktreeId();
  const { clearPendingWorktree } = useNavigationActions();
  const navigate = useNavigate();

  // Every pull request in the project, in one request — the cards and the panel look themselves up
  // in this list rather than each asking the forge. Gated on the view being on screen, because a
  // Kanban user is not looking at any of it.
  const onWorktreesTab = activeTab === "worktrees";
  const { data: hosting } = useCodeHostingStatus(projectId ?? 0);
  const { data: pullRequests = [] } = useProjectPullRequests(projectId ?? null, onWorktreesTab);
  const byBranch = useMemo(() => pullRequestsByBranch(pullRequests), [pullRequests]);
  const ciByNumber = usePullRequestCi(projectId ?? null, pullRequests, onWorktreesTab);
  // Shown whenever the forge can answer, including when the answer is none — an empty panel says
  // there is nothing to pick up, which is information. A project with no forge gets no column at
  // all, because for it there is no such thing as a pull request.
  const showPullRequests =
    projectId != null && hosting?.rung === "Ready" && hosting.forge_supports_branch_lookup === true;

  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [worktreeToDelete, setWorktreeToDelete] = useState<WorktreeWithStatus | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showPruneDialog, setShowPruneDialog] = useState(false);
  const [spawnSeed, setSpawnSeed] = useState<SpawnSeed | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useShortcuts("worktrees", {
    "wt-new": () => setShowCreateDialog(true),
    "wt-refresh": () => {
      void refetchWorktrees();
      void refetchPrunableBranches();
    },
    "focus-search": () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
  });

  // Refresh when tab becomes active — always-mounted views don't remount on navigate so
  // refetchOnMount never fires again; this replicates the prior behaviour.
  useEffect(() => {
    if (activeTab === "worktrees") {
      void refetchWorktrees();
      void refetchPrunableBranches();
    }
  }, [activeTab, refetchWorktrees, refetchPrunableBranches]);

  // Deep-link: pendingWorktreeId overrides selection once the worktree list resolves.
  // The local selection is adjusted during render so the view opens on the right worktree
  // in the same frame; clearing the shared navigation store stays in an effect, because
  // writing another component's state during render is not safe.
  const deepLinkedPath = pendingWorktreeId
    ? (worktrees.find((w) => String(w.id) === pendingWorktreeId)?.path ?? null)
    : null;
  const [consumedDeepLink, setConsumedDeepLink] = useState(deepLinkedPath);
  if (consumedDeepLink !== deepLinkedPath) {
    setConsumedDeepLink(deepLinkedPath);
    if (deepLinkedPath) setSelectedWorktreePath(deepLinkedPath);
  }

  useEffect(() => {
    if (deepLinkedPath) clearPendingWorktree();
  }, [deepLinkedPath, clearPendingWorktree]);

  const filteredWorktrees = useMemo<WorktreeWithStatus[]>(() => {
    return worktrees
      .filter((wt) => {
        if (statusFilter === "All") return true;
        if (statusFilter === "Active") return wt.changed_files_count > 0;
        if (statusFilter === "Modified") return wt.changed_files_count > 0;
        if (statusFilter === "Idle") return wt.changed_files_count === 0;
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

  // Resolved against every worktree rather than the filtered list, so a card's session count does
  // not change with the search box — and so a session in `.maestro/worktrees/…` is credited to its
  // own worktree rather than to the repository directory that contains it.
  const sessionsByPath = useMemo(
    () => sessionsByWorktree(worktrees, sessions),
    [worktrees, sessions],
  );

  const toggleGroup = (group: string) =>
    setCollapsedGroups((prev) => ({ ...prev, [group]: !prev[group] }));

  const toggleAll = () => {
    const groupKeys = groupedWorktrees.map((g) => g.groupKey);
    const anyExpanded = groupKeys.some((k) => !collapsedGroups[k]);
    setCollapsedGroups(Object.fromEntries(groupKeys.map((k) => [k, anyExpanded])));
  };

  const selectedWorktree = worktrees.find((w) => w.path === selectedWorktreePath) ?? null;

  /**
   * What a pull request row does when clicked, decided in `pullRequestEntries`.
   *
   * An existing session is navigated to rather than added to — a second agent in the same worktree
   * would be two writers on one checkout. The other two both open the spawn dialog, seeded
   * differently, because the agent to run is still the user's choice and this view has no picker.
   */
  function handlePullRequestAction(entry: PullRequestEntry) {
    switch (entry.action.kind) {
      case "open-session":
        navigate({ sessionKey: entry.action.sessionKey });
        return;
      case "reuse-worktree":
        setSpawnSeed({
          workspaceMode: "ReuseWorkspace",
          worktree: entry.action.worktree,
          sessionName: entry.pullRequest.title,
        });
        return;
      case "new-worktree":
        setSpawnSeed({
          workspaceMode: "NewWorktree",
          branchMode: "Checkout",
          baseBranch: entry.action.baseBranch,
          sessionName: entry.pullRequest.title,
        });
    }
  }

  if (!isGitRepo) {
    const handleInitGit = async () => {
      if (!repoPath || !projectId) return;
      try {
        await gitInitProject({
          path: repoPath,
          connectionId: selectedProject?.connection_id ?? null,
          wslConnectionId: selectedProject?.wsl_connection_id ?? null,
          dockerConnectionId: selectedProject?.docker_connection_id ?? null,
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
    // `bg-card` all the way up, so the toolbar and the pull request column are one surface and the
    // grid is the inset island on it. The toolbar's own tint is gone: it was a band across the top
    // of both columns, which is the seam this layout exists to remove.
    <div className="flex flex-col h-full bg-card">
      {/* Action bar — full width, above both columns. It carries no bottom border of its own: the
          inset grid below draws that line and rounds away from the pull request column, and the
          absence of one over the column is what lets the two read as a single surface. */}
      <div className="h-12 flex items-center justify-between px-4 gap-2 shrink-0">
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-8 w-8"
                    disabled={isFetching}
                    onClick={() => void refetchWorktrees()}
                  />
                }
              >
                <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
              </TooltipTrigger>
              <TooltipContent>Refresh worktrees</TooltipContent>
            </Tooltip>
          </ShortcutHint>
          {prunableBranches.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setShowPruneDialog(true)}
            >
              <Scissors className="w-3.5 h-3.5 mr-1" />
              <span className="text-xs">Prune branches ({prunableBranches.length})</span>
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-8" onClick={toggleAll}>
            <ChevronsUpDown className="w-3.5 h-3.5 mr-1" />
            <span className="text-xs">Collapse all</span>
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

      <div className="flex-1 min-h-0 overflow-hidden bg-card">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel minSize="28rem" className="flex h-full min-w-0 flex-col">
            {/* The inset surface, the way the session view's content sits beside its side panel:
                its own top edge, rounding away from the column on its right. The border is dropped
                when there is no column to round away from — a curve at the window edge is just a
                gap. */}
            <div
              className={cn(
                "flex flex-1 min-h-0 flex-col overflow-hidden border-t border-border bg-background",
                showPullRequests && "rounded-tr-xl border-r",
              )}
            >
              {isLoading ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  <Spinner className="size-5" />
                  <span>Loading worktrees...</span>
                </div>
              ) : (
                <WorktreeCardGrid
                  sessionsByPath={sessionsByPath}
                  now={now}
                  groups={groupedWorktrees}
                  collapsedGroups={collapsedGroups}
                  onToggleGroup={toggleGroup}
                  onSelectWorktree={setSelectedWorktreePath}
                  onDeleteWorktree={(path) => {
                    const wt = worktrees.find((w) => w.path === path);
                    setWorktreeToDelete(wt ?? null);
                  }}
                  repoPath={repoPath ?? ""}
                  projectId={projectId ?? null}
                  pullRequestsByBranch={byBranch}
                  ciByNumber={ciByNumber}
                  emptyMessage={
                    worktrees.length === 0 ? "No worktrees yet" : "No worktrees match your filter"
                  }
                />
              )}
            </div>
          </ResizablePanel>

          {showPullRequests && (
            <>
              {/* No bar of its own, at rest or on hover — the grip lights up instead. The handle
                  runs the full height, so a hover tint on it paints a stripe past the rounded
                  corner and up alongside the toolbar. `hover:bg-transparent` is the load-bearing
                  half: it cancels the base component's `hover:bg-accent/60`. Same treatment as the
                  diff view's file list, which has the same rounded corner beside it. */}
              <ResizableHandle
                withHandle
                className="bg-transparent hover:bg-transparent hover:[&>div]:bg-accent"
              />
              <ResizablePanel
                defaultSize="28rem"
                minSize="18rem"
                maxSize="55%"
                className="flex h-full min-w-0 flex-col"
              >
                <PullRequestPanel
                  projectId={projectId}
                  pullRequests={pullRequests}
                  worktrees={worktrees}
                  sessionsByPath={sessionsByPath}
                  ciByNumber={ciByNumber}
                  remote={hosting?.remote ?? "origin"}
                  now={now}
                  poll={onWorktreesTab}
                  onAct={handlePullRequestAction}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>

      {/* Mounted only while seeded, so the dialog's open-effect reads this pull request's seed
          rather than the previous one's. */}
      {spawnSeed != null && projectId != null && (
        <SpawnSessionDialog
          open
          onOpenChange={(open) => {
            if (!open) setSpawnSeed(null);
          }}
          projectId={projectId}
          repoPath={repoPath ?? ""}
          connection={connection}
          worktrees={worktrees}
          seed={spawnSeed}
          onSuccess={(sessionKey) => {
            setSpawnSeed(null);
            navigate({ sessionKey });
          }}
        />
      )}

      {/* Over the grid rather than beside it, the same way a task review sits over the board: the
          worktree you opened stays visible behind, and the diff gets the whole window instead of
          half of it.

          Escape closes it, and has to be handled here rather than through the shortcut registry:
          base-ui's dialog consumes the key itself, so a `window` listener — which is all
          `useShortcuts` has — never sees it. Unlike a task review this panel is a pure read, with
          no comments to lose, so there is nothing to protect the user from. A click on the margin
          still does nothing: that is a slip, not a decision. */}
      <Dialog
        open={selectedWorktreePath != null && selectedWorktree != null}
        onOpenChange={(open, details) => {
          if (open || details.reason === "outside-press") return;
          setSelectedWorktreePath(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="w-[calc(100vw-2.5rem)] h-[calc(100vh-2.5rem)] max-w-none sm:max-w-none flex flex-col p-0 gap-0 overflow-hidden"
        >
          <DialogTitle className="sr-only">
            Changes in {selectedWorktree?.branch_name ?? "worktree"}
          </DialogTitle>
          <WorktreeDiffPanel
            worktree={selectedWorktree}
            projectId={projectId ?? null}
            onClose={() => setSelectedWorktreePath(null)}
          />
        </DialogContent>
      </Dialog>

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
      {/* Remounted per open so the selection is seeded from a fresh candidate list rather than
          carrying over ticks made against branches that may since have gone. */}
      {showPruneDialog && (
        <PruneBranchesDialog
          open
          onOpenChange={setShowPruneDialog}
          projectId={projectId ?? 0}
          branches={prunableBranches}
        />
      )}
    </div>
  );
};
