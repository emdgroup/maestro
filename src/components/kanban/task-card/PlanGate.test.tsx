import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanGate } from "./PlanGate";
import type { Task } from "@/types/bindings";

/// The plan lives in the outcome thread, and the gate reads the most recent one.
const comments = vi.hoisted(() => ({
  current: [{ id: 1, kind: "plan", body: "Touch `src/greet.js` and nothing else." }],
}));

vi.mock("@/services/task.service", () => ({
  useTaskCommentsQuery: () => ({ data: comments.current }),
}));

vi.mock("@/store/projectStore", () => ({
  useSelectedProject: () => ({ id: 1, path: "/tmp/demo" }),
}));

/// The plan body renders through the full markdown stack, which this test has no interest in.
vi.mock("@/components/execution/activity/MarkdownBlock", () => ({
  MarkdownBlock: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

function makeTask(): Task {
  return { id: 7, title: "Add a farewell function" } as Task;
}

const notes = () =>
  screen.getByPlaceholderText("Notes on the plan — leave empty to approve it as it stands");

describe("PlanGate", () => {
  /// A new plan is a new decision. The reset used to run from an effect, which the React Compiler
  /// flags and which paints one frame of the reopened gate still holding the last plan's notes —
  /// so this pins the behaviour the render-phase adjustment replaced it with.
  it("does not carry notes from one plan over into the next", async () => {
    const user = userEvent.setup();
    const props = {
      task: makeTask(),
      onOpenChange: vi.fn(),
      onApprove: vi.fn(),
      onReplan: vi.fn(),
    };

    const { rerender } = render(<PlanGate {...props} open={true} />);
    await user.type(notes(), "use the existing helper");
    expect(notes()).toHaveValue("use the existing helper");

    rerender(<PlanGate {...props} open={false} />);
    rerender(<PlanGate {...props} open={true} />);

    expect(notes()).toHaveValue("");
  });

  /// The button says which of the two things the notes have turned it into, because approving a
  /// plan the user has just written objections to is not something to offer.
  it("offers to refine rather than approve once there are notes", async () => {
    const user = userEvent.setup();
    const props = {
      task: makeTask(),
      open: true,
      onOpenChange: vi.fn(),
      onApprove: vi.fn(),
      onReplan: vi.fn(),
    };

    render(<PlanGate {...props} />);
    expect(screen.getByRole("button", { name: "Start implementing" })).toBeInTheDocument();

    await user.type(notes(), "not this way");

    expect(screen.getByRole("button", { name: "Refine plan" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refine plan" }));
    expect(props.onReplan).toHaveBeenCalledWith("not this way");
    expect(props.onApprove).not.toHaveBeenCalled();
  });
});
