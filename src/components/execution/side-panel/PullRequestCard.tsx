import {
  GitPullRequest,
  GitCommitVertical,
  Clock,
  TriangleAlert,
  CircleCheck,
  CircleX,
  LoaderCircle,
  ChevronRight,
  FileDiff,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils.ts";
import { openUrl } from "@tauri-apps/plugin-opener";
import { formatTimeAgoCompact, plural } from "@/lib/format-utils";
import { useTasksQuery } from "@/services/task.service";
import type { PullRequestCheckInfo } from "@/types/bindings";
import type { SessionShipState, SessionPullRequest } from "./useSessionShipState";
import { fixChecksPrompt } from "./shipActions";
import { Card, CardAction } from "./OverviewCard";

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
  const opened = created_at ? formatTimeAgoCompact(created_at) : null;

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
export function PullRequestCard({
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
