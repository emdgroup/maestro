import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LoopCheck, LoopIteration, Task, TaskComment } from "@/types/bindings";
import { LoopIterations, type CurrentState, type HeadActions } from "./LoopIterations";

vi.mock("@/components/execution/activity/MarkdownBlock", () => ({
  MarkdownBlock: ({ text }: { text: string }) => <div>{text}</div>,
}));

const task = {
  id: 8,
  project_id: 1,
  loop_config: { max_iterations: 12, max_build_secs: 1200 },
  loop_summary: { hold: "Paused" },
} as unknown as Task;

const check = (id: number, kind: LoopCheck["kind"], label: string, command?: string) =>
  ({ id, position: id, kind, label, command, proposed: false, accepted: false }) as LoopCheck;
const checks = [
  check(1, "Command", "Workspace compiles", "cargo check"),
  check(2, "Command", "Frontend tests pass", "bun run test"),
  check(3, "Judge", "One round trip"),
];

const iteration = (n: number, overrides: Partial<LoopIteration> = {}) =>
  ({
    n,
    attempt: 1,
    agent_id: "claude-code",
    started_at: `2026-10-19T10:0${n}:00Z`,
    ended_at: `2026-10-19T10:0${n}:30Z`,
    outcome: "Checked",
    counted: true,
    files: 2,
    added: 10,
    removed: 3,
    results: [],
    ...overrides,
  }) as LoopIteration;

const fifth = iteration(5, {
  summary: "## Done\nMoved reorder into the daemon.",
  results: [
    { check_id: 1, state: "Pass", detail: "Finished in 41s", command: "cargo check" },
    {
      check_id: 2,
      state: "Fail",
      detail: " FAIL rolls back\nTests 2 failed",
      command: "bun run test",
    },
  ],
});
const sixth = iteration(6, { outcome: "Running", ended_at: null, tokens: 96_000 });

const actions: HeadActions = {
  onJoin: null,
  onResume: () => {},
  onTick: () => {},
  onRerunChecks: () => {},
  onEditCheck: null,
  onReview: null,
};

describe("LoopIterations", () => {
  it("heads the timeline with the running iteration and what it works on", () => {
    const note = {
      id: 1,
      kind: "steer",
      body: "Trust the daemon's reply",
      created_at: "2026-10-19T10:05:40Z",
    } as TaskComment;
    const current: CurrentState = {
      iteration: sixth,
      head: { kind: "live", step: 0, activity: { status: "awaiting_input", since: Date.now() } },
    };
    render(
      <LoopIterations
        task={task}
        iterations={[fifth, sixth]}
        checks={checks}
        comments={[note]}
        current={current}
        actions={{ ...actions, onJoin: () => {} }}
      />,
    );
    expect(screen.getByText("#6")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Join to answer/ })).toBeTruthy();
    expect(screen.getByText("Pauses once this step ends")).toBeTruthy();
    expect(screen.getByText("96K tokens")).toBeTruthy();
    // #5 left the frontend tests failing, and the note was written before #6 started.
    expect(screen.getAllByText("Frontend tests pass").length).toBeGreaterThan(0);
    expect(screen.getByText("Tests 2 failed")).toBeTruthy();
    expect(screen.getByText("Trust the daemon's reply")).toBeTruthy();
    expect(screen.getByText("Earlier iterations")).toBeTruthy();
  });

  it("opens an earlier row on its checks, failed first and open, beside its outcome", async () => {
    render(
      <LoopIterations
        task={task}
        iterations={[fifth]}
        checks={checks}
        comments={[]}
        current={null}
        actions={actions}
      />,
    );
    expect(screen.getByText("Done")).toBeTruthy();
    const row = screen.getByRole("button", { expanded: false });
    expect(within(row).getByTitle("Frontend tests pass: fail")).toBeTruthy();
    expect(within(row).getByTitle("One round trip: not run")).toBeTruthy();

    await userEvent.click(row);
    const cards = screen.getAllByRole("button", { name: /Workspace compiles|Frontend tests pass/ });
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringContaining("Frontend tests pass"),
      expect.stringContaining("Workspace compiles"),
    ]);
    expect(screen.getByText("$ bun run test")).toBeTruthy();
    expect(screen.getByText("runs once every command passes")).toBeTruthy();
    expect(screen.getByText(/Moved reorder into the daemon/)).toBeTruthy();

    await userEvent.click(cards[1]);
    // Its last line heads the card, and the whole output opens under it.
    expect(screen.getAllByText("Finished in 41s")).toHaveLength(2);
  });

  it("says a failed commit is not the agent's failure, and shows git's reason", async () => {
    const refused = iteration(1, {
      outcome: "Failed",
      check_output: "The iteration's commit failed:\n✖ type must be one of [feat, fix]",
    });
    render(
      <LoopIterations
        task={task}
        iterations={[refused]}
        checks={checks}
        comments={[]}
        current={null}
        actions={actions}
      />,
    );
    expect(screen.getByText("commit failed")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/type must be one of/)).toBeTruthy();
  });

  it("leaves an interrupted attempt out of the history", () => {
    const cut = iteration(2, { outcome: "Interrupted", counted: false });
    const rerun = iteration(2, { attempt: 2 });
    render(
      <LoopIterations
        task={task}
        iterations={[iteration(1), cut, rerun]}
        checks={checks}
        comments={[]}
        current={null}
        actions={actions}
      />,
    );
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(2);
  });

  it("heads a paused loop with the iteration it stopped after, and hands the turn to the user", () => {
    render(
      <LoopIterations
        task={task}
        iterations={[iteration(4), fifth]}
        checks={checks}
        comments={[]}
        current={{ iteration: fifth, head: { kind: "halted", halt: "Paused" } }}
        actions={actions}
      />,
    );
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("1 of 2 commands pass")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText(/Resume starts #6/)).toBeTruthy();
    // #5 heads the timeline, so the history holds only #4.
    expect(screen.getAllByText("#5")).toHaveLength(1);
    expect(screen.getByText("#4")).toBeTruthy();
  });

  it("shows a flaky check under its card, with re-run and edit beside it", async () => {
    const onRerunChecks = vi.fn();
    const onEditCheck = vi.fn();
    const shaky = iteration(5, {
      results: [{ check_id: 2, state: "Flaky", detail: "passed on the second run", command: null }],
    });
    render(
      <LoopIterations
        task={task}
        iterations={[shaky]}
        checks={checks}
        comments={[]}
        current={{ iteration: shaky, head: { kind: "halted", halt: "Flaky" } }}
        actions={{ ...actions, onRerunChecks, onEditCheck }}
      />,
    );
    expect(screen.getByText('"Frontend tests pass" is flaky')).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Re-run checks/ }));
    await userEvent.click(screen.getByRole("button", { name: /Edit the check/ }));
    expect(onRerunChecks).toHaveBeenCalled();
    expect(onEditCheck).toHaveBeenCalled();
  });

  it("heads a finished loop with one line", () => {
    render(
      <LoopIterations
        task={{ ...task, status: "Done", loop_summary: { counted: 5, agent_secs: 2520 } } as Task}
        iterations={[fifth]}
        checks={checks}
        comments={[]}
        current={null}
        actions={actions}
      />,
    );
    expect(screen.getByText(/Done after 5 iterations and 42m/)).toBeTruthy();
    expect(screen.getByText("Earlier iterations")).toBeTruthy();
  });
});
