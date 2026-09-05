import { describe, it, expect } from "vitest";
import type { BranchPullRequestInfo, PullRequestCheckInfo } from "@/types/bindings";
import { branchPullRequestPollInterval, burstKeyOf } from "./integration.service";

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
