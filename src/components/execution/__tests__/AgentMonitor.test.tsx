import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AgentMonitor } from "../AgentMonitor";

vi.mock("../AgentActivityPanel", () => ({
  AgentActivityPanel: () => null,
}));

const baseSession = {
  session_key: 1,
  task_id: null,
  task_name: null,
  session_name: "test-session",
  branch_name: "main",
  agent_id: null,
  execution_mode: "pty",
  started_at: "2026-04-21T00:00:00Z",
  supports_session_list: false,
  supports_session_load: false,
  supports_session_close: false,
};

const defaultProps = {
  sessions: [] as typeof baseSession[],
  selectedSessionKey: null,
  onSelect: vi.fn(),
  search: "",
};

describe("AgentMonitor session-type badge (SPAWN-03)", () => {
  it("renders agent name badge for execution_mode 'acp' with agent_id", () => {
    render(
      <AgentMonitor
        {...defaultProps}
        sessions={[{ ...baseSession, execution_mode: "acp", agent_id: "claude-code" }]}
      />,
    );
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });

  it("renders 'Terminal' badge for execution_mode 'pty'", () => {
    render(
      <AgentMonitor
        {...defaultProps}
        sessions={[{ ...baseSession, execution_mode: "pty" }]}
      />,
    );
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });

  it("renders 'Terminal' badge for null execution_mode", () => {
    render(
      <AgentMonitor
        {...defaultProps}
        sessions={[{ ...baseSession, execution_mode: "pty" }]}
      />,
    );
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });
});
