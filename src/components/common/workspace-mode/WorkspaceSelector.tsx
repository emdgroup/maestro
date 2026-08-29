import { Folder } from "lucide-react";
import { BranchPicker } from "@/components/kanban/shared/BranchPicker";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { useNow } from "@/hooks/useNow";
import type { WorkspaceMode, WorktreeWithStatus } from "@/types/bindings";
import { WorkspaceCard } from "./WorkspaceCard";
import { WorkspaceModeSelect } from "./WorkspaceModeSelect";

interface WorkspaceSelectorProps {
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  /** Only read in `NewWorktree` mode; the other two have no branch to pick. */
  baseBranch: string;
  onBaseBranchChange: (branch: string) => void;
  baseBranchError?: string;
  /** Every worktree of the project, repo root included — it is filtered out below. */
  worktrees: WorktreeWithStatus[];
  repoPath: string;
  selectedWorktreeId: number | null;
  onSelectedWorktreeChange: (worktree: WorktreeWithStatus | null) => void;
  /** False for terminal sessions, which attach to a checkout rather than creating one. */
  allowNewWorktree?: boolean;
  /**
   * True for a task, which takes ownership of the workspace it reuses so that everything asking
   * "where does this task work" keeps finding the answer through `worktrees.task_id`. A workspace
   * another task already owns is therefore shown but not selectable. A session claims nothing and
   * passes false, so it may sit in any worktree.
   */
  claimsOwnership?: boolean;
  /** The task doing the choosing, so its own workspace is not offered as taken. */
  ownerTaskId?: number | null;
  /** A task that can no longer be edited still has to show where it runs. */
  readOnly?: boolean;
}

export function WorkspaceSelector({
  mode,
  onModeChange,
  baseBranch,
  onBaseBranchChange,
  baseBranchError,
  worktrees,
  repoPath,
  selectedWorktreeId,
  onSelectedWorktreeChange,
  allowNewWorktree = true,
  claimsOwnership = false,
  ownerTaskId = null,
  readOnly = false,
}: WorkspaceSelectorProps) {
  // One ticker for the whole list rather than one per card, so the relative ages stay live without
  // a timer per row.
  const now = useNow();
  // The repo root is its own mode now, and a row still being created (empty path, no id yet) is
  // not something to offer.
  const reusable = worktrees.filter((wt) => wt.path !== repoPath && wt.id != null);
  const takenBy = (wt: WorktreeWithStatus) =>
    claimsOwnership && wt.task_id != null && wt.task_id !== ownerTaskId
      ? (wt.task_name ?? `task #${wt.task_id}`)
      : null;

  const selected = reusable.find((wt) => wt.id === selectedWorktreeId) ?? null;

  if (readOnly) {
    const summary =
      mode === "NewWorktree"
        ? `A new worktree from ${baseBranch || "the base branch"}`
        : mode === "RepositoryDirectory"
          ? "The repository directory"
          : (selected?.branch_name ?? "A workspace that no longer exists");
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground">
          WORKSPACE
        </span>
        <span className="flex items-center gap-1.5 rounded-full border border-border px-2.5 h-7 text-xs text-muted-foreground font-mono cursor-default w-fit">
          <Folder className="size-3 shrink-0" />
          {summary}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground">
        WORKSPACE
      </span>

      <WorkspaceModeSelect
        value={mode}
        onChange={onModeChange}
        allowNewWorktree={allowNewWorktree}
        unavailableReason="A terminal attaches to a checkout that already exists"
      />

      {mode === "NewWorktree" && (
        <div className="flex flex-col gap-1">
          <BranchPicker
            value={baseBranch}
            onChange={onBaseBranchChange}
            error={!!baseBranchError}
            prefix="From"
          />
          {baseBranchError && <span className="text-destructive text-xs">{baseBranchError}</span>}
        </div>
      )}

      {/* A dropdown rather than a list laid out in the dialog: a project accumulates worktrees,
          and however tall a list is capped at, it still spends that height when the mode is not
          even the one selected. The popup scrolls on its own. */}
      {mode === "ReuseWorkspace" &&
        (reusable.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            This project has no other worktree yet — create one first, or use the repository
            directory.
          </p>
        ) : (
          <Select
            value={selected ? String(selected.id) : ""}
            onValueChange={(value) =>
              onSelectedWorktreeChange(reusable.find((wt) => String(wt.id) === value) ?? null)
            }
          >
            <SelectTrigger
              aria-label="Workspace"
              className="w-full h-auto py-2 px-3 items-start gap-2 border-border bg-transparent shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
            >
              <span className="flex items-start gap-2 min-w-0 flex-1 text-left">
                <Folder className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                {selected ? (
                  <WorkspaceCard worktree={selected} now={now} compact />
                ) : (
                  <span className="text-sm text-muted-foreground">Select a workspace</span>
                )}
              </span>
            </SelectTrigger>
            <SelectContent>
              {reusable.map((wt) => {
                const taken = takenBy(wt);
                return (
                  <SelectItem
                    key={wt.id}
                    value={String(wt.id)}
                    disabled={taken !== null}
                    className="items-start py-2"
                  >
                    <span className="flex items-start gap-2 min-w-0 overflow-hidden">
                      <Folder className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                      <WorkspaceCard worktree={wt} now={now} takenBy={taken} />
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ))}
    </div>
  );
}
