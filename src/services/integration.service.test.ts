import { describe, it, expect } from "vitest";
import type {
  BranchPullRequestInfo,
  PullRequestCheckInfo,
  PullRequestRowDetail,
} from "@/types/bindings";
import {
  branchPullRequestPollInterval,
  burstKeyOf,
  integrationQueryKeys,
  rowDetailPollInterval,
} from "./integration.service";

function pullRequest(overrides: Partial<BranchPullRequestInfo> = {}): BranchPullRequestInfo {
  return {
    number: 310,
    url: "https://github.com/o/r/pull/310",
    state: "Open",
    title: "Ship it",
    base_branch: "main",
    head_branch: "maestro/prime-bloom-65",
    head_sha: "deadbeef",
    created_at: "2026-09-05T09:00:00Z",
    commits: 3,
    changed_files: 7,
    additions: 120,
    deletions: 45,
    mergeable: true,
    checks: [],
    ...overrides,
  };
}

function check(status: PullRequestCheckInfo["status"]): PullRequestCheckInfo {
  return { name: "build", status };
}

/**
 * The card's whole cadence, in one function. Both directions are load-bearing: too slow and the
 * user watches a stale pull request, too fast and one that merged last week goes on costing a
 * request every half minute for the life of the session.
 */
describe("branchPullRequestPollInterval", () => {
  // Both are intervals rather than `false` by construction — the pull request here is open — so
  // narrowing once keeps the comparisons below readable.
  const steady = branchPullRequestPollInterval(pullRequest(), 0) as number;
  const burst = branchPullRequestPollInterval(pullRequest(), 5) as number;

  it("keeps looking while the branch has no pull request", () => {
    expect(branchPullRequestPollInterval(null, 0)).toBe(steady);
    // Before the first answer arrives. This is also how one opened on the forge is picked up.
    expect(branchPullRequestPollInterval(undefined, 0)).toBe(steady);
  });

  /// The seconds between opening a pull request and the forge queueing its first check — the delay
  /// the user actually complained about.
  it("bursts while a new pull request has no checks yet", () => {
    expect(burst).toBeLessThan(steady);
  });

  /// The bug the old rule had. An empty check list read as "CI has not started yet" with nothing
  /// bounding it, so a repository that simply has no CI polled at the fast rate forever.
  it("stops bursting once the tries are spent", () => {
    expect(branchPullRequestPollInterval(pullRequest(), 0)).toBe(steady);
  });

  /// The burst exists to catch CI appearing; once it has, there is nothing left to catch.
  it("stops bursting as soon as checks arrive", () => {
    expect(branchPullRequestPollInterval(pullRequest({ checks: [check("Running")] }), 5)).toBe(
      steady,
    );
  });

  /// Terminal on every forge here. Window focus is what re-arms this query, not a timer nobody is
  /// watching — and a merged pull request polled every 30s is the cost that buys nothing.
  it("stops entirely once the pull request has landed", () => {
    expect(branchPullRequestPollInterval(pullRequest({ state: "Merged" }), 0)).toBe(false);
    expect(branchPullRequestPollInterval(pullRequest({ state: "Closed" }), 0)).toBe(false);
    // Even mid-burst: a pull request cannot start CI after it has been merged.
    expect(branchPullRequestPollInterval(pullRequest({ state: "Merged" }), 5)).toBe(false);
  });
});

/**
 * What arms a burst. Getting this wrong in the permissive direction spends five requests every time
 * the user clicks into a session whose checks finished days ago.
 */
describe("burstKeyOf", () => {
  it("changes for a new pull request, which is how a freshly opened one starts a burst", () => {
    expect(burstKeyOf(pullRequest({ number: 311 }))).not.toBe(burstKeyOf(pullRequest()));
  });

  /// A push starts a fresh CI run, which is the same situation as opening one and happens more
  /// often inside a session.
  it("changes for a new head commit", () => {
    expect(burstKeyOf(pullRequest({ head_sha: "c0ffee" }))).not.toBe(burstKeyOf(pullRequest()));
  });

  it("is stable across a poll that changed nothing that matters", () => {
    expect(burstKeyOf(pullRequest({ title: "Renamed", additions: 999 }))).toBe(
      burstKeyOf(pullRequest()),
    );
  });

  it("is null before anything has been found", () => {
    expect(burstKeyOf(null)).toBeNull();
    expect(burstKeyOf(undefined)).toBeNull();
  });
});

/**
 * The rule that decides whether a row keeps costing requests.
 *
 * Everything else about a row is held against its key, so this is the *only* thing standing between
 * a page of thirty and thirty timers. It has to be false in every state but one.
 */
describe("rowDetailPollInterval", () => {
  const detail = (ci: PullRequestRowDetail["ci"]): PullRequestRowDetail => ({
    additions: 12,
    deletions: 3,
    changed_files: 2,
    ci,
  });

  /// A run in progress finishes without touching the number, the head commit or `updated_at` on
  /// some forges, so it is the one thing the key cannot notice and the one thing worth a timer.
  it("polls only while a run is still going", () => {
    expect(rowDetailPollInterval(detail("Running"))).toBeGreaterThan(0);
  });

  it("stops once the run has settled", () => {
    expect(rowDetailPollInterval(detail("Passing"))).toBe(false);
    expect(rowDetailPollInterval(detail("Failing"))).toBe(false);
  });

  /// A repository with no CI at all. Polling this would be a request every thirty seconds, per row,
  /// forever, to be told the same nothing — which is precisely the cost this design removed.
  it("never polls a row that has no CI", () => {
    expect(rowDetailPollInterval(detail("Unknown"))).toBe(false);
    expect(rowDetailPollInterval(undefined)).toBe(false);
  });
});

/**
 * What makes holding a row's detail safe.
 *
 * `staleTime: Infinity` is only correct because everything that can change the answer changes the
 * key. If one of these stopped being part of it the row would show its first answer until the user
 * hit refresh — and `updated_at` is the one that is easy to leave out and impossible to notice.
 */
describe("pullRequestRowDetail key", () => {
  const base = integrationQueryKeys.pullRequestRowDetail(
    1,
    310,
    "deadbeef",
    "2026-09-04T11:00:00Z",
  );

  it("changes when a push moves the head commit", () => {
    expect(
      integrationQueryKeys.pullRequestRowDetail(1, 310, "c0ffee", "2026-09-04T11:00:00Z"),
    ).not.toEqual(base);
  });

  /// A CI run starting or finishing moves neither the number nor the commit. Without this the row
  /// would never re-ask and would sit on "no checks" for the life of the page.
  it("changes when the forge touches the pull request without a new commit", () => {
    expect(
      integrationQueryKeys.pullRequestRowDetail(1, 310, "deadbeef", "2026-09-04T12:00:00Z"),
    ).not.toEqual(base);
  });

  it("changes for a different pull request and a different project", () => {
    expect(
      integrationQueryKeys.pullRequestRowDetail(1, 311, "deadbeef", "2026-09-04T11:00:00Z"),
    ).not.toEqual(base);
    expect(
      integrationQueryKeys.pullRequestRowDetail(2, 310, "deadbeef", "2026-09-04T11:00:00Z"),
    ).not.toEqual(base);
  });

  /// The refresh shortcut and the tab-focus effect invalidate by this prefix, so it has to actually
  /// be one — it is the only thing that re-reads a row on a forge that never bumps a timestamp.
  it("sits under a prefix a refresh can reach", () => {
    expect(base.slice(0, 3)).toEqual(integrationQueryKeys.pullRequestRowDetails(1));
  });
});
