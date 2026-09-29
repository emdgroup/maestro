import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { TakeoverRequest } from "./ProjectTakeoverDialog";

const handlers = vi.hoisted(() => [] as Array<(event: { payload: TakeoverRequest }) => void>);
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_event: string, handler: (event: { payload: TakeoverRequest }) => void) => {
    handlers.push(handler);
    return Promise.resolve(() => {});
  },
}));

const answer = vi.hoisted(() => vi.fn());
vi.mock("@/services/project.service", () => ({
  useAnswerProjectTakeover: () => ({ mutate: answer }),
}));

import { ProjectTakeoverDialog } from "./ProjectTakeoverDialog";

const request: TakeoverRequest = {
  connection: { type: "local" },
  request_id: "takeover-1",
  project_path: "/work/maestro",
  requester_label: "laptop",
};

async function ask() {
  await act(async () => {
    await Promise.resolve();
  });
  act(() => handlers.forEach((handler) => handler({ payload: request })));
}

describe("ProjectTakeoverDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers.length = 0;
    answer.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("says who is asking and for what", async () => {
    render(<ProjectTakeoverDialog />);
    await ask();
    expect(screen.getByText(/Maestro on laptop wants maestro/)).toBeTruthy();
  });

  it.each([
    ["Keep", false],
    ["Give up", true],
  ])("%s answers the server with accept=%s", async (button, accept) => {
    render(<ProjectTakeoverDialog />);
    await ask();
    fireEvent.click(screen.getByText(button));
    expect(answer).toHaveBeenCalledWith({
      connection: request.connection,
      requestId: "takeover-1",
      accept,
    });
    expect(screen.queryByText(/Maestro on laptop/)).toBeNull();
  });

  it("counts down and closes without answering, leaving the timeout to the server", async () => {
    render(<ProjectTakeoverDialog />);
    await ask();
    expect(screen.getByText(/in 10s/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText(/in 7s/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(7000));
    expect(screen.queryByText(/Maestro on laptop/)).toBeNull();
    expect(answer).not.toHaveBeenCalled();
  });
});
