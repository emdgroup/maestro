import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { MessageActionBar } from "./MessageActionBar";

describe("MessageActionBar", () => {
  afterEach(() => vi.useRealTimers());

  // Regression: the label used to come from a Date.now() call in render while the
  // useSyncExternalStore return value was discarded, so it froze on its first value.
  it("ages the label without a re-render from the parent", async () => {
    vi.useFakeTimers();
    render(<MessageActionBar copyText="hi" sentAt={Date.now()} />);
    expect(screen.getByText("just now")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(121_000);
    });

    expect(screen.queryByText("just now")).toBeNull();
    expect(screen.getByText("2 minutes ago")).toBeTruthy();
  });

  it("starts from a fresh clock when it mounts long after the last tick", async () => {
    vi.useFakeTimers();
    const sentAt = Date.now();
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    render(<MessageActionBar copyText="hi" sentAt={sentAt} />);

    expect(screen.getByText("10 minutes ago")).toBeTruthy();
  });
});
