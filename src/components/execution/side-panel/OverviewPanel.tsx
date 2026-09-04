import {
  ChevronRight,
  Bot,
  SquarePlay,
  FileDiff,
  ScrollText,
  Paperclip,
  ExternalLink,
  GitCommitVertical,
  GitPullRequestCreate,
  GitPullRequest,
  Clock,
  TriangleAlert,
  CircleCheck,
  CircleX,
  LoaderCircle,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { openFileWithConnection } from "@/lib/file-opener";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import type { TabKind } from "./useSidePanelTabs";
import type { ConnectionKey, PullRequestCheckInfo } from "@/types/bindings";
import type { PlanEntry, ToolCallItem } from "@/components/execution/activity/types";
import type { WorkingFileEntry } from "@/components/execution/agent-activity-panel/useWorkingFileTracker";
import { useTaskAttachmentsQuery, useTasksQuery } from "@/services/task.service";
import type { SessionShipState, SessionPullRequest } from "./useSessionShipState";
import { BLOCKER_LABELS, commitAndPushPrompt, fixChecksPrompt } from "./shipActions";
import { OpenPullRequestDialog } from "./OpenPullRequestDialog";

interface OverviewPanelProps {
  subagentItems: ToolCallItem[];
  canvasCount: number;
  changedFilesCount: number;
  planEntries?: PlanEntry[] | null;
  planTitle?: string | null;
  planReviewState?: "waiting" | "accepted" | "rejected" | null;
  workingFiles?: WorkingFileEntry[];
  taskId: number | null;
  onNavigate: (kind: TabKind, filePath?: string) => void;
  diffStats?: { insertions: number; deletions: number } | null;
  connection: ConnectionKey;
  wslDistroName?: string;
  ship: SessionShipState;
  /** Puts text in the composer for the user to read and send. Absent when there is no live agent. */
  onSeedPrompt?: (text: string) => void;
}

/**
 * An action inside a card, which is itself a button that navigates.
 *
 * `stopPropagation` is not defensive here: without it every click would also open the Changes tab
 * behind the dialog. The Artifacts rows below solve the same problem the same way.
 */
function CardAction({
  icon: Icon,
  label,
  hint,
  variant,
  disabled,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  hint?: string;
  /** `seed` asks the agent and is borderless; `direct` acts itself and carries a border. */
  variant: "seed" | "direct";
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex items-center gap-2 w-full text-[11px] text-left rounded-md transition-colors",
        variant === "seed"
          ? "px-1.5 py-1 -mx-1.5 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground"
          : "px-2.5 py-1.5 border border-border bg-background enabled:hover:bg-muted",
        disabled && "opacity-40 cursor-default",
      )}
    >
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="truncate">{label}</span>
      {hint && <span className="ml-auto text-[9.5px] opacity-70 flex-shrink-0">{hint}</span>}
    </button>
  );
}

/**
 * The Changes card's shipping affordance. Exactly one of the two is ever rendered — a branch with
 * something to push cannot also be ready for a pull request — so they are alternatives rather than
 * a pair, and the card never grows a row of buttons that contradict each other.
 */
function ShipAction({
  ship,
  onSeedPrompt,
  onOpenDialog,
}: {
  ship: SessionShipState;
  onSeedPrompt?: (text: string) => void;
  onOpenDialog: () => void;
}) {
  const hint = ship.blocker ? BLOCKER_LABELS[ship.blocker] : undefined;

  if (ship.action === "commit-push") {
    // With no agent to ask there is nothing this button could do, so it is not offered at all.
    if (!onSeedPrompt) return null;
    return (
      <div className="mt-2.5 pt-2 border-t border-border/50">
        <CardAction
          icon={GitCommitVertical}
          label="Commit and push"
          hint={hint ?? "asks the agent"}
          variant="seed"
          disabled={!!ship.blocker}
          onClick={() => onSeedPrompt(commitAndPushPrompt(ship.branch))}
        />
      </div>
    );
  }

  return (
    <div className="mt-2.5 pt-2 border-t border-border/50">
      <CardAction
        icon={GitPullRequestCreate}
        label="Open pull request"
        hint={hint}
        variant="direct"
        disabled={!!ship.blocker}
        onClick={onOpenDialog}
      />
    </div>
  );
}

