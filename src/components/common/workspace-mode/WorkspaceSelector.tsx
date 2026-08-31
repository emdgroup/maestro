import { Folder } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { useNow } from "@/hooks/useNow";
import { MAESTRO_BRANCH_PREFIX } from "@/lib/generateSessionName";
import type { BranchMode, WorkspaceMode, WorktreeWithStatus } from "@/types/bindings";
import { WorkspaceCard } from "./WorkspaceCard";
import { WorkspaceModeSelect } from "./WorkspaceModeSelect";
import { NewWorktreeFields } from "./NewWorktreeFields";

interface WorkspaceSelectorProps {
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  /** Only read in `NewWorktree` mode; the other two have no branch to pick. */
  baseBranch: string;
  onBaseBranchChange: (branch: string) => void;
  baseBranchError?: string;
  /** Whether `NewWorktree` creates a branch or checks the picked one out. */
  branchMode: BranchMode;
  onBranchModeChange: (mode: BranchMode) => void;
  /** `Create` only: the part after `maestro/`. Empty means "use the generated name". */
  branchSuffix: string;
  onBranchSuffixChange: (suffix: string) => void;
  /** What that name will be if the field is left alone. */
  generatedBranchSuffix: string;
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
  branchMode,
  onBranchModeChange,
  branchSuffix,
  onBranchSuffixChange,
  generatedBranchSuffix,
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
        ? branchMode === "Checkout"
          ? `A worktree on ${baseBranch || "the branch below"}`
          : `A new branch ${MAESTRO_BRANCH_PREFIX}${branchSuffix || generatedBranchSuffix} from ${baseBranch || "the base branch"}`
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
        hasReusableWorkspace={reusable.length > 0}
        unavailableReason={{
          NewWorktree: "A terminal attaches to a checkout that already exists",
          ReuseWorkspace: "This project has no other worktree yet",
        }}
      />

      {mode === "NewWorktree" && (
        <NewWorktreeFields
          branchMode={branchMode}
          onBranchModeChange={onBranchModeChange}
          branch={baseBranch}
          onBranchChange={onBaseBranchChange}
          branchError={baseBranchError}
          branchSuffix={branchSuffix}
          onBranchSuffixChange={onBranchSuffixChange}
          generatedSuffix={generatedBranchSuffix}
          worktrees={worktrees}
          repoPath={repoPath}
          // A branch already checked out somewhere is a workspace that already exists, so the way
          // out is the mode this component is here to offer. The repository root is its own mode
          // rather than one of the reusable workspaces, which is why the two map differently.
          onUseExistingWorkspace={(conflict) => {
            if (conflict.kind === "repositoryDirectory") {
              onModeChange("RepositoryDirectory");
              return;
            }
            onSelectedWorktreeChange(conflict.worktree);
            onModeChange("ReuseWorkspace");
          }}
          useExistingBlockedReason={(conflict) => {
            if (conflict.kind === "repositoryDirectory") return null;
            if (conflict.worktree.id == null) {
              return "That worktree is not one Maestro tracks, so it cannot be reused here.";
            }
            const taken = takenBy(conflict.worktree);
            return taken ? `That workspace belongs to the task “${taken}”.` : null;
          }}
        />
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
            {/* See `WorkspaceModeSelect` on why the height override carries the size variant. */}
            <SelectTrigger
              aria-label="Workspace"
              className="w-full data-[size=default]:h-auto py-2 px-3 gap-2 border-border bg-transparent shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
            >
              <span className="flex items-center gap-2 min-w-0 flex-1 text-left">
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
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
                    className="py-2"
                  >
                    <span className="flex items-center gap-2 min-w-0 overflow-hidden">
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
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
