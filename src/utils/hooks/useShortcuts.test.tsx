import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { useShortcuts } from "./useShortcuts";

vi.mock("@/store/navigationStore", () => ({
  useActiveTab: () => "worktrees",
  useActiveTaskId: () => null,
}));

const refresh = vi.fn();

function Harness({ dialogOpen }: { dialogOpen: boolean }) {
  useShortcuts("worktrees", { "wt-refresh": refresh });
  return (
    <Dialog open={dialogOpen} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false}>
        <DialogTitle>Changes</DialogTitle>
        <button type="button">inside the dialog</button>
      </DialogContent>
    </Dialog>
  );
}

beforeEach(() => refresh.mockClear());

describe("useShortcuts", () => {
  it("fires a scoped shortcut from a window keypress", async () => {
    render(<Harness dialogOpen={false} />);
    await userEvent.keyboard("{Control>}r{/Control}");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  /**
   * The reason worktree and review dialogs handle Escape through `onOpenChange` rather than the
   * shortcut registry. base-ui's dialog claims the key before it reaches `window`, which is the
   * only place this hook listens — so an `Escape` entry in the registry is unreachable for as long
   * as its view is presented as a dialog, and looks like a working shortcut that silently is not.
   */
  it("cannot see Escape while a base-ui dialog is open", async () => {
    const seen: string[] = [];
    const spy = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener("keydown", spy);

    render(<Harness dialogOpen />);
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Control>}r{/Control}");
    window.removeEventListener("keydown", spy);

    // Control+R got through, so the listener itself is live — Escape specifically does not.
    expect(seen).toContain("r");
    expect(seen).not.toContain("Escape");
  });

  it("still sees other keys while a dialog is open", async () => {
    render(<Harness dialogOpen />);
    expect(screen.getByText("inside the dialog")).toBeTruthy();
    await userEvent.keyboard("{Control>}r{/Control}");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
