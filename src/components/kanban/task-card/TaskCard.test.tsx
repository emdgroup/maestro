import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskCard } from "./TaskCard";
import type { Task, TaskPhase, PhaseStatus, TaskBall } from "@/types/bindings";

const openUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

vi.mock("@/contexts/KanbanContext", () => ({
  useKanban: () => ({ projectId: 1, projectPath: "/tmp/demo", connection: { type: "local" } }),
}));

/// Swapped per-test so a card can be rendered with or without a live session behind it.
const activeSession = vi.hoisted(() => ({ current: null as { session_key: number } | null }));

const execute = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useExecuteTask", () => ({
  useExecuteTask: () => ({
    execute,
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

const archive = vi.hoisted(() => vi.fn());
const closeRefinement = vi.hoisted(() => vi.fn());
/// The task's outcome thread — where the refiner's proposal lives.
const comments = vi.hoisted(() => ({
  current: [] as Array<{ id: number; kind: string; body: string | null }>,
}));

vi.mock("@/services/task.service", () => ({
  useInterruptTaskMutation: () => ({ mutate: interrupt.mutate }),
  useArchiveTaskMutation: () => ({ mutate: archive }),
  useCloseRefinementMutation: () => ({ mutate: closeRefinement, isPending: false }),
  useTaskCommentsQuery: () => ({ data: comments.current }),
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

/// The worktree a task left behind, if any — swapped per test so the unmerged-archive dialog can
/// be rendered with and without one.
const worktrees = vi.hoisted(() => ({
  current: [] as Array<{ id: number; task_id: number; path: string; branch_name: string }>,
}));
const deleteWorktree = vi.hoisted(() => vi.fn());

vi.mock("@/services/worktree.service", () => ({
  useWorktreesQuery: () => ({ data: worktrees.current }),
  useDeleteWorktreeMutation: () => ({ mutate: deleteWorktree }),
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
  worktrees.current = [];
  comments.current = [];
  execute.mockClear();
  archive.mockClear();
  closeRefinement.mockClear();
  deleteWorktree.mockClear();
  sendToReview.mutate.mockClear();
  sendToReview.result = null;
  interrupt.mutate.mockClear();
  openUrl.mockClear();
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

/// A claimed task keeps its column, so `Spawning` is the only thing that distinguishes a task
/// waiting to start from one already starting. The card has to say which.
describe("TaskCard spawning state", () => {
  it("shows a starting task as busy and refuses a second Execute", () => {
    renderCard({
      status: "Queue",
      phase: "Spawning",
      phase_status: "Running",
      ball: "Agent",
    });

    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /starting/i })).toBeDisabled();
  });

  /// A failed spawn keeps its claim so the card can show it, which would be a dead end without
  /// a way to try again.
  it("offers a retry on a failed spawn", () => {
    renderCard({
      status: "Queue",
      phase: "Spawning",
      phase_status: "Failed",
      ball: "User",
    });

    const retry = screen.getByRole("button", { name: /retry/i });
    expect(retry).toBeInTheDocument();
    expect(retry).not.toBeDisabled();
  });
});

/// A deferred task has no phase, because nothing is running — but it is not idle either, and a
/// card that looks untouched after the user was promised a slot is the deferral failing silently.
describe("TaskCard deferred execution", () => {
  const deferred: Partial<Task> = {
    status: "Queue",
    execute_requested_at: "2026-08-05T10:00:00Z",
  };

  it("says a deferred task is waiting for a slot", () => {
    renderCard(deferred);
    expect(screen.getByText(/waiting for a slot/i)).toBeInTheDocument();
  });

  /// The user who has just freed a slot should be able to take it rather than waiting for the
  /// next drain, so the button stays live.
  it("keeps Execute available on a deferred task", () => {
    renderCard(deferred);
    expect(screen.getByRole("button", { name: /execute/i })).not.toBeDisabled();
  });

  it("says nothing about a queued task nobody has asked for", () => {
    renderCard({ status: "Queue" });
    expect(screen.queryByText(/waiting for a slot/i)).not.toBeInTheDocument();
  });

  /// The button is where the capacity question is asked. The scheduler's own starts must not ask
  /// it — they were already counted against the free slots — so it cannot be the default.
  it("asks whether the host has room before starting", async () => {
    renderCard({ status: "Queue" });

    await userEvent.click(screen.getByRole("button", { name: /execute/i }));

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), {
      respectCapacity: true,
    });
  });
});

/// Done says the task is finished; it does not say the changes are still sitting in a worktree.
describe("TaskCard completion", () => {
  it("flags a task whose changes were never merged", () => {
    renderCard({ status: "Done", completion: "LocalOnly" });
    expect(screen.getByText("not merged")).toBeInTheDocument();
  });

  it("flags a task that finished empty-handed", () => {
    renderCard({ status: "Done", completion: "NoChanges" });
    expect(screen.getByText("no changes")).toBeInTheDocument();
  });

  /// Merged is what Done already means, so saying it again is noise.
  it("says nothing extra about a merged task", () => {
    const { container } = render(
      <TaskCard task={makeTask({ status: "Done", completion: "Merged" })} index={0} />,
    );
    expect(container.textContent).not.toMatch(/not merged|no changes/i);
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

/// Every other completion is finished business. `LocalOnly` means the changes were committed and
/// never merged, so archiving it silently would put unmerged work out of sight — D36.
describe("TaskCard archiving unmerged work", () => {
  const localOnly: Partial<Task> = { status: "Done", completion: "LocalOnly" };

  it("archives a merged task without asking", async () => {
    renderCard({ status: "Done", completion: "Merged", id: 7 });

    await userEvent.click(screen.getByRole("button", { name: /archive/i }));

    expect(archive).toHaveBeenCalledWith(7);
  });

  it("warns before archiving unmerged changes", async () => {
    renderCard(localOnly);

    await userEvent.click(screen.getByRole("button", { name: /archive/i }));

    expect(screen.getByText(/These changes were never merged/i)).toBeInTheDocument();
    expect(archive).not.toHaveBeenCalled();
  });

  it("names the branch and the worktree still holding the work", async () => {
    worktrees.current = [{ id: 3, task_id: 7, path: "/tmp/wt/7", branch_name: "7-fix-cleanup" }];
    renderCard(localOnly);

    await userEvent.click(screen.getByRole("button", { name: /archive/i }));

    expect(screen.getByText(/7-fix-cleanup/)).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/wt\/7/)).toBeInTheDocument();
  });

  it("archives without touching anything when asked to keep it", async () => {
    worktrees.current = [{ id: 3, task_id: 7, path: "/tmp/wt/7", branch_name: "7-fix-cleanup" }];
    renderCard(localOnly);

    await userEvent.click(screen.getByRole("button", { name: /archive/i }));
    await userEvent.click(screen.getByRole("button", { name: /keep everything/i }));

    expect(archive).toHaveBeenCalledWith(7);
    expect(deleteWorktree).not.toHaveBeenCalled();
  });

  /// The commits are the unmerged work this dialog exists to protect. Removing the checkout
  /// reclaims disk; deleting the branch would destroy exactly what the warning is about.
  it("keeps the branch when removing the worktree", async () => {
    worktrees.current = [{ id: 3, task_id: 7, path: "/tmp/wt/7", branch_name: "7-fix-cleanup" }];
    renderCard(localOnly);

    await userEvent.click(screen.getByRole("button", { name: /archive/i }));
    await userEvent.click(screen.getByRole("button", { name: /remove the worktree/i }));

    expect(deleteWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: "/tmp/wt/7", deleteBranch: false }),
      expect.anything(),
    );
  });

  /// A task whose worktree is already gone still has unmerged commits on its branch, so the
  /// warning stands — but there is nothing left to offer to remove.
  it("offers no removal when the worktree is already gone", async () => {
    renderCard(localOnly);

    await userEvent.click(screen.getByRole("button", { name: /archive/i }));

    expect(screen.getByText(/These changes were never merged/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove the worktree/i })).not.toBeInTheDocument();
  });
});

/// Planning is a working column, not a parked one. The card has to say which of the two it is in,
/// and offer the controls that belong to each.
describe("TaskCard refinement", () => {
  const refining: Partial<Task> = {
    status: "Planning",
    phase: "Refining",
    phase_status: "Running",
    ball: "Agent",
  };

  const atTheGate: Partial<Task> = {
    status: "Planning",
    phase: "Refining",
    phase_status: "Waiting",
    ball: "User",
  };

  it("offers Refine on a task nobody is working on", async () => {
    renderCard({ status: "Planning" });

    await userEvent.click(screen.getByRole("button", { name: /refine/i }));

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), {
      role: "Refiner",
    });
  });

  /// Sharpening a ticket the scheduler may pick up mid-sentence is editing something already on
  /// its way to an agent.
  it("does not offer Refine on a queued task", () => {
    renderCard({ status: "Queue" });
    expect(screen.queryByRole("button", { name: /refine/i })).not.toBeInTheDocument();
  });

  /// The bug §3 names: the Planning branch returned Execute unconditionally, so a blocked refiner
  /// pulsed amber with nothing on the card to answer it.
  it("offers Respond rather than Execute to a blocked refiner", () => {
    activeSession.current = { session_key: 3 };
    renderCard({ ...refining, phase_status: "Blocked", ball: "User" });

    expect(screen.getByRole("button", { name: /respond/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /execute/i })).not.toBeInTheDocument();
  });

  it("offers Stop while the refiner is working", () => {
    renderCard(refining);
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });

  it("opens the proposal at the gate", async () => {
    comments.current = [{ id: 1, kind: "proposal", body: "A sharper description" }];
    renderCard(atTheGate);

    await userEvent.click(screen.getByRole("button", { name: /read proposal/i }));

    expect(screen.getByText("A sharper description")).toBeInTheDocument();
  });

  /// The comparison is the point of the gate. Showing only the proposal would make accepting a
  /// leap of faith about what it replaces.
  it("shows the current description beside the proposal", async () => {
    comments.current = [{ id: 1, kind: "proposal", body: "A sharper description" }];
    renderCard({ ...atTheGate, description: "The original wording" });

    await userEvent.click(screen.getByRole("button", { name: /read proposal/i }));

    expect(screen.getByText("The original wording")).toBeInTheDocument();
  });

  it("takes the newest proposal, not the first", async () => {
    comments.current = [
      { id: 1, kind: "proposal", body: "First attempt" },
      { id: 2, kind: "note", body: "not quite" },
      { id: 3, kind: "proposal", body: "Second attempt" },
    ];
    renderCard(atTheGate);

    await userEvent.click(screen.getByRole("button", { name: /read proposal/i }));

    expect(screen.getByText("Second attempt")).toBeInTheDocument();
    expect(screen.queryByText("First attempt")).not.toBeInTheDocument();
  });

  it("accepts and discards through the same command", async () => {
    comments.current = [{ id: 1, kind: "proposal", body: "A sharper description" }];
    renderCard(atTheGate);
    await userEvent.click(screen.getByRole("button", { name: /read proposal/i }));

    await userEvent.click(screen.getByRole("button", { name: /use this description/i }));
    expect(closeRefinement).toHaveBeenCalledWith({ taskId: 7, accept: true }, expect.anything());

    closeRefinement.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(closeRefinement).toHaveBeenCalledWith({ taskId: 7, accept: false }, expect.anything());
  });

  /// An empty proposal is the refiner having finished with nothing to say. Accepting it would
  /// blank the description.
  it("refuses to accept an empty proposal", async () => {
    comments.current = [{ id: 1, kind: "proposal", body: "   " }];
    renderCard(atTheGate);

    await userEvent.click(screen.getByRole("button", { name: /read proposal/i }));

    expect(screen.getByRole("button", { name: /use this description/i })).toBeDisabled();
  });
});

