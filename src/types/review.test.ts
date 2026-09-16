import { describe, it, expect } from "vitest";
import { canApprove } from "@/types/review";

describe("canApprove", () => {
  it("allows the gate through the ordinary review phases", () => {
    expect(canApprove({ phase: "Approval", phase_status: "Waiting" })).toBe(true);
    expect(canApprove({ phase: "SelfReview", phase_status: "Running" })).toBe(true);
    expect(canApprove({ phase: null, phase_status: null })).toBe(true);
  });

  /**
   * The expensive one. Approving a conflicted pull request runs the merge, hits the conflict that
   * put the card in this state, and `reject_merge_on_conflict` drops the task to `InProgress`
   * while the pull request stays open — and `reconcile_pull_requests` only sweeps `AwaitingMerge`,
   * so nothing on the board tracks it again.
   */
  it("withholds it from a task whose pull request is already open", () => {
    expect(canApprove({ phase: "AwaitingMerge", phase_status: "Waiting" })).toBe(false);
    expect(canApprove({ phase: "AwaitingMerge", phase_status: "Running" })).toBe(false);
  });

  // A closed pull request has nothing left to orphan, and approving is how a new one gets opened.
  it("gives it back once the pull request is closed", () => {
    expect(canApprove({ phase: "AwaitingMerge", phase_status: "Failed" })).toBe(true);
  });
});
