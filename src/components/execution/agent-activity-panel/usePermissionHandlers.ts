import React, { useCallback, useEffect, useState } from "react";
import { useSessionActivityActions } from "@/store/sessionActivityStore";
import { respondAcpElicitation, respondAcpPermission } from "@/services/execution.service";
import { isPlanPermission } from "../activity/PermissionPrompt";
import { isRejectOption, getOptionName, formatFieldAnswer } from "../activity/utils";
import { parseElicitationFields } from "../activity/ElicitationPrompt";
import type { PermissionResponseItem, ElicitationSummaryItem } from "../activity/types";
import type { PendingPermission, PendingRequest } from "../activity/sessionRuntime";

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
};

export function usePermissionHandlers(
  sessionId: string,
  agentItemsCountRef: React.RefObject<number>,
  pendingRequests: PendingRequest[],
  /** The request shown, when it is a permission: the one a plan with no body is approved from. */
  pendingPermission: PendingPermission | null,
  resolvePendingRequest: (requestId: string) => boolean,
  isPlanPermWithBody: boolean,
): PermissionHandlers {
  const { setActivity } = useSessionActivityActions();
  const [liveElicitationSummaries, setLiveElicitationSummaries] = useState<
    Array<{ item: ElicitationSummaryItem; insertAt: number }>
  >([]);
  const [livePermissionResponses, setLivePermissionResponses] = useState<
    Array<{ item: PermissionResponseItem; insertAt: number; requestId: string }>
  >([]);

  const handlePermissionRespond = useCallback(
    async (requestId: string, optionId: string | null) => {
      try {
        await respondAcpPermission(sessionId, requestId, optionId);
      } catch {
        // best-effort
      }
      const answered = pendingRequests.find((r) => r.requestId === requestId);
      if (answered?.kind === "permission") {
        const isRejection = !optionId || isRejectOption(answered.payload, optionId);
        if (!isPlanPermission(answered.payload)) {
          const responseItem: PermissionResponseItem = {
            id: `perm-${requestId}`,
            optionName:
              getOptionName(answered.payload, optionId) ??
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
      const more = resolvePendingRequest(requestId);
      setActivity(sessionId, more ? "awaiting_input" : "thinking");
    },
    [sessionId, pendingRequests, resolvePendingRequest, setActivity, agentItemsCountRef],
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
        await respondAcpElicitation(sessionId, requestId, {
          action: "accept",
          content: values,
        } as never);
      } catch {
        /* best-effort */
      }
      const answered = pendingRequests.find((r) => r.requestId === requestId);
      if (answered?.kind === "elicitation") {
        const insertAt = agentItemsCountRef.current;
        const { message, payload } = answered;
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
      const more = resolvePendingRequest(requestId);
      setActivity(sessionId, more ? "awaiting_input" : "thinking");
    },
    [sessionId, pendingRequests, resolvePendingRequest, setActivity, agentItemsCountRef],
  );

  const handleElicitationDecline = useCallback(
    async (requestId: string) => {
      try {
        await respondAcpElicitation(sessionId, requestId, { action: "decline" });
      } catch {
        /* best-effort */
      }
      const answered = pendingRequests.find((r) => r.requestId === requestId);
      if (answered?.kind === "elicitation") {
        const insertAt = agentItemsCountRef.current;
        setLiveElicitationSummaries((prev) => [
          ...prev,
          {
            item: {
              id: `elicit-${requestId}`,
              message: answered.message,
              declined: true,
              fields: [],
            },
            insertAt,
          },
        ]);
      }
      const more = resolvePendingRequest(requestId);
      setActivity(sessionId, more ? "awaiting_input" : "thinking");
    },
    [sessionId, pendingRequests, resolvePendingRequest, setActivity, agentItemsCountRef],
  );

  return {
    handlePermissionRespond,
    handleElicitationSubmit,
    handleElicitationDecline,
    livePermissionResponses,
    liveElicitationSummaries,
  };
}
