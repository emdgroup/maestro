import type { ComponentProps } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PermissionPrompt } from "../activity/PermissionPrompt";
import { PendingPlanCard } from "../activity/PlanReviewCard";
import { ElicitationPrompt, parseElicitationFields } from "../activity/ElicitationPrompt";
import { extractPlanToolCallId } from "../activity/permission-prompt-utils";
import type { ToolCallItem } from "../activity/types";
import type { PendingRequest } from "../activity/sessionRuntime";

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
  pendingRequests,
  onShowRequest,
  requestSource,
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
  /** Every request waiting, oldest first; the one shown is `pendingElicitation` or `pendingPermission`. */
  pendingRequests: PendingRequest[];
  onShowRequest: (requestId: string) => void;
  /** Who asked, when the session has subagents to tell apart from the main agent. */
  requestSource?: (request: PendingRequest) => string;
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
  const shownId = (pendingElicitation ?? pendingPermission)?.requestId;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      {shownId && (requestSource || pendingRequests.length > 1) && (
        <RequestHeader
          requests={pendingRequests}
          shownId={shownId}
          onShow={onShowRequest}
          source={requestSource}
        />
      )}
      {body}
    </motion.div>
  );
}

/**
 * Who asked, and how many requests wait, with a step through them. Agents ask in parallel (each
 * subagent on its own), and every one of them stays blocked until answered, so none may be hidden.
 */
function RequestHeader({
  requests,
  shownId,
  onShow,
  source,
}: {
  requests: PendingRequest[];
  shownId: string;
  onShow: (requestId: string) => void;
  source?: (request: PendingRequest) => string;
}) {
  const index = Math.max(
    0,
    requests.findIndex((r) => r.requestId === shownId),
  );
  const step = (by: number) =>
    onShow(requests[(index + by + requests.length) % requests.length].requestId);
  const buttonClass =
    "flex size-5 items-center justify-center rounded-md border border-border/60 hover:bg-foreground/7";
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {source && requests[index] && <span className="truncate">{source(requests[index])}</span>}
      {requests.length > 1 && (
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Previous request"
            className={buttonClass}
            onClick={() => step(-1)}
          >
            <ChevronLeft className="size-3" />
          </button>
          <span className="tabular-nums">
            {index + 1} of {requests.length}
          </span>
          <button
            type="button"
            aria-label="Next request"
            className={buttonClass}
            onClick={() => step(1)}
          >
            <ChevronRight className="size-3" />
          </button>
        </span>
      )}
    </div>
  );
}
