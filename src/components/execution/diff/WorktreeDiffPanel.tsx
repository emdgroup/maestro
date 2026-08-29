import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useActiveTab } from "@/store/navigationStore";
import { DiffModeEnum } from "@git-diff-view/react";
import { parseDiffString } from "@/lib/diff-utils";
import { cn } from "@/lib/utils.ts";
import { DiffActionBar } from "./DiffActionBar";
import { DiffFileStack, type DiffFileStackHandle } from "./DiffFileStack";
import { ReviewLayout, FilePanelToggle } from "./ReviewLayout";
import { ScopeSelector } from "./ScopeSelector";
import { scopeToDiffTarget, type DiffScope } from "./scope";
import { useReviewItems, fileCountFrom } from "./useReviewItems";
import { useReviewPanelLayout } from "./useReviewPanelLayout";
import {
  useWorktreeDiffQuery,
  useWorktreeDiffStatsQuery,
  useWorktreeCommitsQuery,
} from "@/services/worktree.service";
import type { WorktreeWithStatus, DiffTarget } from "@/types/bindings";

interface WorktreeDiffPanelProps {
  worktree: WorktreeWithStatus | null;
  projectId: number | null;
  onClose: () => void;
}

/**
 * A worktree's changes, read the same way a task's are.
 *
 * The same file panel, card stack and scope selector as task review — a diff is a diff, and having
 * learnt to read one here the user should not have to learn another there. What it deliberately
 * does *not* carry is a way to act on the changes: no staging, no hunk selection, no commit,
 * shelve, revert or delete. Those made this panel a second, weaker git client sitting beside the
 * agent's own worktree, and the file selection they needed is what kept the two views apart.
 *
 * It also passes no `review`, so the cards have no comment affordance: a task review's remarks go
 * to the agent that wrote the code, and here there is nobody on the other end.
 */
/**
 * Which scope to open a worktree on.
 *
 * "Uncommitted" is right while an agent is still working, but a finished worktree has committed
 * everything — and opening that empty, on a branch that may hold a dozen commits, reads as "the
 * diff is broken" rather than as "you are looking at the wrong scope". Both fields here describe
 * the working tree only, so this asks exactly the question that matters: is there anything
 * uncommitted to show? `scopeToDiffTarget` falls back to the uncommitted target on its own when
 * there is no base branch to compare against, so widening can never show less.
 */
export function defaultScope(worktree: WorktreeWithStatus | null): DiffScope {
  const hasUncommitted = worktree
    ? worktree.changed_files_count > 0 || worktree.diff_stat !== null
    : true;
  return hasUncommitted ? { type: "uncommitted" } : { type: "all" };
}

