import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { useActivityStatusManager } from "./useActivityStatusManager";
import { useSessionActivityStore } from "@/store/sessionActivityStore";
import type { ActivityItem, ActivityState } from "../activity/types";

const SESSION_KEY = 1;

const userMessage: ActivityItem = {
  type: "userMessage",
  item: { id: "u1", content: "do the thing", sentAt: 0 },
};

type LiveState = Pick<ActivityState, "items" | "isInitializing" | "isTurnActive" | "sessionEnded">;

function setup(overrides: Partial<LiveState> = {}, awaitingUserInput = false) {
  const liveState: LiveState = {
    items: [],
    isInitializing: false,
    isTurnActive: false,
    sessionEnded: false,
    ...overrides,
  };
  const pendingSendRef = { current: false };
  return renderHook(() =>
    useActivityStatusManager(SESSION_KEY, liveState, pendingSendRef, awaitingUserInput),
  );
}

function status() {
  return useSessionActivityStore.getState().sessions[SESSION_KEY]?.status;
}

describe("useActivityStatusManager", () => {
  beforeEach(() => {
    useSessionActivityStore.setState({ sessions: {} });
  });

  it("stays busy while a turn is active and the agent has not spoken yet", () => {
    // Agents that omit thinking text leave the user message as the tail for the whole
    // reasoning phase — reporting idle there would re-enable the compose bar mid-turn.
    setup({ items: [userMessage], isTurnActive: true });
    expect(status()).toBe("thinking");
  });

  it("reports awaiting_input while a permission or elicitation request is pending", () => {
    // The suppressed AskUserQuestion tool_call still rebuilds `items` after the
    // elicitation event lands — the tail must not win over the pending request.
    setup({ items: [userMessage], isTurnActive: true }, true);
    expect(status()).toBe("awaiting_input");
  });

  it("reports idle once the turn ends", () => {
    setup({ items: [userMessage], isTurnActive: false });
    expect(status()).toBe("idle");
  });
});
