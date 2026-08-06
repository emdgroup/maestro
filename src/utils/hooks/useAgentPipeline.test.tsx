import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Task } from "@/types/bindings";

const execute = vi.hoisted(() => vi.fn<(task: Task, opts: unknown) => Promise<void>>());

vi.mock("@/utils/hooks/useExecuteTask", () => ({
  useExecuteTask: () => ({ execute }),
}));

import { useAgentPipeline } from "./useAgentPipeline";

function makeTask(overrides: Partial<Task>): Task {
  return { id: 1, title: "t", status: "Review", ...overrides } as Task;
}

const pendingReview = makeTask({
  id: 5,
  status: "Review",
  phase: "SelfReview",
  phase_status: "Waiting",
  ball: "Agent",
});

const pendingRework = makeTask({
  id: 6,
  status: "InProgress",
  phase: "Rework",
  phase_status: "Waiting",
  ball: "Agent",
});

function render(tasks: Task[]) {
  return renderHook(
    ({ list }: { list: Task[] }) =>
      useAgentPipeline(7, "/tmp/demo", list, { type: "local" } as Parameters<
        typeof useAgentPipeline
      >[3]),
    { initialProps: { list: tasks } },
  );
}

async function settle() {
  await vi.advanceTimersByTimeAsync(500);
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  execute.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentPipeline", () => {
  it("starts a reviewer for work waiting on one", async () => {
    render([pendingReview]);
    await settle();

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), { role: "Reviewer" });
  });

  it("starts a coder for a rejected review", async () => {
    render([pendingRework]);
    await settle();

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 6 }), { role: "Coder" });
  });

  // The signal is Waiting + Agent, and nothing else. A gate waiting on a person must never start
  // an agent — that is the whole difference between a handoff and a review the user owns.
  it("leaves anything waiting on the user alone", async () => {
    render([
      makeTask({ id: 1, phase: "Approval", phase_status: "Waiting", ball: "User" }),
      makeTask({ id: 2, phase: "Rework", phase_status: "Waiting", ball: "User" }),
      makeTask({ id: 3, phase: "PlanReview", phase_status: "Waiting", ball: "User" }),
      makeTask({ id: 4, phase: "SelfReview", phase_status: "Running", ball: "Agent" }),
      makeTask({ id: 8, phase: "AwaitingMerge", phase_status: "Waiting", ball: "External" }),
    ]);
    await settle();

    expect(execute).not.toHaveBeenCalled();
  });

  // The task's state does not change until the session is up, so a second render inside that
  // window would otherwise start the same agent twice — and pay for it twice.
  it("does not start the same agent twice while it is coming up", async () => {
    const { rerender } = render([pendingReview]);
    await settle();
    expect(execute).toHaveBeenCalledTimes(1);

    rerender({ list: [pendingReview] });
    await settle();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  // Round two has to be able to start, or the loop would stop after one pass regardless of the cap.
  it("starts again once the task has moved on and come back", async () => {
    const { rerender } = render([pendingReview]);
    await settle();
    execute.mockClear();

    rerender({ list: [makeTask({ ...pendingReview, phase_status: "Running" })] });
    await settle();
    rerender({ list: [pendingReview] });
    await settle();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a project", async () => {
    renderHook(() =>
      useAgentPipeline(null, "/tmp/demo", [pendingReview], { type: "local" } as Parameters<
        typeof useAgentPipeline
      >[3]),
    );
    await settle();

    expect(execute).not.toHaveBeenCalled();
  });
});