function ProgressBar({ pct, className }: { pct: number; className: string }) {
  return (
    <div className="h-[3px] rounded-full bg-muted overflow-hidden">
      <div className={cn("h-full rounded-full", className)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function PipRow({ items }: { items: ToolCallItem[] }) {
  const done = items.filter((s) => s.status === "completed").length;
  const pct = items.length > 0 ? Math.round((done / items.length) * 100) : 0;
  return (
    <div className="flex items-center gap-1">
      {items.map((item) => (
        <span
          key={item.toolCallId}
          className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", {
            "bg-success": item.status === "completed",
            "bg-accent animate-pulse": item.status === "in_progress" || item.status === "pending",
            "bg-destructive": item.status === "error" || item.status === "interrupted",
          })}
        />
      ))}
      <span className="text-[10px] text-muted-foreground ml-auto">{pct}%</span>
    </div>
  );
}

// Takes an absolute timestamp and reads the clock itself, so the panel body stays
// pure. These labels are minute-granular and the panel does not tick, so rows
// resolving the clock a few milliseconds apart is not observable.
function timeAgo(at: number): string {
  const m = Math.floor((Date.now() - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_ROWS = 5;

export function OverviewPanel({
  subagentItems,
  canvasCount,
  changedFilesCount,
  planEntries,
  planTitle,
  planReviewState,
  workingFiles,
  taskId,
  onNavigate,
  diffStats,
  connection,
  wslDistroName,
  ship,
  onSeedPrompt,
}: OverviewPanelProps) {
  const [errorPaths, setErrorPaths] = useState<Set<string>>(new Set());
  const [pullRequestDialogOpen, setPullRequestDialogOpen] = useState(false);
  const { data: attachments } = useTaskAttachmentsQuery(taskId);

  function handleRowOpen(path: string) {
    void openFileWithConnection(connection, path, {
      wslDistroName,
      sshConnectionId: connection.type === "ssh" ? connection.id : undefined,
    }).catch(() => {
      setErrorPaths((prev) => new Set([...prev, path]));
      setTimeout(
        () =>
          setErrorPaths((prev) => {
            const s = new Set(prev);
            s.delete(path);
            return s;
          }),
        2000,
      );
    });
  }

  const doneAgents = subagentItems.filter((s) => s.status === "completed").length;
  const agentPct =
    subagentItems.length > 0 ? Math.round((doneAgents / subagentItems.length) * 100) : 0;

  const donePlanSteps = planEntries?.filter((e) => e.status === "completed").length ?? 0;
  const totalPlanSteps = planEntries?.length ?? 0;
  const planPct = totalPlanSteps > 0 ? Math.round((donePlanSteps / totalPlanSteps) * 100) : 0;

  const totalDiff = (diffStats?.insertions ?? 0) + (diffStats?.deletions ?? 0);
  const insPct = totalDiff > 0 ? Math.round(((diffStats?.insertions ?? 0) / totalDiff) * 100) : 0;

  const agentFiles = workingFiles ?? [];
  const userFiles = attachments ?? [];
  const totalArtifacts = agentFiles.length + userFiles.length;
  const hasArtifacts = totalArtifacts > 0;
  const showSectionHeaders = agentFiles.length > 0 && userFiles.length > 0;

  const visibleAgentFiles = agentFiles.slice(-MAX_ROWS);
  const extraAgentFiles = agentFiles.length - MAX_ROWS;
  const visibleUserFiles = userFiles.slice(0, MAX_ROWS);
  const extraUserFiles = userFiles.length - MAX_ROWS;

  return (
    <div className="absolute inset-0 overflow-y-auto custom-scrollbar p-3">
      <div className="[column-count:2] [column-width:268px] gap-2">
        {/* Plan */}
        <Card
          available={(planEntries?.length ?? 0) > 0 || !!planTitle || !!planReviewState}
          onClick={() => onNavigate("plan")}
          icon={<ScrollText className="w-3.5 h-3.5 text-warning" />}
          iconBg="bg-warning/15"
          label="Plan"
          sub={
            totalPlanSteps === 0
              ? (planTitle ?? "Approved")
              : `${donePlanSteps} of ${totalPlanSteps} step${totalPlanSteps !== 1 ? "s" : ""} complete`
          }
          badge={
            planReviewState === "waiting"
              ? "Pending"
              : planReviewState === "accepted"
                ? "Accepted"
                : planReviewState === "rejected"
                  ? "Rejected"
                  : totalPlanSteps > 0
                    ? `${planPct}%`
                    : undefined
          }
          badgeClass={
            planReviewState === "waiting"
              ? "bg-warning/15 text-warning"
              : planReviewState === "accepted"
                ? "bg-success/15 text-success"
                : planReviewState === "rejected"
                  ? "bg-destructive/15 text-destructive"
                  : "bg-warning/15 text-warning"
          }
        >
          {planEntries && planEntries.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {planEntries.map((entry, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div
                    className={cn(
                      "mt-0.5 w-3 h-3 rounded-[3px] flex-shrink-0 flex items-center justify-center",
                      entry.status === "completed" ? "bg-success/15" : "border border-border",
                    )}
                  >
                    {entry.status === "completed" && (
                      <svg
                        viewBox="0 0 24 24"
                        className="w-2 h-2 stroke-success fill-none stroke-[3]"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-[10.5px] leading-snug",
                      entry.status === "completed"
                        ? "text-muted-foreground/50 line-through decoration-border"
                        : "text-muted-foreground",
                    )}
                  >
                    {entry.content}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Changes */}
        <Card
          available={changedFilesCount > 0}
          onClick={() => onNavigate("review")}
          icon={<FileDiff className="w-3.5 h-3.5 text-success" />}
          iconBg="bg-success/15"
          label="Changes"
          sub={
            changedFilesCount === 0
              ? "No changes"
              : `${changedFilesCount} file${changedFilesCount !== 1 ? "s" : ""} modified`
          }
        >
          {changedFilesCount > 0 && diffStats && (
            <div className="flex flex-col gap-1.5">
              <div className="h-1 rounded-full overflow-hidden flex gap-px">
                <div className="bg-success rounded-l-full" style={{ width: `${insPct}%` }} />
                <div
                  className="bg-destructive rounded-r-full"
                  style={{ width: `${100 - insPct}%` }}
                />
              </div>
              <div className="flex justify-between">
                <span
                  className="text-[10.5px] tabular-nums"
                  style={{ color: "var(--diff-add-fg)" }}
                >
                  +{diffStats.insertions} insertions
                </span>
                <span
                  className="text-[10.5px] tabular-nums"
                  style={{ color: "var(--diff-del-fg)" }}
                >
                  −{diffStats.deletions} deletions
                </span>
              </div>
            </div>
          )}
          <ShipAction
            ship={ship}
            onSeedPrompt={onSeedPrompt}
            onOpenDialog={() => setPullRequestDialogOpen(true)}
          />
        </Card>

        <PullRequestCard ship={ship} taskId={taskId} onSeedPrompt={onSeedPrompt} />

        {/* Canvas */}
        <Card
          available={canvasCount > 0}
          onClick={() => onNavigate("canvas")}
          icon={<SquarePlay className="w-3.5 h-3.5 text-[--purple]" />}
          iconBg="bg-[--purple]/15"
          label="Canvas"
          sub={canvasCount === 0 ? "None" : `${canvasCount} surface${canvasCount !== 1 ? "s" : ""}`}
          badge={canvasCount > 0 ? String(canvasCount) : undefined}
          badgeClass="bg-[--purple]/15 text-[--purple]"
        />

        {/* Artifacts */}
        <Card
          available={hasArtifacts}
          onClick={() => onNavigate("artifacts")}
          icon={<Paperclip className="w-3.5 h-3.5 text-muted-foreground" />}
          iconBg="bg-muted"
          label="Artifacts"
          sub={
            totalArtifacts === 0
              ? "None"
              : `${totalArtifacts} file${totalArtifacts !== 1 ? "s" : ""}`
          }
          badge={totalArtifacts > 0 ? String(totalArtifacts) : undefined}
          badgeClass="bg-muted text-muted-foreground"
        >
          {hasArtifacts && (
            <div className="flex flex-col gap-2">
              {/* Agent-generated files */}
              {agentFiles.length > 0 && (
                <div>
                  {showSectionHeaders && (
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/40 mb-1.5">
                      Agent Generated
                    </p>
                  )}
                  <div className="flex flex-col gap-1">
                    {visibleAgentFiles.map(({ path, addedAt }) => {
                      const parts = path.split("/");
                      const name = parts[parts.length - 1] ?? path;
                      return (
                        <div key={path} className="flex items-center gap-2 min-w-0 group">
                          <Tooltip>
                            <TooltipTrigger
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onNavigate("artifacts", path);
                              }}
                              className="text-[10px] font-mono text-muted-foreground hover:text-foreground hover:underline truncate text-left flex-1 min-w-0"
                            >
                              {name}
                            </TooltipTrigger>
                            <TooltipContent>{path}</TooltipContent>
                          </Tooltip>
                          <span className="text-[9px] text-muted-foreground/40 shrink-0 tabular-nums">
                            {timeAgo(addedAt)}
                          </span>
                          <Tooltip>
                            <TooltipTrigger
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRowOpen(path);
                              }}
                              className={cn(
                                "opacity-0 group-hover:opacity-100 p-0.5 rounded transition-opacity shrink-0",
                                errorPaths.has(path)
                                  ? "text-destructive opacity-100"
                                  : "text-muted-foreground/50 hover:text-foreground",
                              )}
                            >
                              {errorPaths.has(path) ? (
                                <X className="w-2.5 h-2.5" />
                              ) : (
                                <ExternalLink className="w-2.5 h-2.5" />
                              )}
                            </TooltipTrigger>
                            <TooltipContent>
                              {errorPaths.has(path)
                                ? "Failed to open"
                                : "Open in default application"}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      );
                    })}
                  </div>
                  {extraAgentFiles > 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigate("artifacts");
                      }}
                      className="mt-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground"
                    >
                      + {extraAgentFiles} others
                    </button>
                  )}
                </div>
              )}

              {/* User-uploaded files */}
              {userFiles.length > 0 && (
                <div>
                  {showSectionHeaders && (
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/40 mb-1.5">
                      User Uploaded
                    </p>
                  )}
                  <div className="flex flex-col gap-1">
                    {visibleUserFiles.map((att) => (
                      <div key={att.id} className="flex items-baseline gap-2 min-w-0">
                        <Tooltip>
                          <TooltipTrigger
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onNavigate("artifacts", att.file_path);
                            }}
                            className="text-[10px] font-mono text-muted-foreground hover:text-foreground hover:underline truncate text-left flex-1 min-w-0"
                          >
                            {att.filename}
                          </TooltipTrigger>
                          <TooltipContent>{att.file_path}</TooltipContent>
                        </Tooltip>
                        <span className="text-[9px] text-muted-foreground/40 shrink-0 tabular-nums">
                          {fmtSize(att.file_size)}
                        </span>
                        <span className="text-[9px] text-muted-foreground/40 shrink-0 tabular-nums">
                          {timeAgo(new Date(att.created_at).getTime())}
                        </span>
                      </div>
                    ))}
                  </div>
                  {extraUserFiles > 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigate("artifacts");
                      }}
                      className="mt-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground"
                    >
                      + {extraUserFiles} others
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Subagents */}
        <Card
          available={subagentItems.length > 0}
          onClick={() => onNavigate("subagents")}
          icon={<Bot className="w-3.5 h-3.5 text-accent" />}
          iconBg="bg-accent/15"
          label="Subagents"
          sub={
            subagentItems.length === 0
              ? "None"
              : `${doneAgents} done · ${subagentItems.filter((s) => s.status === "in_progress" || s.status === "pending").length} running`
          }
          badge={subagentItems.length > 0 ? `${doneAgents} / ${subagentItems.length}` : undefined}
          badgeClass="bg-accent/15 text-accent"
        >
          {subagentItems.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <ProgressBar pct={agentPct} className="bg-accent" />
              <PipRow items={subagentItems} />
            </div>
          )}
        </Card>
      </div>

      {ship.projectId != null && ship.branch && (
        <OpenPullRequestDialog
          open={pullRequestDialogOpen}
          onOpenChange={setPullRequestDialogOpen}
          projectId={ship.projectId}
          branch={ship.branch}
          baseBranch={ship.baseBranch}
          concurrentSessions={ship.concurrentSessions}
          lastCommitSubject={ship.lastCommitSubject}
          onOpened={(url) => void openUrl(url)}
        />
      )}
    </div>
  );
}

