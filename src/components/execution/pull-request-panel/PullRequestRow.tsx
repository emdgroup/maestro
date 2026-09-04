import {
  CircleCheck,
  CircleX,
  CornerDownRight,
  FileDiff,
  GitBranchPlus,
  GitPullRequest,
  LoaderCircle,
  Play,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils.ts";
import { usePullRequestDetail } from "@/services/integration.service";
import { CI_TONE, type CiRollup } from "@/components/execution/worktree-card/pullRequestCi";
import { relativeAge } from "@/components/execution/worktree-card/worktree-usage";
import type { PullRequestEntry } from "./pullRequestFilters";

const CI_ICON: Record<CiRollup, typeof CircleCheck | null> = {
  passing: CircleCheck,
  failing: CircleX,
  running: LoaderCircle,
  unknown: null,
};

/**
 * The button's words, and the longer version behind it.
 *
 * The label stays short and the same width across the three so the column does not reflow as
 * sessions come and go; which of the three it is, is what the icon and the tooltip say.
 */
function action(entry: PullRequestEntry): {
  label: string;
  hint: string;
  icon: typeof CornerDownRight;
} {
  switch (entry.action.kind) {
    case "open-session":
      return {
        label: "Go to session",
        hint: `Go to ${entry.action.sessionLabel}`,
        icon: CornerDownRight,
      };
    case "reuse-worktree":
      return {
        label: "Start session",
        hint: "Start a session in the existing worktree for this branch",
        icon: Play,
      };
    case "new-worktree":
      return {
        label: "Start session",
        hint: "Create a worktree for this branch and start a session",
        icon: GitBranchPlus,
      };
  }
}

interface PullRequestRowProps {
  entry: PullRequestEntry;
  projectId: number;
  ci: CiRollup;
  now: number;
  /** False while the view is off screen. */
  poll: boolean;
  onAct: (entry: PullRequestEntry) => void;
}

/**
 * One open pull request, in two lines.
 *
 * The branch pair is a tooltip rather than a line of its own. Maestro's own branches are
 * `maestro/<two words>-<n>`, and `head → base` for one of those is wider than the panel however it
 * is truncated — so it pushed the metrics beside it out of the row. It is also the thing on this
 * card a user reads once and then knows.
 *
 * The row itself does nothing on click: the action is a button, and a card that also acted would
 * make the button decorative and every stray click consequential.
 */
export function PullRequestRow({ entry, projectId, ci, now, poll, onAct }: PullRequestRowProps) {
  const { pullRequest } = entry;
  // Unpolled: this is one row of a list, and a 30-second timer per row is the per-pull-request cost
  // the batch checks query exists to avoid. Keyed on the head commit, so a push re-reads it once.
  const { data: facts } = usePullRequestDetail(
    projectId,
    pullRequest.number,
    pullRequest.head_sha,
    poll,
    false,
  );

  const age = relativeAge(pullRequest.created_at, now);
  const CiIcon = CI_ICON[ci];
  const { label, hint, icon: ActionIcon } = action(entry);

  const additions = facts?.additions ?? 0;
  const deletions = facts?.deletions ?? 0;

  // Separated by the same middot at the same opacity `WorktreeMetrics` uses two columns away: this
  // reads as one list of facts about the pull request, as that one does about a worktree. Absent
  // facts drop out rather than rendering as zeroes.
  const metrics = [
    // Added and removed lines are one metric, not two — they are the two halves of the diff's size,
    // and a middot between them read as though they measured different things.
    additions > 0 || deletions > 0 ? (
      <span key="diff" className="flex items-center gap-1.5 font-mono">
        {additions > 0 && <span className="text-success">+{additions}</span>}
        {deletions > 0 && <span className="text-destructive">−{deletions}</span>}
      </span>
    ) : null,
    facts?.changed_files != null ? (
      <span key="files" className="flex items-center gap-1 tabular-nums text-muted-foreground">
        <FileDiff className="size-3" />
        {facts.changed_files} {facts.changed_files === 1 ? "file" : "files"}
      </span>
    ) : null,
    // Only the icon carries the verdict's colour, and the word stays "CI" rather than "passed":
    // colouring the word made it read as the name of something that had passed, and the adjective
    // repeated the icon without ever saying what had passed. `unknown` has no icon, so it is the
    // one state that has to say it in words.
    <span key="ci" className="flex items-center gap-1 text-muted-foreground">
      {CiIcon && (
        <CiIcon className={cn("size-3", CI_TONE[ci], ci === "running" && "animate-spin")} />
      )}
      {ci === "unknown" ? "no checks" : "CI"}
    </span>,
  ].filter((metric) => metric != null);

  return (
    <div className="rounded-lg border bg-background p-2.5 transition-colors hover:border-ring/50">
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Open pull request #${pullRequest.number} on the forge`}
                onClick={() => void openUrl(pullRequest.url)}
              />
            }
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded font-mono text-xs text-accent underline decoration-dashed underline-offset-2 hover:decoration-solid"
          >
            <GitPullRequest className="size-3" />
            {pullRequest.number}
          </TooltipTrigger>
          <TooltipContent>Open on the forge</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={<span />}
            className="min-w-0 flex-1 cursor-default truncate text-xs font-medium"
          >
            {pullRequest.title}
          </TooltipTrigger>
          {/* What is merging where. It is on the title because that is the widest hover target in
              the row, and it is a tooltip because `head → base` for a Maestro branch is wider than
              the panel — which is what pushed the metrics out of the row when it had a line. */}
          <TooltipContent className="max-w-80 break-all font-mono">
            {pullRequest.head_branch}
            {pullRequest.base_branch ? ` → ${pullRequest.base_branch}` : ""}
          </TooltipContent>
        </Tooltip>

        {age && <span className="shrink-0 text-[10.5px] text-muted-foreground">{age}</span>}
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px]">
          {metrics.map((metric, index) => (
            <span key={index} className="flex items-center gap-2">
              {index > 0 && <span className="text-muted-foreground/40">·</span>}
              {metric}
            </span>
          ))}
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              // Accent border and text on no fill at all. `outline` was invisible because it fills
              // with `bg-background`, which is the card's own background; a solid fill was too loud
              // for something that repeats on every card. The colour is the whole signal.
              // `hover:text-accent` is not redundant: the ghost variant would otherwise drain the
              // accent back to `foreground` exactly when the cursor is on it.
              <Button
                variant="ghost"
                size="xs"
                className="h-6 shrink-0 gap-1 border border-accent px-2 text-[11px] text-accent hover:bg-accent/10 hover:text-accent"
                onClick={() => onAct(entry)}
              />
            }
          >
            <ActionIcon className="size-3" />
            {label}
          </TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
