import type { ComponentProps } from "react";
import { motion } from "framer-motion";
import { PermissionPrompt } from "../activity/PermissionPrompt";
import { PendingPlanCard } from "../activity/PlanReviewCard";
import { ElicitationPrompt, parseElicitationFields } from "../activity/ElicitationPrompt";
import { extractPlanToolCallId } from "../activity/permission-prompt-utils";
import type { ToolCallItem } from "../activity/types";

type Request = { requestId: string; payload: Record<string, unknown> };

/**
 * Whatever the agent is waiting on, in the composer's place (see `AgentBottomBar`): a question,
 * a plan to review, or a permission. A plan and an elicitation are one more thing it is asking
 * for, so all three go here rather than into the conversation they are about, where they would
 * trail the last message with dead space beneath.
 */
export function PendingRequestCard({
  sessionId,
  modelId,
  toolCallMap,
  pendingElicitation,
  pendingPermission,
  isPlan,
  onElicitationSubmit,
  onElicitationDecline,
  onPlanRespond,
  onOpenPlan,
  onPermissionRespond,
}: {
  sessionId: string;
  modelId: string | null;
  toolCallMap: Map<string, ToolCallItem>;
  pendingElicitation: (Request & { message: string }) | null;
  pendingPermission: Request | null;
  /** The permission is a plan with a body to review, rather than a yes or no. */
  isPlan: boolean;
  onElicitationSubmit: ComponentProps<typeof ElicitationPrompt>["onSubmit"];
  onElicitationDecline: ComponentProps<typeof ElicitationPrompt>["onDecline"];
  onPlanRespond: ComponentProps<typeof PendingPlanCard>["onRespond"];
  onOpenPlan: () => void;
  onPermissionRespond: ComponentProps<typeof PermissionPrompt>["onRespond"];
}) {
  let body;
  if (pendingElicitation) {
    const { requestId, message, payload } = pendingElicitation;
    const { fields, otherField } = parseElicitationFields(payload);
    body = (
      <ElicitationPrompt
        key={requestId}
        requestId={requestId}
        message={message}
        fields={fields}
        otherField={otherField}
        onSubmit={onElicitationSubmit}
        onDecline={onElicitationDecline}
      />
    );
  } else if (pendingPermission && isPlan) {
    const planToolCallId = extractPlanToolCallId(pendingPermission.payload);
    body = (
      <PendingPlanCard
        key={pendingPermission.requestId}
        sessionId={sessionId}
        modelId={modelId}
        title={(planToolCallId ? toolCallMap.get(planToolCallId)?.title : null) ?? null}
        requestId={pendingPermission.requestId}
        payload={pendingPermission.payload}
        onRespond={onPlanRespond}
        onOpen={onOpenPlan}
      />
    );
  } else if (pendingPermission) {
    body = (
      <PermissionPrompt
        key={pendingPermission.requestId}
        requestId={pendingPermission.requestId}
        payload={pendingPermission.payload}
        onRespond={onPermissionRespond}
      />
    );
  } else {
    return null;
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      {body}
    </motion.div>
  );
}
