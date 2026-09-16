import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const interruptAcpTurn = vi.hoisted(() => vi.fn<(sessionKey: number) => Promise<void>>());

vi.mock("@/lib/tauri-utils", () => ({
  api: {
    interruptAcpTurn: (sessionKey: number) => interruptAcpTurn(sessionKey),
    sendAcpPrompt: vi.fn().mockResolvedValue(undefined),
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

function render(overrides: Partial<Parameters<typeof useMessageSender>[0]> = {}): ReturnType<
  typeof renderHook<ReturnType<typeof useMessageSender>, void>
> & {
  autoResumeSpentRef: { current: boolean };
} {
  const autoResumeSpentRef = { current: false };
  const view = renderHook(() =>
    useMessageSender({
      sessionKey: 7,
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
      autoResumeSpentRef,
      isTurnActiveRef: { current: false },
      ...overrides,
    }),
  );
  return { ...view, autoResumeSpentRef };
}

beforeEach(() => {
  interruptAcpTurn.mockReset().mockResolvedValue(undefined);
});

describe("handleCancel", () => {
  it("marks auto-resume spent before the interrupt goes out", async () => {
    // Held open on purpose: the turn end that marks tool calls `interrupted` can land while the
    // interrupt request is still in flight, so setting the ref after the await would be too late.
    let release = () => {};
    interruptAcpTurn.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const { result, autoResumeSpentRef } = render();
    const cancelled = result.current.handleCancel();
    expect(autoResumeSpentRef.current).toBe(true);
    release();
    await cancelled;
  });

  it("marks auto-resume spent even when the interrupt call fails", async () => {
    interruptAcpTurn.mockRejectedValue(new Error("no session"));
    const { result, autoResumeSpentRef } = render();
    await result.current.handleCancel();
    expect(interruptAcpTurn).toHaveBeenCalledWith(7);
    expect(autoResumeSpentRef.current).toBe(true);
  });
});

describe("handleSend", () => {
  it("marks auto-resume spent when it cancels a turn to revise a plan", async () => {
    const { result, autoResumeSpentRef } = render({
      isProcessing: false,
      pendingPermission: planPermission,
    });
    const sent = result.current.handleSend("do it differently");
    // Synchronously: the cancel's turn end can land while this send is still waiting for it.
    expect(autoResumeSpentRef.current).toBe(true);
    await sent;
    expect(interruptAcpTurn).toHaveBeenCalledWith(7);
  });

  it("leaves auto-resume alone on an ordinary send", async () => {
    const { result, autoResumeSpentRef } = render({ isProcessing: false });
    await result.current.handleSend("hello");
    expect(interruptAcpTurn).not.toHaveBeenCalled();
    expect(autoResumeSpentRef.current).toBe(false);
  });
});
