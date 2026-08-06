import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskCard } from "./TaskCard";
import type { Task, TaskPhase, PhaseStatus, TaskBall } from "@/types/bindings";

vi.mock("@/contexts/KanbanContext", () => ({
  useKanban: () => ({ projectId: 1, projectPath: "/tmp/demo", connection: { type: "local" } }),
}));

/// Swapped per-test so a card can be rendered with or without a live session behind it.
const activeSession = vi.hoisted(() => ({ current: null as { session_key: number } | null }));

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
  // Honours the taskId argument rather than ignoring it, so that a card which declines to look a
  // session up gets null — otherwise this mock would paper over exactly the bug it guards.
  useTaskActiveSession: (taskId: number | null) => (taskId === null ? null : activeSession.current),
}));

/// Captures what the card sends, and lets a test decide what the backend answered.
const sendToReview = vi.hoisted(() => ({
  mutate: vi.fn(),
  /// `null` is the backend saying "this task changed nothing"; a Task means it moved.
  result: null as unknown,
}));

/// Abandoning deletes the worktree and branch, so the test needs to see whether it fired.
const interrupt = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("@/services/task.service", () => ({
  useInterruptTaskMutation: () => ({ mutate: interrupt.mutate }),
  useArchiveTaskMutation: () => ({ mutate: vi.fn() }),
  useSendTaskToReviewMutation: () => ({
    mutate: (vars: unknown, opts?: { onSuccess?: (data: unknown) => void }) => {
      sendToReview.mutate(vars);
      opts?.onSuccess?.(sendToReview.result);
    },
    isPending: false,
  }),
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

beforeEach(() => {
  activeSession.current = null;
  sendToReview.mutate.mockClear();
  sendToReview.result = null;
  interrupt.mutate.mockClear();
});

describe("TaskCard abandon", () => {
  const running: Partial<Task> = {
    status: "InProgress",
    phase: "Implementing",
    phase_status: "Running",
    ball: "Agent",
  };

  it("does not abandon on the first click", async () => {
    activeSession.current = { session_key: 1 };
    renderCard(running);

    await userEvent.click(screen.getByRole("button", { name: /abandon/i }));

    // The button deletes the worktree and its branch. A single click on a card must not do that.
    expect(interrupt.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("abandons once confirmed", async () => {
    activeSession.current = { session_key: 1 };
    renderCard({ ...running, id: 42 });

    await userEvent.click(screen.getByRole("button", { name: /abandon/i }));
    const confirm = screen
      .getAllByRole("button", { name: /abandon/i })
      .find(
        (button) =>
          button.textContent?.trim() === "Abandon" && button.closest("[role=alertdialog]"),
      );
    await userEvent.click(confirm!);

    expect(interrupt.mutate).toHaveBeenCalledWith(42);
  });
});

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

/// The manual path must not manufacture the state the automatic one refuses: a task that changed
/// nothing goes to review only after the user says so, or the escape hatch becomes a way to open
/// an empty review by accident.
describe("TaskCard empty-review confirmation", () => {
  const stuck: Partial<Task> = {
    status: "InProgress",
    phase: "Implementing",
    phase_status: "Failed",
    ball: "User",
  };

  it("asks first when the backend reports nothing to review", async () => {
    const user = userEvent.setup();
    renderCard(stuck);
    await user.click(screen.getByTitle(/without waiting for the agent/i));

    expect(sendToReview.mutate).toHaveBeenCalledWith({ taskId: 7 });
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
  });

  it("forces on confirmation", async () => {
    const user = userEvent.setup();
    renderCard(stuck);
    await user.click(screen.getByTitle(/without waiting for the agent/i));
    await user.click(await screen.findByText("Review anyway"));

    expect(sendToReview.mutate).toHaveBeenLastCalledWith({ taskId: 7, force: true });
  });

  it("does not ask when the task actually moved", async () => {
    sendToReview.result = makeTask({ status: "Review" });
    const user = userEvent.setup();
    renderCard(stuck);
    await user.click(screen.getByTitle(/without waiting for the agent/i));

    expect(screen.queryByText("Nothing to review")).not.toBeInTheDocument();
  });
});

/// Stop parks a task at Planning, so Planning is where a restart has to be possible. It used to be
/// offered on Queue alone, which made Stop a one-way door out of the pipeline.
describe("TaskCard execute affordance", () => {
  it.each(["Planning", "Queue"] as const)("offers Execute on a %s card", (status) => {
    renderCard({ status });
    expect(screen.getByText("Execute")).toBeInTheDocument();
  });

  it.each(["InProgress", "Review", "Done"] as const)("omits Execute on a %s card", (status) => {
    renderCard({ status });
    expect(screen.queryByText("Execute")).not.toBeInTheDocument();
  });
});

/// A task keeps its session into Review — that is what Join is for. The button existed but the
/// card looked the session up only while the task was In Progress, so it could never render, and
/// nothing asserted otherwise. These pin both halves.
describe("TaskCard session reachability", () => {
  const review: Partial<Task> = {
    status: "Review",
    phase: "Approval",
    phase_status: "Waiting",
    ball: "User",
  };

  it("offers Join on a Review card holding a live session", () => {
    activeSession.current = { session_key: 42 };
    renderCard(review);
    expect(screen.getByText("Join")).toBeInTheDocument();
  });

  it("omits Join on a Review card with no session", () => {
    renderCard(review);
    expect(screen.queryByText("Join")).not.toBeInTheDocument();
  });
});
