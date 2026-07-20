import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentMonitor } from "./AgentMonitor";

vi.mock("../agent-activity-panel/AgentActivityPanel", () => ({
  AgentActivityPanel: () => null,
}));

vi.mock("@/services/execution.service", () => ({
  useRenameAcpSessionMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

const baseSession = {
  session_key: 1,
  task_id: null,
  task_name: null,
  session_name: "test-session",
  branch_name: "main",
  agent_id: null,
  acp_session_id: null,
  execution_mode: "pty",
  started_at: "2026-04-21T00:00:00Z",
  supports_session_list: false,
  supports_session_load: false,
  supports_session_close: false,
  supports_session_delete: false,
  project_id: null,
  task_prevents_close: false,
};

const defaultProps = {
  sessions: [] as (typeof baseSession)[],
  selectedSessionKey: null,
  onSelect: vi.fn(),
  search: "",
  connection: { type: "local" as const },
};

function renderMonitor(props: Parameters<typeof AgentMonitor>[0]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AgentMonitor {...props} />
    </QueryClientProvider>,
  );
}

describe("AgentMonitor session-type icon (SPAWN-03)", () => {
  it("renders brand icon for execution_mode 'acp' with known agent_id", () => {
    renderMonitor({
      ...defaultProps,
      sessions: [{ ...baseSession, execution_mode: "acp", agent_id: "claude-acp" }],
    });
    expect(document.querySelector(".pr-avatar-icon svg")).toBeInTheDocument();
  });

  it("renders terminal icon for execution_mode 'pty'", () => {
    renderMonitor({
      ...defaultProps,
      sessions: [{ ...baseSession, execution_mode: "pty" }],
    });
    expect(document.querySelector(".pr-avatar-icon svg")).toBeInTheDocument();
  });

  it("renders terminal icon for execution_mode 'pty' without agent_id", () => {
    renderMonitor({
      ...defaultProps,
      sessions: [{ ...baseSession, execution_mode: "pty", agent_id: null }],
    });
    expect(document.querySelector(".pr-avatar-icon svg")).toBeInTheDocument();
  });
});
