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
  X,
} from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { openFileWithConnection } from "@/lib/file-opener";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import type { TabKind } from "./useSidePanelTabs";
import type { BranchPullRequestInfo, ConnectionKey } from "@/types/bindings";
import type { PlanEntry, ToolCallItem } from "@/components/execution/activity/types";
import type { WorkingFileEntry } from "@/components/execution/agent-activity-panel/useWorkingFileTracker";
import { useTaskAttachmentsQuery, useTasksQuery } from "@/services/task.service";
import type { SessionShipState } from "./useSessionShipState";
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
          onOpened={(url) => void openUrl(url)}
        />
      )}
    </div>
  );
}

const CI_LABELS: Record<NonNullable<BranchPullRequestInfo["ci"]>, string> = {
  Passing: "checks passed",
  Failing: "CI failing",
  Pending: "checks running",
};

const CI_TONES: Record<NonNullable<BranchPullRequestInfo["ci"]>, string> = {
  Passing: "text-success",
  Failing: "text-destructive",
  Pending: "text-muted-foreground",
};

const STATE_BADGES: Record<BranchPullRequestInfo["state"], { label: string; tone: string }> = {
  Open: { label: "Open", tone: "bg-success/15 text-success" },
  Merged: { label: "Merged", tone: "bg-[--purple]/15 text-[--purple]" },
  Closed: { label: "Closed", tone: "bg-destructive/15 text-destructive" },
};

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

  return (
    <Card
      available
      onClick={() => void openUrl(pullRequest.url)}
      icon={<GitPullRequest className="w-3.5 h-3.5 text-success" />}
      iconBg="bg-success/15"
      label={`Pull request #${pullRequest.number}`}
      sub={isOpen && ci ? CI_LABELS[ci] : pullRequest.title}
      badge={badge.label}
      badgeClass={badge.tone}
    >
      {isOpen && (
        <div className="flex flex-col gap-1.5">
          {ci && (
            <span className={cn("text-[10.5px]", CI_TONES[ci])}>
              {pullRequest.failing_checks.length > 0
                ? pullRequest.failing_checks.join(", ")
                : CI_LABELS[ci]}
            </span>
          )}
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
  badge?: string;
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
