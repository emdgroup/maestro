import { Check, FolderRoot, GitBranchPlus, GitFork, Repeat, TriangleAlert } from "lucide-react";
import { BranchPicker } from "@/components/kanban/shared/BranchPicker";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { cn } from "@/lib/utils";
import { MAESTRO_BRANCH_PREFIX, validateBranchSuffix } from "@/lib/generateSessionName";
import type { BranchMode, WorktreeWithStatus } from "@/types/bindings";
import { findBranchConflict, type BranchConflict } from "./branch-conflict";

const MODES: { value: BranchMode; label: string; description: string }[] = [
  {
    value: "Create",
    label: "Create a new branch",
    description: "from the branch you pick",
  },
  {
    value: "Checkout",
    label: "Check out an existing branch",
    description: "the worktree sits on it as it is",
  },
];

/** The word in front of the branch, which is also the control that changes it. */
const CHIP_LABEL: Record<BranchMode, string> = { Create: "From", Checkout: "On" };

export interface NewWorktreeFieldsProps {
  branchMode: BranchMode;
  onBranchModeChange: (mode: BranchMode) => void;
  branch: string;
  onBranchChange: (branch: string) => void;
  branchError?: string;
  /** `Create` only: the part after `maestro/`. Empty means "use the generated name". */
  branchSuffix: string;
  onBranchSuffixChange: (suffix: string) => void;
  /**
   * What the name will be if the field is left alone, shown as its placeholder. A task's is only
   * known once the task has an id, so this is a preview rather than the value that gets submitted.
   */
  generatedSuffix: string;
  /** Every worktree of the project, repo root included — used to find who holds a branch. */
  worktrees: WorktreeWithStatus[];
  repoPath: string;
  /**
   * Offered as a quick action when the chosen branch is already checked out. Its absence is how a
   * caller says it has no workspace to fall back to — the Workspaces view creates worktrees and
   * has no mode select to switch — so the alert then offers only "create a branch from it".
   */
  onUseExistingWorkspace?: (conflict: BranchConflict) => void;
  /** Why `onUseExistingWorkspace` is not on offer for this particular conflict, if it is not. */
  useExistingBlockedReason?: (conflict: BranchConflict) => string | null;
}

/**
 * Everything under "create a new worktree": which branch, and — when creating one — what to call it.
 *
 * Shared by the task modal, the session dialog and the Workspaces view, so all three ask the same
 * question the same way. The mode switch is the `From`/`On` chip inside the picker rather than a
 * control of its own: the row then reads as a sentence, and the locked `maestro/` addon on the name
 * row lines up underneath it.
 */
export function NewWorktreeFields({
  branchMode,
  onBranchModeChange,
  branch,
  onBranchChange,
  branchError,
  branchSuffix,
  onBranchSuffixChange,
  generatedSuffix,
  worktrees,
  repoPath,
  onUseExistingWorkspace,
  useExistingBlockedReason,
}: NewWorktreeFieldsProps) {
  const creating = branchMode === "Create";
  const suffixError = creating ? validateBranchSuffix(branchSuffix) : null;

  // Only checkout can collide: creating a branch makes a new ref, which no worktree can be on.
  const conflict = creating ? null : findBranchConflict(branch, worktrees, repoPath);
  const blockedReason = conflict ? (useExistingBlockedReason?.(conflict) ?? null) : null;
  const canUseExisting =
    conflict !== null && onUseExistingWorkspace != null && blockedReason == null;

  const chip = (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={
          creating
            ? "Creating a new branch from the branch below. Activate to check out an existing branch instead."
            : "Checking out the branch below. Activate to create a new branch instead."
        }
        className="flex items-center gap-1.5 shrink-0 border-r border-border px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer focus-visible:outline-none focus-visible:bg-muted data-popup-open:bg-muted data-popup-open:text-foreground"
      >
        {CHIP_LABEL[branchMode]}
        <Repeat className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      {/* The content defaults to the trigger's width, and the trigger is a two-letter chip. */}
      <DropdownMenuContent className="w-64">
        {MODES.map((mode) => (
          <DropdownMenuItem
            key={mode.value}
            onClick={() => onBranchModeChange(mode.value)}
            className="items-start gap-2 py-2"
          >
            {mode.value === "Create" ? (
              <GitBranchPlus className="size-3.5 shrink-0 text-muted-foreground mt-px" />
            ) : (
              <GitFork className="size-3.5 shrink-0 text-muted-foreground mt-px" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{mode.label}</span>
              <span className="block text-xs text-muted-foreground">{mode.description}</span>
            </span>
            {branchMode === mode.value && <Check className="size-3.5 shrink-0 mt-px" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <BranchPicker
          value={branch}
          onChange={onBranchChange}
          error={!!branchError || conflict !== null}
          prefixControl={chip}
          unavailable={
            creating
              ? undefined
              : (candidate) => {
                  const held = findBranchConflict(candidate, worktrees, repoPath);
                  if (!held) return null;
                  return held.kind === "repositoryDirectory"
                    ? "in use — your project directory"
                    : `in use — ${folderName(held.worktree.path)}`;
                }
          }
        />
        {branchError && <span className="text-destructive text-xs">{branchError}</span>}
      </div>

      {creating && (
        <div className="flex flex-col gap-1">
          <InputGroup className={cn(suffixError && "border-destructive")}>
            <InputGroupAddon
              align="inline-start"
              className="font-mono text-xs border-r border-border bg-muted/60 h-full rounded-l-md px-2.5"
            >
              {MAESTRO_BRANCH_PREFIX}
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Branch name"
              className="font-mono text-xs"
              placeholder={generatedSuffix}
              value={branchSuffix}
              onChange={(e) => onBranchSuffixChange(e.target.value)}
            />
          </InputGroup>
          {suffixError && <span className="text-destructive text-xs">{suffixError}</span>}
        </div>
      )}

      {conflict && (
        <div className="flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed">
          <TriangleAlert className="size-4 shrink-0 text-warning mt-px" />
          <div className="flex flex-col gap-2 min-w-0">
            <span>
              {conflict.kind === "repositoryDirectory" ? (
                <>
                  <span className="font-mono">{branch}</span> is the branch your project directory
                  is on.
                </>
              ) : (
                <>
                  <span className="font-mono">{branch}</span> is already checked out in{" "}
                  <span className="font-mono">{folderName(conflict.worktree.path)}</span>. Git
                  allows one worktree per branch.
                </>
              )}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {canUseExisting && (
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => onUseExistingWorkspace?.(conflict)}
                >
                  {conflict.kind === "repositoryDirectory" ? (
                    <FolderRoot className="size-3.5" />
                  ) : (
                    <GitFork className="size-3.5" />
                  )}
                  {conflict.kind === "repositoryDirectory"
                    ? "Work in the repository directory"
                    : "Use that workspace"}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => onBranchModeChange("Create")}
              >
                <GitBranchPlus className="size-3.5" />
                Create a branch from it
              </Button>
            </div>
            {blockedReason && <span className="text-muted-foreground">{blockedReason}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The last path segment — what the user sees on disk and in the Workspaces view. */
function folderName(path: string): string {
  const segments = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] || path;
}