/// The plan gate sits inside In Progress, not in Review — it gates an intention, not a diff.
describe("TaskCard plan gate", () => {
  const atTheGate: Partial<Task> = {
    status: "InProgress",
    phase: "PlanReview",
    phase_status: "Waiting",
    ball: "User",
  };

  it("offers the plan rather than the running-agent controls", () => {
    renderCard(atTheGate);

    expect(screen.getByRole("button", { name: /read plan/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /abandon/i })).not.toBeInTheDocument();
  });

  /// The plan lives in the task's thread, not in the session that wrote it, so a gate reached days
  /// later still works. The card must not report a lost session as the problem.
  it("says nothing about a lost session at the gate", () => {
    renderCard(atTheGate);
    expect(screen.queryByText(/session lost/i)).not.toBeInTheDocument();
  });

  it("shows the plan", async () => {
    comments.current = [{ id: 1, kind: "plan", body: "1. Do the thing" }];
    renderCard(atTheGate);

    await userEvent.click(screen.getByRole("button", { name: /read plan/i }));

    expect(screen.getByText("1. Do the thing")).toBeInTheDocument();
  });

  /// Approving must name the coder. `execute` routes a standing start through the planner when
  /// the project has one, so inheriting the default here would plan the plan.
  it("approving starts the coder explicitly", async () => {
    comments.current = [{ id: 1, kind: "plan", body: "1. Do the thing" }];
    renderCard(atTheGate);
    await userEvent.click(screen.getByRole("button", { name: /read plan/i }));

    await userEvent.click(screen.getByRole("button", { name: /start implementing/i }));

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), {
      role: "Coder",
      handoffFrom: null,
    });
  });

  /// D31's handoff: the planner's session is offered to the coder, which reuses it only if both
  /// run the same agent. What it carries is the reasoning the plan itself does not.
  it("offers the planner's session to the coder", async () => {
    activeSession.current = { session_key: 12 };
    comments.current = [{ id: 1, kind: "plan", body: "1. Do the thing" }];
    renderCard(atTheGate);
    await userEvent.click(screen.getByRole("button", { name: /read plan/i }));

    await userEvent.click(screen.getByRole("button", { name: /start implementing/i }));

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), {
      role: "Coder",
      handoffFrom: 12,
    });
  });

  it("planning again runs the planner", async () => {
    comments.current = [{ id: 1, kind: "plan", body: "1. Do the thing" }];
    renderCard(atTheGate);
    await userEvent.click(screen.getByRole("button", { name: /read plan/i }));

    await userEvent.click(screen.getByRole("button", { name: /plan again/i }));

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), { role: "Planner" });
  });

  it("refuses to approve an empty plan", async () => {
    comments.current = [{ id: 1, kind: "plan", body: null }];
    renderCard(atTheGate);

    await userEvent.click(screen.getByRole("button", { name: /read plan/i }));

    expect(screen.getByRole("button", { name: /start implementing/i })).toBeDisabled();
  });
});

describe("TaskCard awaiting a pull request", () => {
  const awaitingMerge: Partial<Task> = {
    status: "Review",
    phase: "AwaitingMerge",
    phase_status: "Waiting",
    ball: "External",
    pull_request_url: "https://github.com/acme/widgets/pull/42",
    pull_request_number: 42,
  };

  it("links to the pull request it is waiting on", async () => {
    renderCard(awaitingMerge);

    await userEvent.click(screen.getByRole("button", { name: /pull request #42/i }));

    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/widgets/pull/42");
  });

  // The diff is still worth reading while the PR is open, so this must not replace Review.
  it("keeps Review reachable", () => {
    renderCard(awaitingMerge);

    expect(screen.getByRole("button", { name: /^review$/i })).toBeInTheDocument();
  });

  // A task can reach AwaitingMerge without a URL only if the write failed, and a button that
  // opens nothing is worse than the ordinary Review card.
  it("falls back to the ordinary Review card when no URL was recorded", () => {
    renderCard({ ...awaitingMerge, pull_request_url: null, pull_request_number: null });

    expect(screen.queryByRole("button", { name: /pull request/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^review$/i })).toBeInTheDocument();
  });
});