export function WorktreeDiffPanel({ worktree, projectId, onClose }: WorktreeDiffPanelProps) {
  const [diffViewMode, setDiffViewMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const [fileSearch, setFileSearch] = useState("");
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [scope, setScope] = useState<DiffScope>(() => defaultScope(worktree));
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const stackRef = useRef<DiffFileStackHandle>(null);
  const panel = useReviewPanelLayout();

  const toggleViewed = useCallback((fileName: string) => {
    setViewedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }, []);

  const worktreePath = worktree?.path ?? null;
  const baseBranch = worktree?.base_branch ?? null;

  /**
   * Re-pick the scope when a different worktree is shown, rather than relying on the panel
   * unmounting between openings. The dialog hands this component `null` while it is closed, so a
   * mount-time default alone would be computed against no worktree and never revisited. Adjusting
   * state during render is the supported way to reset on a prop change, and is the same pattern
   * `WorktreesView` uses for its deep-linked selection.
   */
  const [scopedPath, setScopedPath] = useState(worktreePath);
  if (scopedPath !== worktreePath) {
    setScopedPath(worktreePath);
    setScope(defaultScope(worktree));
  }

  const scopeAnchors = useMemo(() => ({ baseBranch }), [baseBranch]);
  const diffTarget: DiffTarget = useMemo(
    () => scopeToDiffTarget(scope, scopeAnchors),
    [scope, scopeAnchors],
  );
  const allChangesTarget: DiffTarget = useMemo(
    () => scopeToDiffTarget({ type: "all" }, scopeAnchors),
    [scopeAnchors],
  );

  // App.tsx keeps every view mounted, so an ungated interval would re-fetch, re-parse and
  // re-render the whole diff every 10s for as long as the app runs — including while the user
  // is on another tab. Poll only while this view is on screen, then refetch on the way back in
  // so returning never shows a stale diff (same approach as WorktreesView's worktree list).
  const isViewActive = useActiveTab() === "worktrees";
  const diffPolling = { refetchInterval: isViewActive ? 10000 : (false as const) };

  const diffQuery = useWorktreeDiffQuery(projectId, worktreePath, diffTarget, diffPolling);
  const commitsQuery = useWorktreeCommitsQuery(projectId, worktreePath, baseBranch);
  const commits = commitsQuery.data || [];

  // The scope selector's two fixed rows describe scopes other than the one on screen, so their
  // counts come from their own `--stat` queries rather than from the diff being displayed.
  const uncommittedStats = useWorktreeDiffStatsQuery(
    projectId,
    worktreePath,
    { type: "Head" },
    diffPolling,
  );
  const allChangesStats = useWorktreeDiffStatsQuery(
    projectId,
    worktreePath,
    allChangesTarget,
    diffPolling,
  );
  const { refetch: refetchDiff } = diffQuery;
  const wasViewActiveRef = useRef(isViewActive);
  useEffect(() => {
    if (isViewActive && !wasViewActiveRef.current) void refetchDiff();
    wasViewActiveRef.current = isViewActive;
  }, [isViewActive, refetchDiff]);

  const diffText = diffQuery.data?.diff;
  // Read out of the optional chain first: an optional member expression in a dependency array is
  // opaque to the compiler and drops the memoization.
  const diffFiles = useMemo(() => (diffText ? parseDiffString(diffText) : []), [diffText]);
  const untrackedFiles = useMemo(() => diffQuery.data?.untracked_files ?? [], [diffQuery.data]);

  const { items, panelFiles, selectFile, selectedPath } = useReviewItems({
    diffFiles,
    untrackedFiles,
    search: fileSearch,
    selectedIndex: selectedFileIndex,
    stackRef,
  });

  if (worktree === null) return null;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* The gap below the bar belongs to the diff's inset, so it takes a matching one above
          rather than sitting high in its own band. */}
      <div className={cn("shrink-0 bg-card", panel.inset && "pt-2")}>
        <DiffActionBar
          centerLabel={worktree.branch_name}
          className="bg-card border-b-0"
          leadingSlot={
            <>
              <FilePanelToggle
                open={panel.panelOpen}
                onToggle={() => panel.setPanelOpen(!panel.panelOpen)}
              />
              <ScopeSelector
                selectedScope={scope}
                onScopeChange={setScope}
                commits={commits}
                uncommittedFileCount={fileCountFrom(uncommittedStats.data)}
                allChangesFileCount={fileCountFrom(allChangesStats.data)}
                isLoading={commitsQuery.isLoading}
              />
            </>
          }
          diffViewMode={diffViewMode}
          onDiffViewModeChange={setDiffViewMode}
          viewedCount={viewedFiles.size}
          totalFileCount={diffFiles.length + untrackedFiles.length}
          onClose={onClose}
        />
      </div>

      <ReviewLayout
        panel={panel}
        files={{
          files: panelFiles,
          selectedFile: selectedPath,
          onSelectFile: selectFile,
          viewedFiles,
          search: fileSearch,
          onSearchChange: setFileSearch,
        }}
      >
        <DiffFileStack
          ref={stackRef}
          items={items}
          projectId={projectId}
          cwd={worktreePath}
          diffTarget={diffTarget}
          diffViewMode={diffViewMode}
          selectedIndex={selectedFileIndex}
          onSelectedIndexChange={setSelectedFileIndex}
          viewedFiles={viewedFiles}
          onToggleViewed={toggleViewed}
          loading={diffQuery.isLoading}
          emptyMessage={
            diffQuery.error
              ? undefined
              : fileSearch.trim()
                ? "No files match"
                : "No changes in this scope"
          }
        />
      </ReviewLayout>
    </div>
  );
}
