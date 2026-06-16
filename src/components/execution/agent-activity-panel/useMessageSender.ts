import React, { useCallback, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessionActivityActions } from "@/store/sessionActivityStore";
import { api } from "@/lib/tauri-utils";
import { isPlanPermission, isAllowKind } from "../activity/PermissionPrompt";
import type { ActivityAction } from "../activity/useAcpActivity";
import type { JsonValue } from "@/types/bindings";
import type { ComposeBarHandle } from "../activity/compose-bar/ComposeBar";

type PendingPermission = { requestId: string; payload: Record<string, unknown> };
type PendingElicitation = { requestId: string; message: string; payload: Record<string, unknown> };

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
}): {
  handleSend: (content: string, contentBlocks?: JsonValue) => Promise<void>;
  handleCancel: () => Promise<void>;
  handleSendWithTransition: (content: string, contentBlocks?: JsonValue) => void;
} {
  const { setActivity } = useSessionActivityActions();

  const handleSend = useCallback(
    async (content: string, contentBlocks?: JsonValue) => {
      if (isProcessing) return;
      if (pendingPermission && isPlanPermission(pendingPermission.payload)) {
        const options = pendingPermission.payload.options as
          | Array<{ optionId: string; kind: string }>
          | undefined;
        const rejectOpt = options?.find((o) => !isAllowKind(o.kind));
        await handlePermissionRespond(pendingPermission.requestId, rejectOpt?.optionId ?? null);
      }
      liveDispatch({ type: "finalize_streaming" });
      setActivity(sessionKey, "thinking");
      try {
        if (contentBlocks) {
          await api.sendAcpPromptStructured(sessionKey, contentBlocks);
        } else {
          await api.sendAcpPrompt(sessionKey, content);
        }
      } catch {
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
    ],
  );

  const handleCancel = useCallback(async () => {
    try {
      await api.interruptAcpTurn(sessionKey);
    } catch {
      setActivity(sessionKey, "idle");
    }
  }, [sessionKey, setActivity]);

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
