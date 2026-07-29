import { describe, it, expect } from "vitest";
import type { ActiveSessionInfo } from "@/types/bindings";
import {
  agentLabel,
  notificationBody,
  sessionLabel,
  signalForStopReason,
} from "./session-notification";

function session(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    session_key: 42,
    session_name: null,
    agent_id: "claude-code",
    execution_mode: "acp",
    started_at: "2026-01-01T00:00:00Z",
    task_id: null,
    task_name: null,
    branch_name: null,
    acp_session_id: null,
    supports_session_list: false,
    supports_session_load: false,
    supports_session_close: false,
    supports_session_delete: false,
    project_id: null,
    task_prevents_close: false,
    ...overrides,
  } as ActiveSessionInfo;
}

describe("signalForStopReason", () => {
  it("treats a normal turn end as done", () => {
    expect(signalForStopReason("end_turn", "Claude Code")).toEqual({
      kind: "done",
      title: "Agent finished",
      detail: "Claude Code",
    });
  });

  it("routes auth_required to attention, not failure", () => {
    expect(signalForStopReason("auth_required", "Claude Code")?.kind).toBe("attention");
  });

  it.each(["error", "refusal", "max_tokens", "max_turn_requests"])(
    "treats %s as a failure",
    (reason) => {
      expect(signalForStopReason(reason, "Claude Code")?.kind).toBe("failure");
    },
  );

  it("stays silent on cancellation and on reasons it has no copy for", () => {
    expect(signalForStopReason("cancelled", "Claude Code")).toBeNull();
    expect(signalForStopReason("some_future_reason", "Claude Code")).toBeNull();
  });
});

describe("labels", () => {
  it("prefers the task name, then the session name, then the branch", () => {
    expect(sessionLabel(session({ task_name: "Fix login", branch_name: "fix-login" }))).toBe(
      "Fix login",
    );
    expect(sessionLabel(session({ session_name: "Scratch", branch_name: "fix-login" }))).toBe(
      "Scratch",
    );
    expect(sessionLabel(session({ branch_name: "fix-login" }))).toBe("fix-login");
    expect(sessionLabel(session())).toBe("Session 42");
  });

  it("truncates a long label so the toast body does not wrap away the detail", () => {
    const label = sessionLabel(session({ task_name: "x".repeat(60) }));
    expect(label).toHaveLength(40);
    expect(label.endsWith("…")).toBe(true);
  });

  it("renders the agent id as a display name", () => {
    expect(agentLabel(session())).toBe("Claude Code");
    expect(agentLabel(session({ agent_id: "gemini" }))).toBe("Gemini");
    expect(agentLabel(session({ agent_id: null }))).toBe("The agent");
  });

  it("joins the label and the detail into a body", () => {
    expect(notificationBody(session({ task_name: "Fix login" }), "Claude Code")).toBe(
      "Fix login · Claude Code",
    );
  });
});
