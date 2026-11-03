import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { ThemeProvider, useTheme, type ThemeContextValue } from "./ThemeProvider";
import type { AppSettings } from "@/types/bindings";

const stored = vi.hoisted(() => ({ current: null as boolean | null }));
const detected = vi.hoisted(() => ({ current: false }));
const save = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@/lib/rendering", () => ({
  reduceMotionDefault: () => detected.current,
}));

vi.mock("@/services/settings.service", () => ({
  useSettings: () => ({
    data: {
      theme_preference: "light",
      updated_at: "2026-01-01T00:00:00Z",
      reduce_motion: stored.current,
    } satisfies AppSettings,
  }),
  useSaveSettings: () => ({ mutateAsync: save }),
}));

vi.mock("@/services/project.service", () => ({
  useProjectSettings: () => ({ data: undefined, isSuccess: false }),
  useSetProjectAccentColor: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/store/projectStore", () => ({ useSelectedProject: () => null }));

vi.mock("@/lib/tauri-utils", () => ({
  api: { getSystemAccentColor: () => Promise.resolve([0, 0, 255]) },
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));

/** Whether the root class every reduce-motion CSS rule hangs off is set. */
function reduceMotionApplied(): boolean {
  return document.documentElement.classList.contains("reduce-motion");
}

describe("ThemeProvider — reduce motion", () => {
  beforeEach(() => {
    stored.current = null;
    detected.current = false;
    save.mockClear();
    document.documentElement.classList.remove("reduce-motion");
  });

  it("follows the machine when nothing is stored", async () => {
    detected.current = true;
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    await waitFor(() => expect(reduceMotionApplied()).toBe(true));
  });

  it("leaves animation on when nothing is stored and the machine looks accelerated", async () => {
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    await waitFor(() => expect(reduceMotionApplied()).toBe(false));
  });

  /**
   * The rule the whole tri-state exists for, and the one a refactor to `||` would silently break:
   * the detection is a heuristic, so a user who has explicitly asked to keep the animation must
   * keep it even on a machine the heuristic wants to switch off.
   */
  it("lets an explicit off beat a machine the detection would switch on", async () => {
    stored.current = false;
    detected.current = true;
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    // Settle the mount effects, then assert the class was never applied.
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false));
    expect(reduceMotionApplied()).toBe(false);
  });

  it("honours an explicit on where the machine looks accelerated", async () => {
    stored.current = true;
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    await waitFor(() => expect(reduceMotionApplied()).toBe(true));
  });
});

describe("ThemeProvider, saving a setting", () => {
  beforeEach(() => {
    stored.current = null;
    detected.current = false;
    save.mockClear();
    document.documentElement.classList.remove("reduce-motion");
  });

  function Probe({ onValue }: { onValue: (value: ThemeContextValue) => void }) {
    onValue(useTheme());
    return null;
  }

  function renderWithContext() {
    const seen: { current: ThemeContextValue | null } = { current: null };
    render(
      <ThemeProvider>
        <Probe onValue={(value) => (seen.current = value)} />
      </ThemeProvider>,
    );
    return seen;
  }

  it("shows the choice at once", async () => {
    const seen = renderWithContext();
    await act(() => seen.current!.setUiScale("125"));
    expect(seen.current!.uiScale).toBe("125");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ ui_scale: "125" }));
  });

  // Every setting rolls back the same way; before, the accent and the scale stayed on screen.
  it("rolls every setting back when the save fails", async () => {
    save.mockImplementationOnce(() => Promise.reject(new Error("disk full")));
    const seen = renderWithContext();
    await act(() => seen.current!.setReduceMotion(true));
    expect(seen.current!.reduceMotion).toBe(false);
    expect(reduceMotionApplied()).toBe(false);

    save.mockImplementationOnce(() => Promise.reject(new Error("disk full")));
    await act(() => seen.current!.setGlobalAccentColor(145));
    expect(seen.current!.globalAccentHue).toBeNull();
  });
});
