import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AgentMonitor } from "../AgentMonitor";

const baseExecution = {
  id: 1,
  task_id: null,
  task_name: null,
  session_name: "test-session",
  branch_name: "main",
  status: "running",
  started_at: "2026-04-21T00:00:00Z",
  completed_at: null,
  terminal_output: null,
  agent_id: null,
};

const defaultProps = {
  executions: [] as any[],
  selectedExecutionId: null,
  onSelect: vi.fn(),
  search: "",
  statusFilter: "All" as const,
};

describe("AgentMonitor session-type badge (SPAWN-03)", () => {
  it("renders 'ACP' badge for execution_mode 'acp'", () => {
    render(
      <AgentMonitor
        {...defaultProps}
        executions={[{ ...baseExecution, execution_mode: "acp" }]}
      />,
    );
    expect(screen.getByText("ACP")).toBeInTheDocument();
  });

  it("renders 'Interactive' badge for execution_mode 'pty'", () => {
    render(
      <AgentMonitor
        {...defaultProps}
        executions={[{ ...baseExecution, execution_mode: "pty" }]}
      />,
    );
    expect(screen.getByText("Interactive")).toBeInTheDocument();
  });

  it("renders 'Interactive' badge for null execution_mode", () => {
    render(
      <AgentMonitor
        {...defaultProps}
        executions={[{ ...baseExecution, execution_mode: null }]}
      />,
    );
    expect(screen.getByText("Interactive")).toBeInTheDocument();
  });
});
