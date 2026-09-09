import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, GitPullRequest, Search } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Button } from "@/ui/button";
import type { ActiveSessionInfo, ProjectPullRequest, WorktreeWithStatus } from "@/types/bindings";
import {
  filterPullRequests,
  LINK_FILTERS,
  pullRequestEntries,
  type LinkFilter,
  type PullRequestEntry,
} from "./pullRequestFilters";
import { PullRequestRow } from "./PullRequestRow";

/** The dropdown trigger, so it sits at the same height as the search field beside it. */
const filterTriggerClass =
  "flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground";

interface PullRequestPanelProps {
  projectId: number;
  /** One page of them, not the project's list — see `useProjectPullRequestPage`. */
  pullRequests: ProjectPullRequest[];
  /** How many are open in total, where the forge says so. `null` means it would not. */
  total: number | null;
  worktrees: WorktreeWithStatus[];
  sessionsByPath: Map<string, ActiveSessionInfo[]>;
  /** The project's push remote, which a new worktree is created from. */
  remote: string;
  now: number;
  poll: boolean;
  /** Hidden where the forge cannot search — see `forge_searches_pull_requests`. */
  canSearch: boolean;
  /**
   * Whether a pull request from a fork can be put into a worktree here — see
   * `forge_checks_out_fork_pull_requests`. False on Azure DevOps, whose fork rows then offer their
   * reason instead of an action.
   */
  canCheckOutForks: boolean;
  search: string;
  onSearchChange: (search: string) => void;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onAct: (entry: PullRequestEntry) => void;
}

/**
 * Every pull request open on the project, beside the worktree grid.
 *
 * Beside rather than below because the two lists answer each other: the pull requests without a
 * worktree are the ones worth acting on, and they are only obviously that when the worktrees are on
 * screen at the same time.
 */
export function PullRequestPanel({
  projectId,
  pullRequests,
  total,
  worktrees,
  sessionsByPath,
  remote,
  now,
  poll,
  canSearch,
  canCheckOutForks,
  search,
  onSearchChange,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onAct,
}: PullRequestPanelProps) {
  const [linkFilter, setLinkFilter] = useState<LinkFilter>("All");

  const entries = useMemo(
    () => pullRequestEntries(pullRequests, worktrees, sessionsByPath, remote, canCheckOutForks),
    [pullRequests, worktrees, sessionsByPath, remote, canCheckOutForks],
  );
  const visible = useMemo(() => filterPullRequests(entries, linkFilter), [entries, linkFilter]);

  return (
    // No top border: the column runs out from under the action bar as one surface, which is the
    // whole point of the inset, rounded grid beside it. The header inside does keep its bottom
    // border — that one separates the filters from the list, not the panel from the view.
    // Width comes from the resizable panel that owns this, so there is none here.
    <div className="flex h-full flex-col overflow-hidden bg-card">
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <GitPullRequest className="size-3.5 text-muted-foreground" />
          <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Open pull requests
          </span>
          {/* What is on screen against what the project has, which on a large repository is the
              difference between 30 and 11,943. The old `shown/total` counted the same page twice
              and read as "you are seeing all of them" on every project big enough for it to
              matter. A forge that will not give a total gets a bare count rather than a made-up
              denominator. */}
          <span className="text-xs tabular-nums text-muted-foreground">
            {total != null ? `${visible.length} of ${total.toLocaleString()}` : visible.length}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={filterTriggerClass}
              aria-label="Filter by whether a worktree exists"
            >
              {LINK_FILTERS.find((filter) => filter.value === linkFilter)!.label}
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuRadioGroup
                value={linkFilter}
                onValueChange={(value) => setLinkFilter(value as LinkFilter)}
              >
                {LINK_FILTERS.map(({ value, label }) => (
                  <DropdownMenuRadioItem key={value} value={value} className="text-xs">
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Absent rather than disabled where the forge cannot search. Gitea, Forgejo and Azure
              DevOps have no pull request text search at all, and a box that quietly filtered the
              thirty rows on screen would mean the project on three providers and this page on the
              other three. */}
          {canSearch && (
            <InputGroup className="ml-auto h-7 min-w-0 flex-1">
              <InputGroupInput
                type="text"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search all pull requests..."
                className="h-7 text-xs"
              />
              <InputGroupAddon align="inline-start">
                <Search className="text-muted-foreground" />
              </InputGroupAddon>
            </InputGroup>
          )}
        </div>
      </div>

      {/* Padded, with the cards spaced apart: each pull request is a thing you act on, the way a
          worktree card is, rather than a line in a table. */}
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {search
              ? "No pull requests match that search"
              : entries.length === 0
                ? "No open pull requests"
                : "No pull requests on this page have a worktree to match"}
          </p>
        ) : (
          visible.map((entry) => (
            <PullRequestRow
              key={entry.pullRequest.number}
              entry={entry}
              projectId={projectId}
              now={now}
              poll={poll}
              onAct={onAct}
            />
          ))
        )}
      </div>

      {/* Only once there is somewhere to go. On the overwhelming majority of projects every open
          pull request fits on one page, and a pager with both arrows dead is furniture. */}
      {(hasPrevious || hasNext) && (
        <div className="flex shrink-0 items-center justify-end gap-1 border-t p-2">
          <Button
            variant="ghost"
            size="xs"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={!hasPrevious}
            onClick={onPrevious}
          >
            <ChevronLeft className="size-3" />
            Previous
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={!hasNext}
            onClick={onNext}
          >
            Next
            <ChevronRight className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
