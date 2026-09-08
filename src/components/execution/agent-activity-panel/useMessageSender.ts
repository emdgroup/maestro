import React, { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessionActivityActions } from "@/store/sessionActivityStore";
import { api } from "@/lib/tauri-utils";
import { isPlanPermission } from "../activity/PermissionPrompt";
import type { ActivityAction } from "../activity/useAcpActivity";
import type { JsonValue } from "@/types/bindings";
import type { ComposeBarHandle } from "../activity/compose-bar/ComposeBar";

type PendingPermission = { requestId: string; payload: Record<string, unknown> };
type PendingElicitation = { requestId: string; message: string; payload: Record<string, unknown> };

/** How long to wait for a cancelled turn to actually end before prompting anyway. */
const TURN_END_TIMEOUT_MS = 3000;
const TURN_END_POLL_MS = 50;

/**
 * Resolves once the agent reports the turn over, or when the wait runs out.
 *
 * The ceiling matters more than the precision: a wedged agent never answers a cancel, and losing
 * the user's notes to that is worse than sending them a beat early.
 */
function waitForTurnEnd(isTurnActiveRef: React.RefObject<boolean>): Promise<void> {
  if (!isTurnActiveRef.current) return Promise.resolve();
  return new Promise((resolve) => {
    const deadline = Date.now() + TURN_END_TIMEOUT_MS;
    const id = setInterval(() => {
      if (!isTurnActiveRef.current || Date.now() >= deadline) {
        clearInterval(id);
        resolve();
      }
    }, TURN_END_POLL_MS);
  });
}

export function useMessageSender({
  sessionKey,
  isProcessing,
  pendingPermission,
  pendingElicitation,
  handlePermissionRespond,
  liveDispatch,
  isSelected,
  isInitializing,
  sessionEnded,
  composeBarRef,
  isCenteredCompose,
  onCenteredTransition,
  pendingSendRef,
  isTurnActiveRef,
}: {
  sessionKey: number;
  isProcessing: boolean;
  pendingPermission: PendingPermission | null;
  pendingElicitation: PendingElicitation | null;
  handlePermissionRespond: (requestId: string, optionId: string | null) => Promise<void>;
  liveDispatch: React.Dispatch<ActivityAction>;
  isSelected: boolean;
  isInitializing: boolean;
  sessionEnded: boolean;
  composeBarRef: React.RefObject<ComposeBarHandle | null>;
  isCenteredCompose: boolean;
  onCenteredTransition: () => void;
  pendingSendRef: MutableRefObject<boolean>;
  /** Mirrors `liveState.isTurnActive`, so a send can wait for a cancelled turn to finish. */
  isTurnActiveRef: React.RefObject<boolean>;
}): {
  handleSend: (content: string, contentBlocks?: JsonValue) => Promise<void>;
  handleCancel: () => Promise<void>;
  handleSendWithTransition: (content: string, contentBlocks?: JsonValue) => void;
} {
  const { setActivity } = useSessionActivityActions();
  const cancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (cancelTimerRef.current != null) clearTimeout(cancelTimerRef.current);
    };
  }, []);

  const handleSend = useCallback(
    async (content: string, contentBlocks?: JsonValue) => {
      if (isProcessing) return;
      // Revising a plan. The agent is blocked inside `session/request_permission`, which is inside
      // its turn, so the prompt cannot simply go out: ACP only sanctions another `session/prompt`
      // once a turn completes, and `maestro-server` does not serialise them — a second one would
      // race the first (see command_loop.rs, SessionCommand::Prompt).
      //
      // The protocol's answer is `session/cancel`, which requires every pending permission request
      // to be answered `cancelled`. Cancel first, so the agent is not unblocked into carrying on
      // before the cancel lands, then wait for the turn to actually end.
      if (pendingPermission && isPlanPermission(pendingPermission.payload)) {
        try {
          await api.interruptAcpTurn(sessionKey);
        } catch {
          // Best-effort: answering the request below still unblocks the agent.
        }
        // `null` is what maestro-server maps to RequestPermissionOutcome::Cancelled.
        await handlePermissionRespond(pendingPermission.requestId, null);
        await waitForTurnEnd(isTurnActiveRef);
      }
      liveDispatch({ type: "finalize_streaming" });
      pendingSendRef.current = true;
      setActivity(sessionKey, "thinking");
      try {
        if (contentBlocks) {
          await api.sendAcpPromptStructured(sessionKey, contentBlocks);
        } else {
          await api.sendAcpPrompt(sessionKey, content);
        }
      } catch {
        pendingSendRef.current = false;
        setActivity(sessionKey, "idle");
      }
    },
    [
      isProcessing,
      sessionKey,
      liveDispatch,
      setActivity,
      pendingPermission,
      handlePermissionRespond,
      pendingSendRef,
      isTurnActiveRef,
    ],
  );

  const handleCancel = useCallback(async () => {
    try {
      await api.interruptAcpTurn(sessionKey);
      // A cancel is only answered if the agent honours it, or if maestro-server
      // is new enough to synthesize a TurnEnded when no turn is in flight. The
      // deployed server binary is per project and can lag the app, and a wedged
      // agent answers nothing at all — so keep a client-side escape hatch.
      // Dispatching turn_ended when isTurnActive is already false is harmless.
      if (cancelTimerRef.current != null) clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = setTimeout(() => {
        cancelTimerRef.current = null;
        liveDispatch({ type: "turn_ended" });
      }, 3000);
    } catch {
      liveDispatch({ type: "turn_ended" });
      setActivity(sessionKey, "idle");
    }
  }, [sessionKey, setActivity, liveDispatch]);

  const handleSendWithTransition = useCallback(
    (content: string, contentBlocks?: JsonValue) => {
      if (isCenteredCompose) onCenteredTransition();
      void handleSend(content, contentBlocks);
    },
    [isCenteredCompose, onCenteredTransition, handleSend],
  );

  // Focus compose bar when panel becomes selected and ready
  useEffect(() => {
    if (isInitializing || pendingPermission || pendingElicitation) return;
    if (!isSelected) return;
    const timer = setTimeout(() => composeBarRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isSelected, isInitializing, pendingPermission, pendingElicitation, composeBarRef]);

  // Re-focus compose bar when window regains focus
  useEffect(() => {
    if (!isSelected || sessionEnded) return;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused || isInitializing || pendingPermission || pendingElicitation) return;
      requestAnimationFrame(() => composeBarRef.current?.focus());
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [
    isSelected,
    sessionEnded,
    isInitializing,
    pendingPermission,
    pendingElicitation,
    composeBarRef,
  ]);

  return { handleSend, handleCancel, handleSendWithTransition };
}
