import { GitPullRequest } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils.ts";
import type { ProjectPullRequest } from "@/types/bindings";
import { CI_TONE, type CiStatus } from "./pullRequestCi";

interface WorktreePullRequestChipProps {
  pullRequest: ProjectPullRequest;
  /** Resolved once for the whole view. See `usePullRequestCi`. */
  ci: CiStatus;
}

/**
 * The worktree's open pull request, as one chip in the metrics row.
 *
 * The icon is the CI indicator — colouring the glyph rather than adding a dot beside it, because
 * the row already runs to six segments on a 288px card. There is no state pill either: only open
 * pull requests are listed, so it would read "Open" on every card that has one.
 *
 * Built like `WorktreeSyncActions`' chips because it sits beside them: a ghost button that keeps its
 * own tone on hover and stops the click from reaching the card, whose handler would open the diff
 * panel instead of the browser.
 */
export function WorktreePullRequestChip({ pullRequest, ci }: WorktreePullRequestChipProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Pull request #${pullRequest.number}`}
            onClick={(e) => {
              e.stopPropagation();
              void openUrl(pullRequest.url);
            }}
            className={cn(
              "h-4 cursor-pointer gap-0.5 rounded px-1 font-mono text-xs",
              // The ghost variant's `hover:text-foreground` would drain the CI colour out of the
              // icon exactly when the user is pointing at it, which is the one moment it matters.
              CI_TONE[ci.rollup],
              "bg-transparent group-hover:border-border group-hover:bg-muted",
              "hover:border-accent hover:bg-muted",
            )}
          />
        }
      >
        <GitPullRequest className="size-3" />
        {pullRequest.number}
      </TooltipTrigger>
      <TooltipContent>
        <span className="block max-w-64 truncate">{pullRequest.title}</span>
        <span className="block text-muted-foreground">{ci.label}</span>
      </TooltipContent>
    </Tooltip>
  );
}
