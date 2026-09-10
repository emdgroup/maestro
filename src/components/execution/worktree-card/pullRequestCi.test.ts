import { describe, it, expect } from "vitest";
import type { PullRequestCheckInfo } from "@/types/bindings";
import { rollupOfCi, summariseChecks } from "./pullRequestCi";

function check(name: string, status: PullRequestCheckInfo["status"]): PullRequestCheckInfo {
  return { name, status };
}

describe("summariseChecks", () => {
  /**
   * The opposite ranking to `summarise_checks` on the Rust side, on purpose. That one gates a fix
   * agent and must not act on a half-finished matrix; this one is a single colour, where a failure
   * already answers the only question it can ask.
   */
  it("lets a failure outrank a run still in progress", () => {
    expect(summariseChecks([check("build", "Failed"), check("e2e", "Running")]).rollup).toBe(
      "failing",
    );
  });

  /** The tooltip is the only place the user learns *what* broke — the icon is one colour. */
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

  /**
   * Gitea and Forgejo enumerate nothing, and a query that has not resolved has nothing either.
   * Both must read as "no answer" rather than as a green tick.
   */
  it("reports unknown for no checks and for no answer", () => {
    expect(summariseChecks([]).rollup).toBe("unknown");
    expect(summariseChecks(undefined).rollup).toBe("unknown");
  });
});

describe("rollupOfCi", () => {
  /**
   * Two spellings of one idea either side of the IPC boundary. The mapping is four lines in one
   * place precisely so a rename on the Rust side fails here rather than silently painting every
   * row grey — `CI_TONE` is keyed on the lower-case form and would just miss.
   */
  it("maps every verdict the backend can send", () => {
    expect(rollupOfCi("Passing")).toBe("passing");
    expect(rollupOfCi("Failing")).toBe("failing");
    expect(rollupOfCi("Running")).toBe("running");
    expect(rollupOfCi("Unknown")).toBe("unknown");
  });

  /**
   * A row whose detail has not arrived — or a forge that answers none — is "no answer", not a
   * green tick.
   */
  it("reads an absent verdict as unknown", () => {
    expect(rollupOfCi(undefined)).toBe("unknown");
  });
});
