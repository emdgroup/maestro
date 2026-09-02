import { useMemo, useState } from "react";
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  GitPullRequest,
  LoaderCircle,
  Search,
} from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { cn } from "@/lib/utils.ts";
import {
  CI_TONE,
  UNKNOWN_CI,
  type CiRollup,
  type CiStatus,
} from "@/components/execution/worktree-card/pullRequestCi";
import type { ActiveSessionInfo, ProjectPullRequest, WorktreeWithStatus } from "@/types/bindings";
import {
  countCiStates,
  filterPullRequests,
  LINK_FILTERS,
  pullRequestEntries,
  type LinkFilter,
  type PullRequestEntry,
} from "./pullRequestFilters";
import { PullRequestRow } from "./PullRequestRow";

/** The three states worth filtering on. `unknown` is not offered — it is the absence of an answer. */
const CI_FILTERS: Array<{ state: CiRollup; icon: typeof CircleCheck; label: string }> = [
  { state: "passing", icon: CircleCheck, label: "Passing" },
  { state: "failing", icon: CircleX, label: "Failing" },
  { state: "running", icon: LoaderCircle, label: "Running" },
];

/** Both dropdown triggers, so they sit at the same height as the search field beside them. */
const filterTriggerClass =
  "flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground";

interface PullRequestPanelProps {
  projectId: number;
  pullRequests: ProjectPullRequest[];
  worktrees: WorktreeWithStatus[];
  sessionsByPath: Map<string, ActiveSessionInfo[]>;
  ciByNumber: Map<number, CiStatus>;
  /** The project's push remote, which a new worktree is created from. */
  remote: string;
  now: number;
  poll: boolean;
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
  worktrees,
  sessionsByPath,
  ciByNumber,
  remote,
  now,
  poll,
  onAct,
}: PullRequestPanelProps) {
  const [search, setSearch] = useState("");
  const [linkFilter, setLinkFilter] = useState<LinkFilter>("All");
  const [ciStates, setCiStates] = useState<ReadonlySet<CiRollup>>(() => new Set());

  const entries = useMemo(
    () => pullRequestEntries(pullRequests, worktrees, sessionsByPath, remote),
    [pullRequests, worktrees, sessionsByPath, remote],
  );
  const counts = useMemo(() => countCiStates(entries, ciByNumber), [entries, ciByNumber]);
  const visible = useMemo(
    () => filterPullRequests(entries, search, linkFilter, ciStates, ciByNumber),
    [entries, search, linkFilter, ciStates, ciByNumber],
  );

  // Named when it says something, "CI" when it does not: with nothing selected the dropdown is not
  // filtering, and "All" would claim it was set to something.
  const ciLabel =
    ciStates.size === 0
      ? "CI"
      : ciStates.size === 1
        ? CI_FILTERS.find((filter) => ciStates.has(filter.state))!.label
        : `CI · ${ciStates.size}`;

  function toggleCi(state: CiRollup) {
    setCiStates((previous) => {
      const next = new Set(previous);
      if (!next.delete(state)) next.add(state);
      return next;
    });
  }

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
          {/* `shown/total` rather than a bare total: with a filter on, the count you want is how
              much of the list you are looking at, and the total alone silently disagrees with the
              number of cards below it. */}
          <span className="text-xs tabular-nums text-muted-foreground">
            {visible.length}/{entries.length}
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

          <DropdownMenu>
            <DropdownMenuTrigger className={filterTriggerClass} aria-label="Filter by CI state">
              {ciLabel}
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              {CI_FILTERS.map(({ state, icon: Icon, label }) => (
                <DropdownMenuCheckboxItem
                  key={state}
                  checked={ciStates.has(state)}
                  onCheckedChange={() => toggleCi(state)}
                  className="text-xs"
                >
                  <Icon className={cn("size-3", CI_TONE[state])} />
                  <span className="flex-1">{label}</span>
                  <span className="tabular-nums text-muted-foreground">{counts[state]}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <InputGroup className="ml-auto h-7 min-w-0 flex-1">
            <InputGroupInput
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="h-7 text-xs"
            />
            <InputGroupAddon align="inline-start">
              <Search className="text-muted-foreground" />
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>

      {/* Padded, with the cards spaced apart: each pull request is a thing you act on, the way a
          worktree card is, rather than a line in a table. */}
      <div className="flex-1 space-y-2 overflow-y-auto custom-scrollbar p-2">
        {visible.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {entries.length === 0
              ? "No open pull requests"
              : "No pull requests match these filters"}
          </p>
        ) : (
          visible.map((entry) => (
            <PullRequestRow
              key={entry.pullRequest.number}
              entry={entry}
              projectId={projectId}
              ci={ciByNumber.get(entry.pullRequest.number)?.rollup ?? UNKNOWN_CI.rollup}
              now={now}
              poll={poll}
              onAct={onAct}
            />
          ))
        )}
      </div>
    </div>
  );
}
