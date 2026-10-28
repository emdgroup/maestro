import { describe, expect, it } from "vitest";
import type { LoopCheck, LoopIteration, LoopSummary, Task, TaskComment } from "@/types/bindings";
import {
  buildTimeLeft,
  canSignOff,
  checkOutcomes,
  failedFirst,
  failedStep,
  failingBefore,
  hiddenMatcher,
  lastLine,
  orderPatterns,
  setupOutcomes,
  notesGiven,
  draftLine,
  gateLine,
  loopLine,
  loopsWaiting,
  queuedLine,
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
      max_build_secs: 10800,
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

  it("says a loop is being prepared, and when its summary waits on the user", () => {
    const preparing = { status: "Planning" as const, phase: "Refining" as const };
    expect(loopLine(loop({ status: "Planning", phase: "Spawning" }))).toMatchObject({
      label: "Preparing",
    });
    expect(loopLine(loop({ ...preparing, phase_status: "Running", ball: "Agent" }))).toMatchObject({
      label: "Preparing",
    });
    expect(loopLine(loop({ ...preparing, phase_status: "Waiting", ball: "User" }))).toMatchObject({
      label: "Loop prepared",
      detail: "read its summary",
    });
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

  it("reads and writes the time per Build the way the editor shows it", () => {
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

  it("says how long a running Build has left, and when it is about to be closed", () => {
    expect(buildTimeLeft(74 * 60, 7200)).toEqual({ late: false, tip: "46m left" });
    expect(buildTimeLeft(112 * 60, 7200)).toEqual({ late: true, tip: "Closes in 8m" });
    expect(buildTimeLeft(7300, 7200)).toEqual({ late: true, tip: "Closing now" });
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

describe("the waiting cap and drafts", () => {
  const queued = loop({ status: "Queue", phase: null, phase_status: null, ball: "None" });

  it("counts the loops waiting on the user, and nothing else", () => {
    const waiting = loop({ phase: "Approval", phase_status: "Waiting", ball: "User" });
    expect(
      loopsWaiting([
        waiting,
        waiting,
        loop({ ball: "User", status: "Done" }),
        loop({ ball: "User", archived_at: "2026-10-13T10:00:00Z" }),
        loop({ ball: "User", run_mode: "Pipeline" }),
        queued,
      ]),
    ).toBe(2);
  });

  it("says why a queued loop waits, only while the cap holds it and the user did not ask", () => {
    expect(queuedLine(queued, 2)).toEqual({
      label: "Queued",
      detail: "2 loops already wait on you",
      tone: "muted",
    });
    expect(queuedLine(queued, 1)?.detail).toBe("1 loop already waits on you");
    expect(queuedLine(queued, null)).toBeNull();
    expect(queuedLine({ ...queued, execute_requested_at: "2026-10-13T10:00:00Z" }, 2)).toBeNull();
    expect(queuedLine({ ...queued, run_mode: "Pipeline" }, 2)).toBeNull();
  });

  it("names the automation run a draft came from while it is in Planning", () => {
    const drafted = loop({
      status: "Planning",
      drafted_by: { automation: "Nightly triage", run: 12 },
    });
    expect(draftLine(drafted)?.detail).toBe("from Nightly triage #12");
    expect(draftLine({ ...drafted, drafted_by: { automation: "Old" } })?.detail).toBe("from Old");
    expect(draftLine({ ...drafted, status: "Queue" })).toBeNull();
    expect(draftLine(loop())).toBeNull();
  });
});

describe("hidden from the agent", () => {
  // The same table as the daemon's `sealed_patterns_hide_and_show_as_the_table_says`.
  it("reads the sealed patterns as the daemon does", () => {
    const hidden = hiddenMatcher(["tests/", "**/*.test.ts", "docs/*.md", "!tests/helpers/"]);
    const table: [string, boolean][] = [
      ["tests/a.ts", true],
      ["tests/deep/b.ts", true],
      ["tests/helpers/h.ts", false],
      ["src/x.test.ts", true],
      ["x.test.ts", true],
      ["src/x.ts", false],
      ["docs/a.md", true],
      ["docs/deep/a.md", false],
      ["src/tests/a.ts", false],
    ];
    for (const [path, expected] of table)
      expect([path, hidden(path).hidden]).toEqual([path, expected]);
    expect(hidden("tests/a.ts").by).toBe("tests/");
    expect(hidden("tests/helpers/h.ts").by).toBe("!tests/helpers/");
    expect(hidden("src/x.ts").by).toBeNull();
  });

  it("lets a later entry win, the nearest level first, and a plain path take its folder", () => {
    expect(hiddenMatcher(["!src/a.ts", "src/a.ts"])("src/a.ts").hidden).toBe(true);
    expect(hiddenMatcher(["src/a.ts", "!src/a.ts"])("src/a.ts").hidden).toBe(false);
    expect(hiddenMatcher(["src/", "!src/a.ts"])("src/a.ts").hidden).toBe(false);
    expect(hiddenMatcher(["scripts"])("scripts/check.sh").hidden).toBe(true);
    expect(hiddenMatcher(["a.ts"])("src/a.ts").hidden).toBe(false);
  });

  it("stores the rules, then the picked paths, then the exceptions", () => {
    expect(orderPatterns(["!b/", "a.ts", "**/*.sql", "a.ts", "c/"])).toEqual([
      "**/*.sql",
      "a.ts",
      "c/",
      "!b/",
    ]);
  });
});

describe("an iteration's checks", () => {
  const check = (id: number, position: number, kind: LoopCheck["kind"] = "Command") =>
    ({ id, position, kind, label: `Check ${id}`, proposed: false, accepted: false }) as LoopCheck;
  const iteration = (n: number, started_at: string, results: LoopIteration["results"] = []) =>
    ({ n, attempt: 1, started_at, outcome: "Checked", results }) as unknown as LoopIteration;
  const checks = [check(2, 1), check(1, 0), check(3, 2, "Judge")];

  it("follows the list order, failed first when opened, and leaves a waiting proposal out", () => {
    const proposal = { ...check(4, 3), proposed: true };
    const it5 = iteration(5, "2026-10-19T10:21:00Z", [
      { check_id: 2, state: "Fail", detail: "x\n  Tests 2 failed  \n\n" },
      { check_id: 1, state: "Pass", detail: "ok" },
    ]);
    const outcomes = checkOutcomes(it5, [...checks, proposal]);
    expect(outcomes.map((o) => [o.check.id, o.result?.state ?? null])).toEqual([
      [1, "Pass"],
      [2, "Fail"],
      [3, null],
    ]);
    expect(failedFirst(outcomes).map((o) => o.check.id)).toEqual([2, 1, 3]);
    expect(lastLine(outcomes[1].result?.detail)).toBe("Tests 2 failed");
  });

  it("signs off only once every check passes, the manual ones ticked, and no proposal waits", () => {
    const pass = (c: LoopCheck) => ({ ...c, state: "Pass" }) as LoopCheck;
    const passing = [pass(check(1, 0)), pass(check(2, 1, "Judge"))];
    expect(canSignOff(passing)).toBe(true);
    expect(canSignOff([...passing, { ...check(3, 2, "Manual"), state: "Pending" }])).toBe(false);
    expect(canSignOff([...passing, pass(check(3, 2, "Manual"))])).toBe(true);
    expect(canSignOff([...passing, pass({ ...check(4, 3), proposed: true })])).toBe(false);
    expect(canSignOff([])).toBe(false);
    // A step is not a check: it neither blocks the sign-off nor makes one.
    expect(canSignOff([...passing, { ...check(5, 4, "Setup"), state: "Fail" }])).toBe(true);
    expect(canSignOff([pass(check(5, 4, "Setup"))])).toBe(false);
  });

  it("keeps the steps apart from the checks and names the one that failed", () => {
    const withSteps = [...checks, check(7, 5, "Setup"), check(6, 4, "Setup")];
    const it5 = iteration(5, "2026-10-19T10:21:00Z", [
      { check_id: 6, state: "Pass", detail: "ok" },
      { check_id: 7, state: "Fail", detail: "port in use" },
      { check_id: 1, state: "Fail", detail: "Step 2 (Check 7) failed, so no check ran." },
    ]);
    expect(checkOutcomes(it5, withSteps).map((o) => o.check.id)).toEqual([1, 2, 3]);
    expect(setupOutcomes(it5, withSteps).map((o) => o.check.id)).toEqual([6, 7]);
    expect(failedStep(it5, withSteps)).toMatchObject({ n: 2, outcome: { check: { id: 7 } } });
    expect(failedStep(iteration(4, ""), withSteps)).toBeNull();
  });

  it("works on what the latest earlier round left failing, and the notes written since", () => {
    const it4 = iteration(4, "2026-10-19T10:02:00Z", [
      { check_id: 1, state: "Fail", detail: "1 failed" },
    ]);
    const it5 = iteration(5, "2026-10-19T10:21:00Z");
    const it6 = iteration(6, "2026-10-19T10:42:00Z");
    const all = [it4, it5, it6];
    expect(failingBefore(all, it6, checks)).toEqual([{ label: "Check 1", line: "1 failed" }]);
    expect(failingBefore(all, it4, checks)).toEqual([]);

    const note = (id: number, created_at: string, kind = "steer") =>
      ({ id, kind, body: `note ${id}`, created_at }) as TaskComment;
    const comments = [
      note(1, "2026-10-19T10:10:00Z"),
      note(2, "2026-10-19T10:30:00Z"),
      note(3, "2026-10-19T10:31:00Z", "note"),
      note(4, "2026-10-19T10:50:00Z"),
    ];
    expect(notesGiven(comments, all, it6).map((c) => c.id)).toEqual([2]);
  });
});
