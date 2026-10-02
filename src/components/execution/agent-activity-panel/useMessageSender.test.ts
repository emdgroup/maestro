import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const interruptAcpTurn = vi.hoisted(() => vi.fn<(sessionId: string) => Promise<void>>());
const respondHostTool = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const sendAcpPrompt = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/lib/tauri-utils", () => ({
  api: {
    interruptAcpTurn: (sessionId: string) => interruptAcpTurn(sessionId),
    sendAcpPrompt: (sessionId: string, content: string) => sendAcpPrompt(sessionId, content),
    respondHostTool: (sessionId: string, requestId: string, value: unknown) =>
      respondHostTool(sessionId, requestId, value),
    sendAcpPromptStructured: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: () => Promise.resolve(() => {}) }),
}));

import { useMessageSender } from "./useMessageSender";

/** The plan tool call shape `isPlanPermission` recognises. */
const planPermission = {
  requestId: "req-1",
  payload: { toolCall: { toolCallId: "tc-1", kind: "switch_mode" } },
};

function render(overrides: Partial<Parameters<typeof useMessageSender>[0]> = {}) {
  return renderHook(() =>
    useMessageSender({
      sessionId: "7",
      isProcessing: true,
      pendingPermission: null,
      pendingElicitation: null,
      handlePermissionRespond: vi.fn().mockResolvedValue(undefined),
      liveDispatch: vi.fn(),
      isSelected: false,
      isInitializing: false,
      sessionEnded: false,
      composeBarRef: { current: null },
      isCenteredCompose: false,
      onCenteredTransition: vi.fn(),
      pendingSendRef: { current: false },
      isTurnActiveRef: { current: false },
      pendingCanvasAwaitsRef: { current: [] },
      ...overrides,
    }),
  );
}

beforeEach(() => {
  interruptAcpTurn.mockReset().mockResolvedValue(undefined);
  respondHostTool.mockReset().mockResolvedValue(undefined);
  sendAcpPrompt.mockReset().mockResolvedValue(undefined);
});

describe("handleCancel", () => {
  it("interrupts the turn even when the call fails", async () => {
    interruptAcpTurn.mockRejectedValue(new Error("no session"));
    const { result } = render();
    await result.current.handleCancel();
    expect(interruptAcpTurn).toHaveBeenCalledWith("7");
  });
});

describe("handleSend", () => {
  it("cancels the turn to revise a plan", async () => {
    const { result } = render({ isProcessing: false, pendingPermission: planPermission });
    await result.current.handleSend("do it differently");
    expect(interruptAcpTurn).toHaveBeenCalledWith("7");
    expect(sendAcpPrompt).toHaveBeenCalledWith("7", "do it differently");
  });

  it("sends an ordinary message without interrupting", async () => {
    const { result } = render({ isProcessing: false });
    await result.current.handleSend("hello");
    expect(interruptAcpTurn).not.toHaveBeenCalled();
  });

  // An agent that keeps `canvas_await` armed is "busy" for as long as the user leaves the surface
  // alone. Without this the compose bar would be dead for exactly as long.
  it("ends an open canvas wait rather than refusing to send", async () => {
    const { result } = render({
      isProcessing: true,
      pendingCanvasAwaitsRef: { current: [{ requestId: "w-1", surfaceId: "match" }] },
    });
    await result.current.handleSend("stop that and look at this");
    expect(interruptAcpTurn).toHaveBeenCalledWith("7");
    expect(respondHostTool).toHaveBeenCalledWith("7", "w-1", { timeout: true });
    expect(sendAcpPrompt).toHaveBeenCalledWith("7", "stop that and look at this");
  });

  it("still refuses to send while the agent is genuinely working", async () => {
    const { result } = render({ isProcessing: true });
    await result.current.handleSend("hello");
    expect(interruptAcpTurn).not.toHaveBeenCalled();
    expect(sendAcpPrompt).not.toHaveBeenCalled();
  });
});
