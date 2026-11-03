import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ConnectionKey } from "@/types/bindings";
import { useBoardStore } from "@/store/boardStore";
import type { ActivityItem, UserMessageItem } from "../activity/types";
import { useAgentAuthFlow } from "./useAgentAuthFlow";

const handlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("@/services/tauri-events", () => ({
  useTauriEvent: (name: string | null, handler: (payload: unknown) => void) => {
    if (name) handlers.set(name, handler);
  },
}));

const local: ConnectionKey = { type: "local" };
const refused = { type: "error", item: { stopReason: "auth_required" } } as unknown as ActivityItem;
const asked = { id: "u1", content: "fix the build" } as unknown as UserMessageItem;

function flow(overrides: Partial<Parameters<typeof useAgentAuthFlow>[0]> = {}) {
  const resend = vi.fn();
  const hook = renderHook(
    (props: Parameters<typeof useAgentAuthFlow>[0]) => useAgentAuthFlow(props),
    {
      initialProps: {
        sessionId: "s1",
        agentId: "claude-code",
        connection: local,
        taskId: null,
        items: [],
        lastUserMessage: null,
        terminalIds: [],
        resend,
        ...overrides,
      },
    },
  );
  return { ...hook, resend };
}

const entry = (key: string) => useBoardStore.getState().authRequiredTasks[key];

describe("useAgentAuthFlow", () => {
  beforeEach(() => {
    handlers.clear();
    useBoardStore.setState({ authRequiredTasks: {}, pendingSessionRetry: null });
  });

  it("records a refusal in the stream under the task, with the prompt it refused", () => {
    const { result } = flow({ taskId: 7, items: [refused], lastUserMessage: asked });
    expect(result.current.authKey).toBe("7");
    expect(entry("7")).toMatchObject({ agentId: "claude-code", lastPrompt: "fix the build" });
    expect(result.current.openSignIn).toBeDefined();
  });

  it("offers no sign-in while the agent has not refused", () => {
    const { result } = flow();
    expect(result.current.openSignIn).toBeUndefined();
    expect(entry("s1")).toBeUndefined();
  });

  it("offers the sign-in when the spawn itself was refused", () => {
    const { result } = flow();
    act(() => handlers.get("acp://session-error/s1")?.("auth_required"));
    expect(entry("s1")).toMatchObject({ agentId: "claude-code", lastPrompt: null });
    expect(result.current.openSignIn).toBeDefined();
  });

  it("marks the sign-in interrupted once its terminal's tab is gone", () => {
    const { rerender, resend } = flow({ terminalIds: ["auth-terminal-1"] });
    act(() => {
      useBoardStore.getState().setAuthRequired("s1", "claude-code", local, null);
      useBoardStore.getState().setAuthTerminalRunning("s1", "auth-terminal-1");
    });
    const props = {
      sessionId: "s1",
      agentId: "claude-code",
      connection: local,
      taskId: null,
      items: [],
      lastUserMessage: null,
      resend,
    };
    rerender({ ...props, terminalIds: ["auth-terminal-1"] });
    expect(entry("s1").terminalState).toBe("running");
    rerender({ ...props, terminalIds: [] });
    expect(entry("s1").terminalState).toBe("interrupted");
  });

  it("resends the refused prompt once signed in", () => {
    const { result, resend } = flow({ taskId: 7, items: [refused], lastUserMessage: asked });
    act(() => result.current.openSignIn?.());
    expect(result.current.modal.open).toBe(true);
    act(() => result.current.modal.onAuthSuccess());
    expect(resend).toHaveBeenCalledWith("fix the build");
    expect(result.current.modal.open).toBe(false);
    expect(entry("7")).toBeUndefined();
  });

  it("respawns a manual session that never got a prompt in", () => {
    const { result, resend } = flow();
    act(() => handlers.get("acp://session-error/s1")?.("auth_required"));
    act(() => result.current.modal.onAuthSuccess());
    expect(resend).not.toHaveBeenCalled();
    expect(useBoardStore.getState().pendingSessionRetry).toEqual({
      sessionId: "s1",
      lastPrompt: null,
    });
    expect(result.current.openSignIn).toBeUndefined();
  });
});
