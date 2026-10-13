import { describe, expect, it } from "vitest";
import type { LoopSummary, Task } from "@/types/bindings";
import {
  gateLine,
  loopLine,
  NEEDS_YOU_RING,
  parseDuration,
  formatDuration,
  pathsInCommand,
  showsCheckBar,
} from "./loop-state";

const summary = (overrides: Partial<LoopSummary> = {}): LoopSummary => ({
  iteration: 6,
  counted: 5,
  agent_secs: 3840,
  no_change: 0,
  last_summary: "Moving relationships.rs behind ListTaskRelationships",
  checks: ["Pass", "Pass", "Fail", "Pending"],
  proposals: 0,
  ...overrides,
});

function loop(overrides: Partial<Task> = {}): Task {
  return {
    id: 142,
    project_id: 1,
    title: "Port task commands",
    status: "InProgress",
    priority: "High",
    base_branch: "main",
    skills: [],
    labels: [],
    created_at: "2026-10-13T09:00:00Z",
    updated_at: "2026-10-13T09:00:00Z",
    auto_approve: false,
    workspace_mode: "NewWorktree",
    phase: "Iterating",
    phase_status: "Running",
    ball: "Agent",
    run_mode: "Loop",
    loop_config: {
      max_iterations: 12,
      max_agent_secs: 10800,
      stall_limit: 2,
      check_timeout_secs: 600,
      sealed_paths: [],
    },
    loop_summary: summary(),
    ...overrides,
  } as Task;
}

describe("loopLine", () => {
  it("counts the running iteration against the budget and shows its last words", () => {
    expect(loopLine(loop())).toEqual({
      label: "Iteration 6/12",
      detail: "Moving relationships.rs behind ListTaskRelationships",
      tone: "brand",
    });
  });

  it("says a pause is coming before it lands", () => {
    const line = loopLine(loop({ loop_summary: summary({ hold: "Paused" }) }));
    expect(line?.detail).toBe("pausing after this one");
  });

  it("names why a halted loop waits on the user, and only the urgent ones glow", () => {
    const stalled = loopLine(
      loop({ phase_status: "Waiting", ball: "User", loop_summary: summary({ halt: "Stalled" }) }),
    );
    expect(stalled?.label).toBe("Stalled, needs your answer");
    expect(stalled?.ring).toBe(NEEDS_YOU_RING);

    const flaky = loopLine(
      loop({ phase_status: "Failed", ball: "User", loop_summary: summary({ halt: "Flaky" }) }),
    );
    expect(flaky?.label).toBe("Flaky check, needs you");

    const paused = loopLine(
      loop({ phase_status: "Waiting", ball: "User", loop_summary: summary({ halt: "Paused" }) }),
    );
    expect(paused).toMatchObject({ label: "Paused", ring: undefined });
  });

  it("waits for a slot between iterations, numbered from the counted ones", () => {
    expect(loopLine(loop({ phase_status: "Waiting" }))).toMatchObject({
      label: "Iteration 6/12",
      detail: "waiting for a slot",
    });
  });

  it("asks for the user's check at sign-off", () => {
    expect(
      loopLine(
        loop({ status: "Review", phase: "Approval", phase_status: "Waiting", ball: "User" }),
      ),
    ).toMatchObject({ label: "Needs your check", detail: "digest ready" });
  });

  it("leaves a pipeline task to the board's own line", () => {
    expect(loopLine(loop({ run_mode: "Pipeline" }))).toBeNull();
  });
});

describe("gateLine", () => {
  const now = new Date("2026-10-13T13:48:00");

  it("names the window and when it resumes", () => {
    const task = loop({
      gate: {
        agent_id: "claude-code",
        resume_at: new Date("2026-10-13T15:00:00").toISOString(),
        window: "five_hour",
        backoff: false,
      },
    });
    const line = gateLine(task, now);
    expect(line?.label).toBe("5-hour limit");
    expect(line?.detail).toMatch(/^resumes /);
  });

  it("says a backoff tries again, and a past gate shows nothing", () => {
    const backoff = loop({
      gate: {
        agent_id: "codex",
        resume_at: new Date("2026-10-13T14:35:00").toISOString(),
        backoff: true,
      },
    });
    expect(gateLine(backoff, now)).toMatchObject({ label: "Usage limit" });
    expect(gateLine(backoff, now)?.detail).toMatch(/^tries again /);
    expect(gateLine(backoff, new Date("2026-10-13T15:00:00"))).toBeNull();
  });
});

describe("the loop's helpers", () => {
  it("shows the check bar only once the loop has left the backlog", () => {
    expect(showsCheckBar(loop())).toBe(true);
    expect(showsCheckBar(loop({ status: "Planning" }))).toBe(false);
  });

  it("reads and writes agent time the way the editor shows it", () => {
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1h 30m")).toBe(5400);
    expect(parseDuration("90m")).toBe(5400);
    expect(parseDuration("1.5h")).toBe(5400);
    expect(parseDuration("45")).toBe(2700);
    expect(parseDuration("soon")).toBeNull();
    expect(formatDuration(5400)).toBe("1h 30m");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(2700)).toBe("45m");
  });

  it("finds the paths a check command names", () => {
    expect(pathsInCommand("bun run test acceptance/")).toEqual(["acceptance/"]);
    expect(pathsInCommand("scripts/untested.sh maestro-server/src/worktree.rs")).toEqual([
      "scripts/untested.sh",
      "maestro-server/src/worktree.rs",
    ]);
    expect(pathsInCommand("cargo test -p maestro-server --features x")).toEqual([]);
    expect(pathsInCommand("curl https://x.io/a.json > /tmp/out.txt")).toEqual([]);
  });
});
