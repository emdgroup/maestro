import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ALL_AGENTS, AgentsDialog } from "./AgentsDialog";

describe("AgentsDialog", () => {
  const agents = [
    { id: "claude-acp", name: "Claude", icon: "" },
    { id: "codex", name: "Codex", icon: "" },
    { id: "auggie", name: "Auggie", icon: "" },
  ];
  const open = (onConfirm: (value: string[]) => void, value = [ALL_AGENTS]) =>
    render(
      <AgentsDialog
        open
        onOpenChange={vi.fn()}
        name="my-skill"
        agents={agents}
        supported={["claude-acp", "codex"]}
        value={value}
        confirmLabel="Save"
        onConfirm={onConfirm}
      />,
    );

  it("unticking one agent out of every agent keeps the other supported ones", async () => {
    const onConfirm = vi.fn();
    open(onConfirm);
    expect(screen.getByRole("checkbox", { name: /auggie/i }).hasAttribute("data-disabled")).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: /claude/i }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onConfirm).toHaveBeenLastCalledWith(["codex"]);
  });

  it("goes back to every agent", async () => {
    const onConfirm = vi.fn();
    open(onConfirm, ["codex"]);
    await userEvent.click(screen.getByRole("checkbox", { name: /every agent/i }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onConfirm).toHaveBeenLastCalledWith([ALL_AGENTS]);
  });
});