const CI_LABELS: Record<NonNullable<SessionPullRequest["ci"]>, string> = {
  Passing: "checks passed",
  Failing: "CI failing",
  Pending: "checks running",
};

const CI_TONES: Record<NonNullable<SessionPullRequest["ci"]>, string> = {
  Passing: "text-success",
  Failing: "text-destructive",
  Pending: "text-muted-foreground",
};

const STATE_BADGES: Record<SessionPullRequest["state"], { label: string; tone: string }> = {
  Open: { label: "Open", tone: "bg-success/15 text-success" },
  Merged: { label: "Merged", tone: "bg-[--purple]/15 text-[--purple]" },
  Closed: { label: "Closed", tone: "bg-destructive/15 text-destructive" },
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * What is merging where, for the card's subtitle.
 *
 * `head → base` rather than a sentence: the branch names are the content, and wrapping them in
 * "into" and "from" spends the column's width on words that are the same on every card.
 *
 * `null` when the forge named neither branch, which is when the caller falls back to the number —
 * a subtitle reading " → " would be worse than no subtitle at all.
 */
export function branchSummary(pullRequest: SessionPullRequest): string | null {
  const { base_branch, head_branch, commits } = pullRequest;
  if (!base_branch || !head_branch) return null;
  const arrow = `${head_branch} → ${base_branch}`;
  return commits != null ? `${arrow} · ${plural(commits, "commit")}` : arrow;
}

/**
 * How big the pull request is and how long it has been open, in the metrics row's vocabulary.
 *
 * Deliberately built the same way as `WorktreeMetrics`, which sits two cards away in the Worktrees
 * view: icon then mono value, middot separators at low opacity, the same green and red. A pull
 * request and a worktree describe the same work, and reading them differently was the complaint.
 *
 * Every metric is dropped when it has nothing to say, so GitLab — which reports no line counts on
 * the merge request — renders a shorter row rather than "0 files +0 −0".
 */
export function PullRequestFacts({ pullRequest }: { pullRequest: SessionPullRequest }) {
  const { changed_files, additions, deletions, created_at, mergeable, base_branch } = pullRequest;
  const opened = created_at ? timeAgo(Date.parse(created_at)) : null;

  // Size before age: how big the change is decides whether it is worth opening, and how long it
  // has been sitting there only matters once you know that.
  const metrics: React.ReactNode[] = [];
  if (changed_files != null) {
    metrics.push(
      // Count and noun in one text node: as separate flex children the row's `gap` landed between
      // them, so "23 files" read as "23  files" — wider than the gap either side of the icon. The
      // digits are `tabular-nums` rather than `font-mono`, which would put a second typeface on the
      // number and leave it sitting off the baseline of the word beside it.
      <span key="files" className="flex items-center gap-1 text-muted-foreground">
        <FileDiff className="size-3" />
        <span className="tabular-nums">
          {changed_files} {changed_files === 1 ? "file" : "files"}
        </span>
      </span>,
    );
  }
  if (additions != null || deletions != null) {
    metrics.push(
      <span key="diff" className="flex items-center gap-1.5 font-mono">
        {additions != null && <span className="text-success">+{additions}</span>}
        {deletions != null && <span className="text-destructive">−{deletions}</span>}
      </span>,
    );
  }
  if (opened) {
    metrics.push(
      <span key="age" className="flex items-center gap-1 text-muted-foreground">
        <Clock className="size-3" />
        {opened}
      </span>,
    );
  }

  if (metrics.length === 0 && mergeable !== false) return null;

  return (
    <div className="flex flex-col gap-1">
      {metrics.length > 0 && (
        <span className="flex items-center gap-2 text-[11px] flex-wrap">
          {metrics.map((metric, index) => (
            <span key={index} className="flex items-center gap-2">
              {index > 0 && <span className="text-muted-foreground/40">·</span>}
              {metric}
            </span>
          ))}
        </span>
      )}
      {/* Only a positive answer. `null` is the forge still computing the merge commit, and a
          conflict warning shown on every freshly pushed branch would be ignored by the third one. */}
      {mergeable === false && (
        <span className="flex items-center gap-1 text-[10.5px] text-warning">
          <TriangleAlert className="size-3" />
          Conflicts with {base_branch ?? "the base"}
        </span>
      )}
    </div>
  );
}

/** Radius of the ring in its own 36-unit viewBox, and the circumference that follows from it. */
const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const CHECK_TONES: Record<PullRequestCheckInfo["status"], string> = {
  Passed: "text-success",
  Failed: "text-destructive",
  Running: "text-warning",
};

const CHECK_ICONS: Record<PullRequestCheckInfo["status"], React.ElementType> = {
  Passed: CircleCheck,
  Failed: CircleX,
  Running: LoaderCircle,
};

/** Failures first, then what is still running, then the green ones. */
const CHECK_ORDER: Record<PullRequestCheckInfo["status"], number> = {
  Failed: 0,
  Running: 1,
  Passed: 2,
};

/**
 * One arc per check, each coloured by that check's own state.
 *
 * A single arc could only show progress, which loses the thing the user is actually watching for:
 * *which* of the running jobs turned red. Equal segments mean the ring reads as "six jobs, one of
 * them failed" at a glance, whatever order the forge returned them in.
 *
 * The gap between segments shrinks as segments do, and disappears entirely below the width where
 * it would eat more of the arc than it separates — a twenty-job matrix draws a solid ring rather
 * than a dotted one.
 */
function CheckRing({ checks }: { checks: PullRequestCheckInfo[] }) {
  const segment = RING_CIRCUMFERENCE / checks.length;
  const gap = checks.length > 1 ? Math.min(1.5, segment * 0.25) : 0;
  const drawn = Math.max(segment - gap, 0.5);

  return (
    <svg viewBox="0 0 36 36" className="w-7 h-7 flex-shrink-0" aria-hidden>
      <circle
        cx="18"
        cy="18"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="4"
        className="stroke-muted"
      />
      {checks.map((check, index) => (
        <circle
          key={`${check.name}-${index}`}
          cx="18"
          cy="18"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="4"
          strokeLinecap="butt"
          stroke="currentColor"
          className={cn(CHECK_TONES[check.status], check.status === "Running" && "animate-pulse")}
          strokeDasharray={`${drawn} ${RING_CIRCUMFERENCE - drawn}`}
          // Negative offset walks the dash forward around the circle; the rotation puts segment
          // zero at twelve o'clock rather than at three.
          strokeDashoffset={-index * segment}
          transform="rotate(-90 18 18)"
        />
      ))}
    </svg>
  );
}

/**
 * Check progress as a ring, the way the forge's own merge box shows it.
 *
 * The arc is what has *finished*, not what has passed: a run with one failure and three still going
 * is a quarter done, and colouring the whole ring red the moment one job fails would claim a verdict
 * the run has not reached. Its colour carries the verdict instead — red once anything has failed,
 * amber while anything is still going, green only when everything is in and passing.
 *
 * Failing checks are named underneath. Running and passing ones are not: the name of a job that is
 * still going tells the user nothing they can act on, whereas the name of a red one is the whole
 * question. The forge is one click away for the rest.
 *
 * Falls back to the bare verdict when the forge would not enumerate — Gitea and Forgejo return no
 * checks at all, and a ring drawn at zero of zero would claim a run that does not exist.
 */
export function CheckRollup({
  checks,
  ci,
}: {
  checks: PullRequestCheckInfo[];
  ci: NonNullable<SessionPullRequest["ci"]>;
}) {
  const failedCount = checks.filter((check) => check.status === "Failed").length;
  // Open on a failure rather than waiting to be asked. Everything else is progress the ring
  // already conveys, but a red check is the one thing on this card that needs a decision, and
  // hiding that behind a click is how it gets missed. Declared before the early return below so
  // the hook order does not depend on whether the forge answered.
  const [expanded, setExpanded] = useState(failedCount > 0);

  if (checks.length === 0) {
    return <span className={cn("text-[10.5px]", CI_TONES[ci])}>{CI_LABELS[ci]}</span>;
  }

  const passed = checks.filter((check) => check.status === "Passed").length;
  const failed = checks.filter((check) => check.status === "Failed").length;
  const running = checks.filter((check) => check.status === "Running").length;
  const done = passed + failed;
  const total = checks.length;

  const tone = failed > 0 ? "text-destructive" : running > 0 ? "text-warning" : "text-success";

  const headline =
    running === 0 && failed === 0
      ? `All ${total} check${total === 1 ? "" : "s"} passed`
      : `${done} of ${total} checks done`;

  const counts = [
    failed > 0 ? `${failed} failing` : null,
    running > 0 ? `${running} running` : null,
  ].filter((part): part is string => part !== null);

  const ordered = [...checks].sort(
    (a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status] || a.name.localeCompare(b.name),
  );

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={(e) => {
          // The whole card opens the forge; this toggle must not.
          e.stopPropagation();
          setExpanded((open) => !open);
        }}
        className="flex items-center gap-2.5 w-full text-left rounded-md px-1 -mx-1 py-0.5 hover:bg-muted/60 transition-colors"
      >
        <CheckRing checks={ordered} />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] tabular-nums">{headline}</span>
          {counts.length > 0 && (
            <span className={cn("block text-[10px] tabular-nums", tone)}>{counts.join(" · ")}</span>
          )}
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 text-muted-foreground/40 flex-shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <div className="flex flex-col gap-1 pl-1">
          {ordered.map((check, index) => {
            const Icon = CHECK_ICONS[check.status];
            return (
              <div key={`${check.name}-${index}`} className="flex items-center gap-2 min-w-0">
                <Icon
                  className={cn(
                    "size-3.5 flex-shrink-0",
                    CHECK_TONES[check.status],
                    check.status === "Running" && "animate-spin",
                  )}
                />
                <span data-testid="check-name" className="text-[10.5px] truncate">
                  {check.name}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * What the forge says about the branch this session is on.
 *
 * Nothing here is stored — it is a live read keyed on the branch — so the card appears for a pull
 * request opened on the forge by hand just as readily as for one Maestro opened, and disappears
 * when the branch stops having one. Clicking it goes to the forge rather than to a tab: the checks,
 * the discussion and the diff are all rendered better there than they would be in this column.
 */
function PullRequestCard({
  ship,
  taskId,
  onSeedPrompt,
}: {
  ship: SessionShipState;
  taskId: number | null;
  onSeedPrompt?: (text: string) => void;
}) {
  const pullRequest = ship.pullRequest;
  // Only a task carries fix rounds — they are spent by the pipeline's CI-fix agent, which no
  // task-less session has. The list is already in cache from the board.
  const { data: tasks } = useTasksQuery(taskId != null ? ship.projectId : null);
  const task = taskId != null ? tasks?.find((entry) => entry.id === taskId) : undefined;

  if (!pullRequest) return null;

  const badge = STATE_BADGES[pullRequest.state];
  const ci = pullRequest.ci;
  const isOpen = pullRequest.state === "Open";
  const subtitle = branchSummary(pullRequest) ?? `#${pullRequest.number}`;

  return (
    <Card
      available
      onClick={() => void openUrl(pullRequest.url)}
      icon={<GitPullRequest className="w-3.5 h-3.5 text-success" />}
      iconBg="bg-success/15"
      // Title in the primary slot: it is the one thing on this card the number cannot say, and it
      // is what the user recognises the pull request by. The number rides in the state pill.
      label={pullRequest.title}
      sub={subtitle}
      badge={
        <>
          {badge.label} <span className="opacity-60">#{pullRequest.number}</span>
        </>
      }
      badgeClass={badge.tone}
    >
      {isOpen && (
        <div className="flex flex-col gap-1.5">
          <PullRequestFacts pullRequest={pullRequest} />
          {ci && <CheckRollup checks={pullRequest.checks} ci={ci} />}
          {task &&
            task.fix_rounds > 0 && (
              // The cap lives in Rust as `FIX_ROUND_CAP` and is not in the bindings, so the count is
              // shown without it rather than duplicating the number here where it could drift. That
              // the pipeline has given up is read from the ball instead, which is what matters.
              <span className="text-[10.5px] text-muted-foreground tabular-nums">
                CI fix round {task.fix_rounds}
                {task.ball === "User" && " — auto-fix stopped, over to you"}
              </span>
            )}
          {ci === "Failing" && onSeedPrompt && (
            <div className="mt-1 pt-2 border-t border-border/50">
              <CardAction
                icon={GitCommitVertical}
                label="Send failing checks to the agent"
                hint="asks the agent"
                variant="seed"
                onClick={() => onSeedPrompt(fixChecksPrompt(pullRequest))}
              />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Card({
  available,
  onClick,
  icon,
  iconBg,
  label,
  sub,
  badge,
  badgeClass,
  children,
}: {
  available: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  sub: string;
  /** A node rather than a string so a badge can carry two tones — see the pull request card. */
  badge?: React.ReactNode;
  badgeClass?: string;
  children?: React.ReactNode;
}) {
  if (!available) return null;
  return (
    <div className="w-full mb-2 break-inside-avoid">
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => e.key === "Enter" && onClick()}
        className="rounded-lg border border-border/50 bg-card overflow-hidden cursor-pointer hover:bg-muted/50 hover:border-border transition-colors"
      >
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <div
            className={cn(
              "w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0",
              iconBg,
            )}
          >
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-foreground">{label}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</div>
          </div>
          {badge && (
            <span
              className={cn(
                "text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0",
                badgeClass,
              )}
            >
              {badge}
            </span>
          )}
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0" />
        </div>
        {children && (
          <div className="px-3 pb-3 pt-0 border-t border-border/30">
            <div className="pt-2">{children}</div>
          </div>
        )}
      </div>
    </div>
  );
}
