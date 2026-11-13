import { describe, it, expect } from "vitest";
import type { MonitorSession } from "@/store/fileSessionStore";
import { activityRank, groupSessions } from "./sessionGroups";

function session(id: string, fields: Partial<MonitorSession> = {}): MonitorSession {
  return {
    session_id: id,
    session_name: null,
    agent_id: "claude-acp",
    execution_mode: "acp",
    started_at: "2026-11-01T00:00:00Z",
    task_id: null,
    task_name: null,
    task_role: null,
    branch_name: null,
    acp_session_id: id,
    cwd: "/repo",
    supports_session_list: false,
    supports_session_load: false,
    supports_session_close: false,
    supports_session_delete: false,
    project_id: 1,
    ...fields,
  } as MonitorSession;
}

describe("groupSessions", () => {
  const automations: Record<string, { id: string; name: string }> = {
    a1: { id: "daily", name: "Daily summary" },
    a2: { id: "daily", name: "Daily summary" },
  };

  it("sorts sessions into yours, tasks and automations, gathering an automation's runs", () => {
    const sections = groupSessions(
      [
        session("y1"),
        session("a1"),
        session("t1", { task_id: 7 }),
        session("a2"),
        session("t3", { task_id: 9 }),
      ],
      (s) => automations[s.session_id],
      () => 2,
    );
    expect(sections.map((s) => [s.key, s.groups.map((g) => g.key)])).toEqual([
      ["yours", ["y1"]],
      ["tasks", ["t1", "t3"]],
      ["automations", ["automation:daily"]],
    ]);
    expect(sections[2].groups[0].sessions).toHaveLength(2);
  });

  it("puts what needs the user first, then work in progress, then the newest", () => {
    const ranks: Record<string, number> = { old: 2, new: 2, busy: 1, blocked: 0 };
    const sections = groupSessions(
      [
        session("old", { started_at: "2026-11-01T00:00:00Z" }),
        session("new", { started_at: "2026-11-02T00:00:00Z" }),
        session("busy"),
        session("blocked", { task_id: 3 }),
        session("idle-task", { task_id: 4 }),
      ],
      () => undefined,
      (s) => ranks[s.session_id] ?? 2,
    );
    expect(sections[0].groups.map((g) => g.key)).toEqual(["busy", "new", "old"]);
    expect(sections[1].groups.map((g) => g.key)).toEqual(["blocked", "idle-task"]);
  });

  it("leaves empty sections out", () => {
    expect(
      groupSessions(
        [session("y")],
        () => undefined,
        () => 2,
      ).map((s) => s.key),
    ).toEqual(["yours"]);
  });

  it("ranks a session awaiting input above one at work, and work above idle", () => {
    expect(activityRank("awaiting_input")).toBeLessThan(activityRank("thinking"));
    expect(activityRank("acting")).toBeLessThan(activityRank("idle"));
    expect(activityRank(undefined)).toBe(activityRank("idle"));
  });
});
