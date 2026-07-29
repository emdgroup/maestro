import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { MessageActionBar, relativeTime } from "./MessageActionBar";

const NOW = new Date("2026-07-29T12:00:00Z").getTime();

describe("relativeTime", () => {
  it("reads as just now under a minute", () => {
    expect(relativeTime(NOW, NOW)).toBe("just now");
    expect(relativeTime(NOW - 59_000, NOW)).toBe("just now");
  });

  it("counts minutes and hours past that", () => {
    expect(relativeTime(NOW - 2 * 60_000, NOW)).toBe("2 minutes ago");
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("about 3 hours ago");
  });

  it("treats a clock-skewed future stamp as just now, not negative", () => {
    expect(relativeTime(NOW + 5_000, NOW)).toBe("just now");
  });
});

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
