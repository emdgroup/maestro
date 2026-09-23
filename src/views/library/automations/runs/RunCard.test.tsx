import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionInfo, AutomationRun } from "@/types/bindings";
import { RunCard } from "./RunCard";
import type { RunEntry } from "./runs";

const run = {
  id: "r",
  automation_id: "a",
  project_path: "/p",
  automation_name: "Nightly check",
  status: "succeeded",
  scheduled: true,
  started_at: new Date(0).toISOString(),
  finished_at: new Date(32_000).toISOString(),
  ordinal: 7,
} as AutomationRun;

function card(entry: Partial<RunEntry>) {
  const handlers = { onJoin: vi.fn(), onShow: vi.fn(), onDelete: vi.fn() };
  render(
    <RunCard
      entry={{
        run,
        state: "succeeded",
        live: undefined,
        action: "none",
        awaitingSince: undefined,
        ...entry,
      }}
      layout="card"
      now={60_000}
      {...handlers}
    />,
  );
  return handlers;
}

describe("RunCard", () => {
  it("opens a finished run's result, and deletes without opening it", () => {
    const { onShow, onDelete } = card({});
    fireEvent.click(screen.getByText("took 32s"));
    expect(onShow).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByLabelText("Delete this run"));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onShow).toHaveBeenCalledOnce();
  });

  it("gives a run waiting on the user a way in rather than a result", () => {
    const { onJoin, onShow } = card({
      run: { ...run, status: "running", finished_at: undefined },
      state: "awaiting",
      live: { session_id: "s" } as ActiveSessionInfo,
      awaitingSince: 50_000,
    });
    expect(screen.queryByLabelText("Delete this run")).toBeNull();
    fireEvent.click(screen.getByText("Answer"));
    expect(onJoin).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("waiting on you for 10s"));
    expect(onShow).not.toHaveBeenCalled();
  });
});
