import { fireEvent, render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@/ui/sidebar";
import { AgentMonitor } from "./AgentMonitor";

vi.mock("../agent-activity-panel/AgentActivityPanel", () => ({
  AgentActivityPanel: () => null,
}));

vi.mock("@/services/execution.service", () => ({
  useRenameAcpSessionMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useCancelActiveSessionMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useReloadAcpSessionMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

const automationRuns = vi.hoisted(() => ({ current: [] as object[] }));
vi.mock("@/services/automation.service", () => ({
  useAutomationRunsQuery: () => ({ data: automationRuns.current }),
}));

const baseSession = {
  session_id: "1",
  task_id: null,
  task_name: null,
  task_role: null,
  session_name: "test-session",
  branch_name: "main",
  agent_id: null,
  acp_session_id: null,
  cwd: "/tmp/repo",
  execution_mode: "pty",
  started_at: "2026-04-21T00:00:00Z",
  supports_session_list: false,
  supports_session_load: false,
  supports_session_close: false,
  supports_session_delete: false,
  project_id: null,
};

const defaultProps = {
  sessions: [] as (typeof baseSession)[],
  selectedSessionId: null,
  onSelect: vi.fn(),
  search: "",
  connection: { type: "local" as const },
};

function renderMonitor(props: Parameters<typeof AgentMonitor>[0], open = true) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SidebarProvider open={open}>
        <AgentMonitor {...props} />
      </SidebarProvider>
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

  it("hides the close button while the sidebar rail is collapsed", () => {
    const { queryByLabelText } = renderMonitor(
      {
        ...defaultProps,
        sessions: [{ ...baseSession, execution_mode: "pty" as const }],
        onClose: vi.fn(),
      },
      false,
    );
    expect(queryByLabelText("Close session")).not.toBeInTheDocument();
  });

  it("shows the close button when the sidebar is expanded", () => {
    const { queryByLabelText } = renderMonitor({
      ...defaultProps,
      sessions: [{ ...baseSession, execution_mode: "pty" as const }],
      onClose: vi.fn(),
    });
    expect(queryByLabelText("Close session")).toBeInTheDocument();
  });

  it("renders terminal icon for execution_mode 'pty' without agent_id", () => {
    renderMonitor({
      ...defaultProps,
      sessions: [{ ...baseSession, execution_mode: "pty", agent_id: null }],
    });
    expect(document.querySelector(".pr-avatar-icon svg")).toBeInTheDocument();
  });
});

describe("AgentMonitor role chip", () => {
  const taskSession = {
    ...baseSession,
    execution_mode: "acp" as const,
    agent_id: "claude-acp",
    task_id: 42,
    task_name: "Fix login",
    session_name: "amber-brook",
  };

  it("names the stage the session was spawned for", () => {
    const { getAllByText } = renderMonitor({
      ...defaultProps,
      sessions: [{ ...taskSession, task_role: { role: "Planner" as const, profile_id: "strict" } }],
    });
    // Sidebar row and detail header both carry one.
    expect(getAllByText("Plan").length).toBeGreaterThan(0);
  });

  it("shows nothing for a session no task started", () => {
    const { queryByText } = renderMonitor({
      ...defaultProps,
      sessions: [{ ...taskSession, task_id: null, task_name: null, task_role: null }],
    });
    expect(queryByText("Plan")).toBeNull();
    expect(queryByText("Implement")).toBeNull();
  });
});

describe("AgentMonitor reload button", () => {
  it("is not offered for a session with nothing in it yet", () => {
    const { queryByLabelText } = renderMonitor({
      ...defaultProps,
      projectId: 1,
      selectedSessionId: "fresh",
      sessions: [
        {
          ...baseSession,
          session_id: "fresh",
          execution_mode: "acp" as const,
          agent_id: "claude-acp",
          acp_session_id: "acp-fresh",
        },
      ],
    });
    expect(queryByLabelText("Reload session")).not.toBeInTheDocument();
  });
});

describe("AgentMonitor session groups", () => {
  const run = (id: string) => ({
    ...baseSession,
    session_id: id,
    execution_mode: "acp" as const,
    agent_id: "claude-acp",
    acp_session_id: `agent-${id}`,
    session_name: "Daily summary",
  });

  it("gathers an automation's live runs under one header, each named by its run", () => {
    automationRuns.current = [
      {
        automation_id: "daily",
        automation_name: "Daily summary",
        agent_session_id: "agent-r1",
        ordinal: 13,
      },
      {
        automation_id: "daily",
        automation_name: "Daily summary",
        agent_session_id: "agent-r2",
        ordinal: 14,
      },
    ];
    const { getByText, getAllByText } = renderMonitor({
      ...defaultProps,
      projectId: 1,
      sessions: [run("r1"), run("r2"), { ...baseSession, execution_mode: "pty" as const }],
    });
    automationRuns.current = [];
    expect(getByText("Automations")).toBeInTheDocument();
    expect(getByText("test-session")).toBeInTheDocument();
    expect(getAllByText("Daily summary")).toHaveLength(1);
    expect(getByText("Run #13")).toBeInTheDocument();
    expect(getByText("Run #14")).toBeInTheDocument();
  });

  it("folds a section when its header is clicked", () => {
    const { getByText, queryByText } = renderMonitor({
      ...defaultProps,
      sessions: [
        { ...baseSession, task_id: 7, task_name: "Fix login", execution_mode: "pty" as const },
      ],
    });
    fireEvent.click(getByText("Tasks"));
    expect(queryByText("test-session")).toBeNull();
    fireEvent.click(getByText("Tasks"));
    expect(getByText("test-session")).toBeInTheDocument();
  });

  it("puts the user's own sessions first, at the root, with no header", () => {
    const { getByText, queryByText } = renderMonitor({
      ...defaultProps,
      sessions: [
        {
          ...baseSession,
          session_id: "t",
          task_id: 7,
          session_name: "Fix login",
          execution_mode: "pty" as const,
        },
        { ...baseSession, execution_mode: "pty" as const },
      ],
    });
    expect(queryByText("Yours")).toBeNull();
    const mine = getByText("test-session");
    expect(
      mine.compareDocumentPosition(getByText("Tasks")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
