import {
  Bot,
  SquarePlay,
  FileDiff,
  ScrollText,
  Paperclip,
  ExternalLink,
  GitCommitVertical,
  GitPullRequestCreate,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { openFileWithConnection } from "@/lib/file-opener";
import { formatBytes, formatTimeAgoCompact } from "@/lib/format-utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import type { TabKind } from "./useSidePanelTabs";
import type { ConnectionKey } from "@/types/bindings";
import type { PlanEntry, ToolCallItem } from "@/components/execution/activity/types";
import type { WorkingFileEntry } from "@/components/execution/agent-activity-panel/useWorkingFileTracker";
import { useTaskAttachmentsQuery } from "@/services/task.service";
import type { SessionShipState } from "./useSessionShipState";
import type { SessionDiffScope } from "./useSessionDiffStats";
import { BLOCKER_LABELS, commitAndPushPrompt } from "./shipActions";
import { OpenPullRequestDialog } from "./OpenPullRequestDialog";
import { Card, CardAction } from "./OverviewCard";
import { PullRequestCard } from "./PullRequestCard";

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
  /** How much of `changedFilesCount` is still outstanding. `null` before the first fetch settles. */
  uncommittedFilesCount?: number | null;
  /** Whether `changedFilesCount` is measured from the session's start commit or only from HEAD. */
  scope?: SessionDiffScope;
  /** `git diff` failed — show nothing rather than the zero a failed command would otherwise read as. */
  statsUnavailable?: boolean;
  connection: ConnectionKey;
  wslDistroName?: string;
  ship: SessionShipState;
  /** Puts text in the composer for the user to read and send. Absent when there is no live agent. */
  onSeedPrompt?: (text: string) => void;
}

/**
 * The Changes card's shipping affordance. At most one of the two is ever rendered — a branch with
 * something to push cannot also be ready for a pull request — so they are alternatives rather than
 * a pair, and the card never grows a row of buttons that contradict each other.
 *
 * A branch whose work has already merged gets neither, which is `action: "none"`.
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

  // The work has landed, so no row at all — rather than a passive "Merged in #336", which the pull
  // request card beside this one already says with its badge.
  if (ship.action === "none") return null;

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

/** How many artifact and attachment rows a card shows before it stops. */
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
  uncommittedFilesCount,
  scope = "session",
  statsUnavailable = false,
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

  // The headline counts everything since the session's start commit, so it does not move when the
  // agent commits. Subtracting what is still outstanding is what makes shipping visible on the card.
  //
  // The two numbers come from two independent `--stat` runs, so a file that was committed and then
  // edited again is counted once in each and the committed figure reads one low. Being exact would
  // mean a third `git diff <start>..HEAD` on every poll, which is not worth it for a summary line;
  // clamping keeps the arithmetic from ever going negative when the two polls land out of step.
  const showSplit =
    scope === "session" &&
    !statsUnavailable &&
    uncommittedFilesCount != null &&
    changedFilesCount > 0;
  const committedFilesCount = Math.max(0, changedFilesCount - (uncommittedFilesCount ?? 0));

  const changesSubtitle = statsUnavailable
    ? "Changes unavailable"
    : changedFilesCount === 0
      ? "No changes"
      : scope === "session"
        ? `${changedFilesCount} file${changedFilesCount !== 1 ? "s" : ""} since session start`
        : `${changedFilesCount} uncommitted file${changedFilesCount !== 1 ? "s" : ""}`;

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
    <div className="absolute inset-0 overflow-y-auto p-3">
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
          // Shown on failure too: a card that vanishes when `git diff` errors is indistinguishable
          // from a session that changed nothing, which is the confusion this card had.
          available={changedFilesCount > 0 || statsUnavailable}
          onClick={() => onNavigate("review")}
          icon={<FileDiff className="w-3.5 h-3.5 text-success" />}
          iconBg="bg-success/15"
          label="Changes"
          sub={changesSubtitle}
        >
          {changedFilesCount > 0 && !statsUnavailable && diffStats && (
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
              {showSplit && (
                <span className="text-[10.5px] text-muted-foreground tabular-nums">
                  {committedFilesCount} committed · {uncommittedFilesCount} uncommitted
                </span>
              )}
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
                            {formatTimeAgoCompact(addedAt)}
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
                          {formatBytes(att.file_size)}
                        </span>
                        <span className="text-[9px] text-muted-foreground/40 shrink-0 tabular-nums">
                          {formatTimeAgoCompact(att.created_at)}
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
