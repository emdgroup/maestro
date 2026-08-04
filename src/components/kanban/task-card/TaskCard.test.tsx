import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskCard } from "./TaskCard";
import type { Task, TaskPhase, PhaseStatus, TaskBall } from "@/types/bindings";

vi.mock("@/contexts/KanbanContext", () => ({
  useKanban: () => ({ projectId: 1, projectPath: "/tmp/demo", connection: { type: "local" } }),
}));

vi.mock("@/hooks/useExecuteTask", () => ({
  useExecuteTask: () => ({
    execute: vi.fn(),
    isExecuting: false,
    dirtyDialogOpen: false,
    dirtyModifiedCount: 0,
    dirtyUntrackedCount: 0,
    onDirtyChoice: vi.fn(),
    onDirtyCancel: vi.fn(),
  }),
  useTaskActiveSession: () => null,
}));

vi.mock("@/services/task.service", () => ({
  useInterruptTaskMutation: () => ({ mutate: vi.fn() }),
  useArchiveTaskMutation: () => ({ mutate: vi.fn() }),
  useSendTaskToReviewMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/services/execution.service", () => ({
  useRecoverTaskSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/store/navigationStore", () => ({
  useNavigationActions: () => ({ setActiveTaskId: vi.fn() }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/store/boardStore", () => ({
  useBoardStore: (selector: (state: { pendingAuthRetry: number | null }) => unknown) =>
    selector({ pendingAuthRetry: null }),
  useBoardActions: () => ({
    openReview: vi.fn(),
    clearAuthRequired: vi.fn(),
    setAuthTerminalIdle: vi.fn(),
    clearPendingAuthRetry: vi.fn(),
  }),
  useAuthRequiredTask: () => null,
}));

vi.mock("@/store/sessionActivityStore", () => ({
  useSessionActivity: () => undefined,
}));

vi.mock("@dnd-kit/react/sortable", () => ({
  useSortable: () => ({ ref: vi.fn(), isDragging: false }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 7,
    project_id: 1,
    title: "Fix worktree cleanup on merge",
    status: "InProgress",
    priority: "None",
    base_branch: "main",
    skills: [],
    labels: [],
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    auto_approve: false,
    isolated_worktree: true,
    phase: null,
    phase_status: null,
    ball: "None",
    ...overrides,
  } as Task;
}

function renderCard(overrides: Partial<Task> = {}) {
  const { container } = render(<TaskCard task={makeTask(overrides)} index={0} />);
  // The outermost div carries the treatment classes.
  return container.firstElementChild as HTMLElement;
}

describe("TaskCard pipeline treatment", () => {
  it("renders no phase line when the task has no pipeline activity", () => {
    renderCard({ status: "Planning" });
    expect(screen.queryByText(/implementing/i)).not.toBeInTheDocument();
  });

  it("labels the current phase", () => {
    renderCard({ phase: "Implementing", phase_status: "Running", ball: "Agent" });
    expect(screen.getByText("Implementing")).toBeInTheDocument();
  });

  it("uses the multi-word label for compound phases", () => {
    renderCard({ phase: "SelfReview", phase_status: "Running", ball: "Agent" });
    expect(screen.getByText("Self review")).toBeInTheDocument();
  });

  /// The distinction the whole design rests on: only a blocked agent animates.
  it("animates only when an agent is blocked, not when a gate is merely waiting", () => {
    const blocked = renderCard({
      phase: "Implementing",
      phase_status: "Blocked",
      ball: "User",
    });
    expect(blocked.className).toContain("animate-glow-warning");

    const waiting = renderCard({ phase: "Approval", phase_status: "Waiting", ball: "User" });
    expect(waiting.className).not.toContain("animate-glow-warning");
    expect(waiting.className).toContain("border-accent");
  });

  /// The card's own border must stay neutral so the three phase treatments can each take it
  /// over. It used to repeat the column's colour, which made waiting and blocked indistinguishable
  /// from the card itself in the amber In Progress column.
  it("keeps a neutral border when no phase state applies", () => {
    const running = renderCard({ phase: "Implementing", phase_status: "Running", ball: "Agent" });
    expect(running.className).toContain("border-border");
    expect(running.className).not.toContain("animate-glow-warning");
    expect(running.className).not.toContain("border-accent");
    expect(running.className).not.toContain("border-destructive");
  });

  it("marks a failed phase as failed and names it", () => {
    const failed = renderCard({ phase: "Implementing", phase_status: "Failed", ball: "User" });
    expect(failed.className).toContain("border-destructive");
    expect(screen.getByText(/Implementing · failed/)).toBeInTheDocument();
  });

  it.each<[TaskBall, TaskPhase, PhaseStatus]>([
    ["Agent", "Implementing", "Running"],
    ["User", "Approval", "Waiting"],
    ["User", "Rework", "Waiting"],
  ])("renders a %s-owned %s phase without crashing", (ball, phase, phase_status) => {
    expect(renderCard({ ball, phase, phase_status })).toBeTruthy();
  });
});

/// The escape hatch for a task neither completion signal moved on. It must not be offered while
/// the agent is still working, or it invites sending half-finished work to review.
describe("TaskCard send-to-review escape hatch", () => {
  it("is offered when the agent has stopped and is waiting", () => {
    renderCard({ phase: "Implementing", phase_status: "Waiting", ball: "User" });
    expect(screen.getByTitle(/without waiting for the agent/i)).toBeInTheDocument();
  });

  it("is offered when the phase failed", () => {
    renderCard({ phase: "Implementing", phase_status: "Failed", ball: "User" });
    expect(screen.getByTitle(/without waiting for the agent/i)).toBeInTheDocument();
  });

  it("is hidden while the agent is running", () => {
    renderCard({ phase: "Implementing", phase_status: "Running", ball: "Agent" });
    expect(screen.queryByTitle(/without waiting for the agent/i)).not.toBeInTheDocument();
  });

  /// A dead session is exactly when the work may be finished and only the session gone, so the
  /// "Session lost" branch must not swallow the escape hatch — it used to return before the
  /// button was even constructed.
  it("survives the session-lost branch", async () => {
    renderCard({ phase: "Implementing", phase_status: "Failed", ball: "User" });
    // The branch is gated on a 2s debounce; the button must be present either side of it.
    expect(screen.getByTitle(/without waiting for the agent/i)).toBeInTheDocument();
  });

  it("is hidden outside In Progress", () => {
    renderCard({ status: "Review", phase: "Approval", phase_status: "Waiting", ball: "User" });
    expect(screen.queryByTitle(/without waiting for the agent/i)).not.toBeInTheDocument();
  });
});
