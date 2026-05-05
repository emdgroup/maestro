import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardStore } from "./boardStore";

vi.mock("@/lib", () => ({
  api: {
    detachTerminal: vi.fn(),
  },
}));

function resetStore() {
  useBoardStore.setState({
    activeTerminalTaskId: null,
    isTerminalOpen: false,
  });
}

describe("boardStore – terminal state", () => {
  beforeEach(resetStore);

  it("openTerminal sets activeTerminalTaskId and isTerminalOpen", () => {
    useBoardStore.getState().openTerminal(5);
    const s = useBoardStore.getState();
    expect(s.activeTerminalTaskId).toBe(5);
    expect(s.isTerminalOpen).toBe(true);
  });

  it("initial state has no open terminal", () => {
    const s = useBoardStore.getState();
    expect(s.activeTerminalTaskId).toBeNull();
    expect(s.isTerminalOpen).toBe(false);
  });
});
