import { describe, it, expect } from "vitest";
import type { ProjectPullRequest, PullRequestCheckInfo } from "@/types/bindings";
import { pullRequestsByBranch, summariseChecks } from "./pullRequestCi";

function check(name: string, status: PullRequestCheckInfo["status"]): PullRequestCheckInfo {
  return { name, status };
}

describe("summariseChecks", () => {
  /// The opposite ranking to `summarise_checks` on the Rust side, on purpose. That one gates a fix
  /// agent and must not act on a half-finished matrix; this one is a single colour, where a failure
  /// already answers the only question it can ask.
  it("lets a failure outrank a run still in progress", () => {
    expect(summariseChecks([check("build", "Failed"), check("e2e", "Running")]).rollup).toBe(
      "failing",
    );
  });

  /// The tooltip is the only place the user learns *what* broke — the icon is one colour.
  it("names the failing checks in the label", () => {
    expect(summariseChecks([check("build", "Failed"), check("e2e", "Failed")]).label).toBe(
      "Failing: build, e2e",
    );
  });

  it("reports running only while nothing has failed", () => {
    expect(summariseChecks([check("build", "Passed"), check("e2e", "Running")]).rollup).toBe(
      "running",
    );
  });

  it("reports passing when every check has passed", () => {
    expect(summariseChecks([check("build", "Passed"), check("e2e", "Passed")]).rollup).toBe(
      "passing",
    );
  });

  /// Gitea and Forgejo enumerate nothing, and a query that has not resolved has nothing either.
  /// Both must read as "no answer" rather than as a green tick.
  it("reports unknown for no checks and for no answer", () => {
    expect(summariseChecks([]).rollup).toBe("unknown");
    expect(summariseChecks(undefined).rollup).toBe("unknown");
  });
});

describe("pullRequestsByBranch", () => {
  function pullRequest(number: number, head: string): ProjectPullRequest {
    return {
      number,
      url: `https://example.com/pull/${number}`,
      title: `Pull request ${number}`,
      head_branch: head,
      base_branch: "main",
      created_at: null,
      head_sha: null,
    };
  }

  it("keys open pull requests by their head branch", () => {
    const map = pullRequestsByBranch([
      pullRequest(310, "feature-a"),
      pullRequest(311, "feature-b"),
    ]);
    expect(map.get("feature-a")?.number).toBe(310);
    expect(map.get("feature-b")?.number).toBe(311);
    expect(map.get("nothing")).toBeUndefined();
  });

  /// The list arrives most-recently-updated first, so the first entry for a branch is the live one.
  /// Letting a later duplicate overwrite it would put the staler pull request on the card.
  it("keeps the first of two pull requests on one branch", () => {
    const map = pullRequestsByBranch([
      pullRequest(311, "feature-a"),
      pullRequest(310, "feature-a"),
    ]);
    expect(map.get("feature-a")?.number).toBe(311);
  });
});
