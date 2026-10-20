import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LoopCheck, LoopIteration, Task, TaskComment } from "@/types/bindings";
import { LoopIterations, type CurrentState } from "./LoopIterations";

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
      step: 0,
      blocked: false,
      activity: { status: "awaiting_input", since: Date.now() },
    };
    render(
      <LoopIterations
        task={task}
        iterations={[fifth, sixth]}
        checks={checks}
        comments={[note]}
        current={current}
        onJoin={() => {}}
        onResume={() => {}}
      />,
    );
    expect(screen.getByText("#6")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Join to answer/ })).toBeTruthy();
    expect(screen.getByText("Pauses once this iteration ends")).toBeTruthy();
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
        onJoin={null}
        onResume={() => {}}
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
});
