import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { integrationQueryKeys } from "@/services/integration.service";
import { api } from "@/lib/tauri-utils";
import type { ProjectPullRequest, PullRequestCheckInfo } from "@/types/bindings";

/** What a pull request's checks add up to, as one mark. */
export type CiRollup = "passing" | "failing" | "running" | "unknown";

export interface CiStatus {
  rollup: CiRollup;
  /** Tooltip text: the verdict, or the failing check names when there are any. */
  label: string;
}

/**
 * Colour for the pull request icon itself, which is the indicator.
 *
 * There is no separate dot: the metrics row is already six segments wide on a 288px card, and a
 * mark whose only job is to be one of three colours can be the glyph that is already there.
 */
export const CI_TONE: Record<CiRollup, string> = {
  passing: "text-success",
  failing: "text-destructive",
  running: "text-warning",
  unknown: "text-muted-foreground",
};

const CI_LABEL: Record<CiRollup, string> = {
  passing: "All checks passed",
  failing: "Checks failing",
  running: "Checks running",
  unknown: "No checks reported",
};

export const UNKNOWN_CI: CiStatus = { rollup: "unknown", label: CI_LABEL.unknown };

/**
 * The verdict for a single coloured indicator.
 *
 * A failure outranks a run still in progress here, which is the opposite of `summarise_checks` on
 * the Rust side — and deliberately so. That one decides whether to start a fix agent, where acting
 * on a half-finished matrix would be wrong. This one has a single mark and no room for "3 of 4
 * done", so the only question it can answer is whether anything is broken, and a check that has
 * already failed answers it whatever the rest of the matrix is still doing.
 */
export function summariseChecks(checks: PullRequestCheckInfo[] | undefined): CiStatus {
  if (!checks || checks.length === 0) return UNKNOWN_CI;

  const failing = checks.filter((check) => check.status === "Failed").map((check) => check.name);
  if (failing.length > 0) return { rollup: "failing", label: `Failing: ${failing.join(", ")}` };

  const rollup = checks.some((check) => check.status === "Running") ? "running" : "passing";
  return { rollup, label: CI_LABEL[rollup] };
}

/**
 * Every listed pull request's CI state, keyed by number.
 *
 * One owner for the whole view, rather than a hook per card and per row. The panel's CI filter has
 * to count states across the entire list, which it cannot do from data held one row at a time — a
 * filter that hides a row cannot then read that row's state — and the card chips want the same
 * answer for the pull requests they happen to be showing.
 *
 * One request for the whole list, not one per pull request. Asked per pull request through
 * `useQueries` this was two GitHub requests each per cycle, so twenty open pull requests spent
 * roughly a token's whole hourly budget on a view that was only drawing coloured icons. The backend
 * asks the forge for all of them at once.
 *
 * The key carries every pull request's head sha, so a push re-asks rather than serving the previous
 * commit's result, and the poll is unconditional rather than stopping once everything has settled:
 * a forge can queue a check run under a head sha whose other runs have all finished, and at one
 * request per cycle there is nothing to save by going quiet.
 */
export function usePullRequestCi(
  projectId: number | null,
  pullRequests: ProjectPullRequest[],
  enabled: boolean,
): Map<number, CiStatus> {
  const heads = pullRequests.map((entry) => `${entry.number}:${entry.head_sha ?? ""}`).join(",");
  const { data } = useQuery({
    queryKey: integrationQueryKeys.projectPullRequestChecks(projectId ?? -1, heads),
    queryFn: () => api.fetchProjectPullRequestChecks(projectId!),
    enabled: enabled && projectId != null && pullRequests.length > 0,
    refetchInterval: 15_000,
    // Long enough that switching back to the tab reuses the answer rather than re-asking, short
    // enough that it is never the reason a mark is stale — the interval above owns freshness.
    staleTime: 10_000,
    retry: false,
  });

  return useMemo(
    () => new Map((data ?? []).map((entry) => [entry.number, summariseChecks(entry.checks)])),
    [data],
  );
}

/**
 * The open pull request for each branch that has one.
 *
 * Built once in the view and handed down, rather than each card searching the list itself: the map
 * is rebuilt only when the forge answers, where a per-card `find` would run on every render.
 *
 * A branch with more than one open pull request keeps the first the forge listed, which is the most
 * recently updated — the same tie-break `pick_branch_pull_request` makes on the Rust side.
 */
export function pullRequestsByBranch(
  pullRequests: ProjectPullRequest[],
): Map<string, ProjectPullRequest> {
  const byBranch = new Map<string, ProjectPullRequest>();
  for (const pullRequest of pullRequests) {
    if (!byBranch.has(pullRequest.head_branch)) {
      byBranch.set(pullRequest.head_branch, pullRequest);
    }
  }
  return byBranch;
}
