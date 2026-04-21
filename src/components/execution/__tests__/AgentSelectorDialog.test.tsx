import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentSelectorDialog } from "../AgentSelectorDialog.tsx";
import type { AgentInfo, WorktreeWithStatus } from "@/types/bindings";

// Mock Tauri IPC
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock the service hooks used by AgentSelectorDialog
vi.mock("@/services/execution.service", () => ({
  useAgentRegistryQuery: vi.fn(),
  useSpawnAcpSessionMutation: vi.fn(),
}));

import { useAgentRegistryQuery, useSpawnAcpSessionMutation } from "@/services/execution.service";

const mockUseAgentRegistryQuery = useAgentRegistryQuery as ReturnType<typeof vi.fn>;
const mockUseSpawnAcpSessionMutation = useSpawnAcpSessionMutation as ReturnType<typeof vi.fn>;

// Test data fixtures
const mockAgents: AgentInfo[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    version: "1.0.0",
    description: "AI coding agent",
    distribution: {} as AgentInfo["distribution"],
    repository: null,
    authors: null,
    license: null,
    icon: null,
    website: null,
  },
  {
    id: "aider",
    name: "Aider",
    version: "0.8.0",
    description: "AI pair programming",
    distribution: {} as AgentInfo["distribution"],
    repository: null,
    authors: null,
    license: null,
    icon: null,
    website: null,
  },
];

const mockWorktrees: WorktreeWithStatus[] = [
  {
    id: 1,
    project_id: 1,
    path: "/tmp/repo",
    branch_name: "main",
    base_branch: null,
    task_id: null,
    agent_status: "idle",
    git_status: "clean",
    diff_stat: "",
    ahead_behind: null,
    created_at: null,
    task_name: null,
    is_zombie: false,
    is_orphan: false,
  },
];

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("AgentSelectorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mutation mock
    mockUseSpawnAcpSessionMutation.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
  });

  // SPAWN-01: Agent list rendering
  describe("agent list rendering", () => {
    it("renders agent list from registry data", () => {
      mockUseAgentRegistryQuery.mockReturnValue({
        data: { agents: mockAgents, cached: false, stale: false },
        isLoading: false,
      });

      renderWithQueryClient(
        <AgentSelectorDialog
          open={true}
          onOpenChange={vi.fn()}
          worktrees={mockWorktrees}
          onSpawned={vi.fn()}
        />,
      );

      expect(screen.getByText("Claude Code")).toBeInTheDocument();
      expect(screen.getByText("Aider")).toBeInTheDocument();
    });

    it("shows loading state when registry is fetching", () => {
      mockUseAgentRegistryQuery.mockReturnValue({
        data: undefined,
        isLoading: true,
      });

      renderWithQueryClient(
        <AgentSelectorDialog
          open={true}
          onOpenChange={vi.fn()}
          worktrees={mockWorktrees}
          onSpawned={vi.fn()}
        />,
      );

      expect(screen.getByText("Loading agents...")).toBeInTheDocument();
    });
  });

  // SPAWN-02: Spawn flow
  describe("spawn flow", () => {
    it("disables Spawn button when no agent selected", () => {
      mockUseAgentRegistryQuery.mockReturnValue({
        data: { agents: mockAgents, cached: false, stale: false },
        isLoading: false,
      });

      renderWithQueryClient(
        <AgentSelectorDialog
          open={true}
          onOpenChange={vi.fn()}
          worktrees={mockWorktrees}
          onSpawned={vi.fn()}
        />,
      );

      const spawnButton = screen.getByRole("button", { name: /spawn agent/i });
      expect(spawnButton).toBeDisabled();
    });

    it("calls spawnAcpSession mutation on Spawn click", async () => {
      const mockMutate = vi.fn();
      mockUseSpawnAcpSessionMutation.mockReturnValue({
        mutate: mockMutate,
        isPending: false,
      });
      mockUseAgentRegistryQuery.mockReturnValue({
        data: { agents: mockAgents, cached: false, stale: false },
        isLoading: false,
      });

      const user = userEvent.setup();
      renderWithQueryClient(
        <AgentSelectorDialog
          open={true}
          onOpenChange={vi.fn()}
          worktrees={mockWorktrees}
          onSpawned={vi.fn()}
        />,
      );

      // Select "Claude Code" from the agent list
      await user.click(screen.getByText("Claude Code"));

      // Click the Spawn button
      const spawnButton = screen.getByRole("button", { name: /spawn agent/i });
      await user.click(spawnButton);

      expect(mockMutate).toHaveBeenCalledWith(
        { agentId: "claude-code", cwd: "/tmp/repo", sessionName: null },
        expect.any(Object),
      );
    });
  });
});
