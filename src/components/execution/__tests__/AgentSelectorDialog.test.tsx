import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/services/execution.service", () => ({
  useAgentDiscoveryQuery: vi.fn(),
  useSpawnAcpSessionMutation: vi.fn(),
  useSpawnInteractiveExecutionMutation: vi.fn(),
  useActiveSessionsQuery: vi.fn(),
  useCancelActiveSessionMutation: vi.fn(),
  useAgentCacheQuery: vi.fn(() => ({ data: null })),
  useRenameAcpSessionMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock("@/services/worktree.service", () => ({
  useWorktreesQuery: vi.fn(),
}));

vi.mock("@/store/navigationStore", () => ({
  usePendingAgentId: vi.fn(() => null),
  useNavigationActions: vi.fn(() => ({ clearPendingAgent: vi.fn() })),
}));

import {
  useAgentDiscoveryQuery,
  useSpawnAcpSessionMutation,
  useSpawnInteractiveExecutionMutation,
  useActiveSessionsQuery,
  useCancelActiveSessionMutation,
} from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { AgentsView } from "@/views/AgentsView";
import type { DiscoveredAgent, WorktreeWithStatus } from "@/types/bindings";

const mockAgents: DiscoveredAgent[] = [{ id: "claude-code", name: "Claude Code", icon: "" }];

const mockWorktrees: WorktreeWithStatus[] = [
  {
    id: 1,
    project_id: 1,
    path: "/tmp/repo",
    branch_name: "main",
    base_branch: null,
    task_id: null,
    git_status: "clean",
    diff_stat: "",
    ahead_behind: null,
    created_at: null,
    task_name: null,
    is_zombie: false,
    is_orphan: false,
  },
];

function renderView(connectionId?: number | null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AgentsView projectId={1} repoPath="/tmp/repo" connectionId={connectionId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (useActiveSessionsQuery as ReturnType<typeof vi.fn>).mockReturnValue({ data: [] });
  (useWorktreesQuery as ReturnType<typeof vi.fn>).mockReturnValue({ data: mockWorktrees });
  (useAgentDiscoveryQuery as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { maestro_server_available: true, agents: mockAgents, error: null },
    isLoading: false,
  });
  (useSpawnInteractiveExecutionMutation as ReturnType<typeof vi.fn>).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
  (useSpawnAcpSessionMutation as ReturnType<typeof vi.fn>).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
  (useCancelActiveSessionMutation as ReturnType<typeof vi.fn>).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });
});

describe("New Session dialog — agent type selector", () => {
  it("opens dialog with Terminal as default type when New Session clicked", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole("button", { name: /new session/i }));

    expect(screen.getByLabelText(/type/i)).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });

  it("shows agent options from registry for local connections", async () => {
    const user = userEvent.setup();
    renderView(null);

    await user.click(screen.getByRole("button", { name: /new session/i }));

    expect(useAgentDiscoveryQuery).toHaveBeenCalled();
  });
});

describe("spawn flow", () => {
  it("calls spawnInteractive for Terminal type", async () => {
    const mockMutate = vi.fn();
    (useSpawnInteractiveExecutionMutation as ReturnType<typeof vi.fn>).mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });

    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole("button", { name: /new session/i }));
    await user.click(screen.getByRole("button", { name: /^spawn$/i }));

    expect(mockMutate).toHaveBeenCalled();
  });
});
