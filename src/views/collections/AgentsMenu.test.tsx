import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsMenu } from "./AgentsMenu";

describe("AgentsMenu", () => {
  // A skill deployed to every agent leaves "Add agent" with nothing to list; that used to throw
  // and take the whole window down with it.
  it("opens with no agents to list", async () => {
    render(<AgentsMenu agents={[]} selected={[]} onToggle={vi.fn()} label="Add agent" />);
    await userEvent.click(screen.getByRole("button", { name: /add agent/i }));
    expect(await screen.findByText("No agents to choose from")).toBeTruthy();
  });
});
