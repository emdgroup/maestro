import React, { useCallback, useEffect, useState } from "react";
import { useSessionActivityActions } from "@/store/sessionActivityStore";
import { api } from "@/lib/tauri-utils";
import { isPlanPermission } from "../activity/PermissionPrompt";
import { isRejectOption, getOptionName, formatFieldAnswer } from "../activity/utils";
import { parseElicitationFields } from "../activity/ElicitationPrompt";
import type { PermissionResponseItem, ElicitationSummaryItem } from "../activity/types";

type PendingPermission = { requestId: string; payload: Record<string, unknown> };
type PendingElicitation = { requestId: string; message: string; payload: Record<string, unknown> };

export type PermissionHandlers = {
  handlePermissionRespond: (requestId: string, optionId: string | null) => Promise<void>;
  handleElicitationSubmit: (requestId: string, values: Record<string, unknown>) => Promise<void>;
  handleElicitationDecline: (requestId: string) => Promise<void>;
  livePermissionResponses: Array<{
    item: PermissionResponseItem;
    insertAt: number;
    requestId: string;
  }>;
  liveElicitationSummaries: Array<{ item: ElicitationSummaryItem; insertAt: number }>;
  showPlanOverlay: boolean;
  setShowPlanOverlay: React.Dispatch<React.SetStateAction<boolean>>;
};

export function usePermissionHandlers(
  sessionKey: number,
  agentItemsCountRef: React.RefObject<number>,
  pendingPermission: PendingPermission | null,
  setPendingPermission: React.Dispatch<React.SetStateAction<PendingPermission | null>>,
  pendingElicitation: PendingElicitation | null,
  setPendingElicitation: React.Dispatch<React.SetStateAction<PendingElicitation | null>>,
  isPlanPermWithBody: boolean,
): PermissionHandlers {
  const { setActivity } = useSessionActivityActions();
  const [liveElicitationSummaries, setLiveElicitationSummaries] = useState<
    Array<{ item: ElicitationSummaryItem; insertAt: number }>
  >([]);
  const [livePermissionResponses, setLivePermissionResponses] = useState<
    Array<{ item: PermissionResponseItem; insertAt: number; requestId: string }>
  >([]);

  const [showPlanOverlay, setShowPlanOverlay] = useState(false);

  const handlePermissionRespond = useCallback(
    async (requestId: string, optionId: string | null) => {
      try {
        await api.respondAcpPermission(sessionKey, requestId, optionId);
      } catch {
        // best-effort
      }
      if (pendingPermission) {
        const isRejection = !optionId || isRejectOption(pendingPermission.payload, optionId);
        if (!isPlanPermission(pendingPermission.payload)) {
          const responseItem: PermissionResponseItem = {
            id: `perm-${requestId}`,
            optionName:
              getOptionName(pendingPermission.payload, optionId) ??
              (isRejection ? "Permission denied" : "Allowed"),
            isRejection,
          };
          const insertAt = agentItemsCountRef.current;
          setLivePermissionResponses((prev) => [
            ...prev,
            { item: responseItem, insertAt, requestId },
          ]);
        }
      }
      setShowPlanOverlay(false);
      setPendingPermission(null);
      setActivity(sessionKey, "thinking");
    },
    [sessionKey, pendingPermission, setPendingPermission, setActivity, agentItemsCountRef],
  );

  // Auto-respond plan permissions that have no body text to display
  useEffect(() => {
    if (!pendingPermission || !isPlanPermission(pendingPermission.payload)) return;
    if (isPlanPermWithBody) return;
    const options = pendingPermission.payload.options as
      | Array<{ optionId: string; kind: string }>
      | undefined;
    const allowOpt = options?.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
    if (allowOpt) {
      void handlePermissionRespond(pendingPermission.requestId, allowOpt.optionId);
    }
  }, [pendingPermission, isPlanPermWithBody, handlePermissionRespond]);

  const handleElicitationSubmit = useCallback(
    async (requestId: string, values: Record<string, unknown>) => {
      try {
        await api.respondAcpElicitation(sessionKey, requestId, {
          action: "accept",
          content: values,
        } as never);
      } catch {
        /* best-effort */
      }
      if (pendingElicitation) {
        const insertAt = agentItemsCountRef.current;
        const { message, payload } = pendingElicitation;
        const { fields: parsedFields } = parseElicitationFields(payload);
        const fieldSummaries = parsedFields.map((f) => ({
          key: f.key,
          question: f.description ?? f.title ?? f.key,
          answer: formatFieldAnswer(values[f.key]),
        }));
        setLiveElicitationSummaries((prev) => [
          ...prev,
          {
            item: {
              id: `elicit-${requestId}`,
              message,
              declined: false,
              fields: fieldSummaries,
            },
            insertAt,
          },
        ]);
      }
      setPendingElicitation(null);
      setActivity(sessionKey, "thinking");
    },
    [sessionKey, pendingElicitation, setPendingElicitation, setActivity, agentItemsCountRef],
  );

  const handleElicitationDecline = useCallback(
    async (requestId: string) => {
      try {
        await api.respondAcpElicitation(sessionKey, requestId, { action: "decline" });
      } catch {
        /* best-effort */
      }
      if (pendingElicitation) {
        const insertAt = agentItemsCountRef.current;
        setLiveElicitationSummaries((prev) => [
          ...prev,
          {
            item: {
              id: `elicit-${requestId}`,
              message: pendingElicitation.message,
              declined: true,
              fields: [],
            },
            insertAt,
          },
        ]);
      }
      setPendingElicitation(null);
      setActivity(sessionKey, "thinking");
    },
    [sessionKey, pendingElicitation, setPendingElicitation, setActivity, agentItemsCountRef],
  );

  return {
    handlePermissionRespond,
    handleElicitationSubmit,
    handleElicitationDecline,
    livePermissionResponses,
    liveElicitationSummaries,
    showPlanOverlay,
    setShowPlanOverlay,
  };
}
