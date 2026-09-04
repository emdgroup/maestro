import { describe, it, expect } from "vitest";
import type { PullRequestCheckInfo } from "@/types/bindings";
import { checksPollInterval } from "./integration.service";

function check(status: PullRequestCheckInfo["status"]): PullRequestCheckInfo {
  return { name: "build", status };
}

/**
 * The card's checks poll has two rates, and picking between them is the whole of this function.
 * Both directions are load-bearing: too slow and the user watches a stale rollup, too fast and a
 * finished pull request spends requests for the rest of the session confirming what it already
 * said.
 */
describe("checksPollInterval", () => {
  const live = checksPollInterval(undefined, 0);
  const settled = checksPollInterval([check("Passed")], 1);

  it("polls fast before the first answer arrives", () => {
    expect(live).toBeLessThan(settled);
  });

  /// A run in progress is the case the fast rate exists for — it is the half of the card that
  /// changes while the user is looking at it.
  it("polls fast while any check is still running", () => {
    expect(checksPollInterval([check("Running")], 99)).toBe(live);
    // Even beside a failure: `Running` outranks `Failed`, matching `deriveCi`, because a matrix
    // still going might yet turn green.
    expect(checksPollInterval([check("Failed"), check("Running")], 99)).toBe(live);
  });

  it("backs off once nothing is running", () => {
    expect(checksPollInterval([check("Passed")], 99)).toBe(settled);
    expect(checksPollInterval([check("Failed")], 99)).toBe(settled);
  });

  /// The window between opening a pull request and the forge queueing its first check. Reading it
  /// any slower is what made CI take a whole cycle to appear.
  it("treats the first few empty answers as CI that has not queued yet", () => {
    expect(checksPollInterval([], 0)).toBe(live);
    expect(checksPollInterval([], 5)).toBe(live);
  });

  /// The bug this function was extracted for. An empty list never satisfies "nothing is running"
  /// the way a finished one does, so without a bound it stayed at the fast rate forever — on a
  /// repository with no CI, or a forge that names no checks, for the life of the session.
  it("stops treating a permanently empty list as CI that is about to start", () => {
    expect(checksPollInterval([], 6)).toBe(settled);
    expect(checksPollInterval([], 600)).toBe(settled);
  });
});
