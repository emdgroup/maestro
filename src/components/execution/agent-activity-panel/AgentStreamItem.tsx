import { ActivityMessageItem } from "../activity/ActivityMessageItem";
import { ActivityThinkingBlock } from "../activity/ActivityThinkingBlock";
import { ActivityToolCallGroup } from "../activity/ActivityToolCallGroup";
import { PlanReviewCard } from "../activity/PlanReviewCard";
import { SubagentCard } from "../activity/SubagentCard";
import { PermissionResponseCard } from "../activity/PermissionResponseCard";
import { ActivityElicitationCard } from "../activity/ActivityElicitationCard";
import { isSubagentToolCall } from "../activity/utils";
import type { GroupedDisplayItem } from "../activity/utils";
import type { ToolCallItem } from "../activity/types";
import { isPlanToolCallItem } from "@/components/execution/activity/PermissionPrompt.tsx";
import { AlertCircle, LockKeyhole } from "lucide-react";
import { cn } from "@/lib/utils";

interface AgentStreamItemProps {
  gi: GroupedDisplayItem;
  index: number;
  allItems: GroupedDisplayItem[];
  nextSectionStartsWithMessage: boolean;
  onOpenPlanOverlay: () => void;
  toolCallMap: Map<string, ToolCallItem>;
  onAuthLogin?: () => void;
}

export function AgentStreamItem({
  gi,
  index,
  allItems,
  nextSectionStartsWithMessage,
  onOpenPlanOverlay,
  toolCallMap,
  onAuthLogin,
}: AgentStreamItemProps) {
  if (gi.type === "toolGroup") {
    const tc = gi.items[0];
    if (gi.items.length === 1 && isPlanToolCallItem(tc)) {
      return <PlanReviewCard key={tc.toolCallId} item={tc} onOpen={onOpenPlanOverlay} />;
    }

    if (gi.items.length === 1 && isSubagentToolCall(gi.items[0])) {
      return (
        <SubagentCard key={gi.items[0].toolCallId} item={gi.items[0]} toolCallMap={toolCallMap} />
      );
    }

    const hasSubsequentMessage =
      allItems
        .slice(index + 1)
        .some((later) => later.type === "solo" && later.item.type === "message") ||
      nextSectionStartsWithMessage;

    const groupKey = `tg-${gi.items[0].toolCallId}`;
    return (
      <div key={groupKey} className="space-y-3 pb-1">
        <ActivityToolCallGroup items={gi.items} hasSubsequentMessage={hasSubsequentMessage} />
      </div>
    );
  }

  const item = gi.item;
  if (item.type === "message") {
    return <ActivityMessageItem key={item.item.id} message={item.item} />;
  }
  if (item.type === "thinking") {
    return <ActivityThinkingBlock key={item.item.id} thinking={item.item} />;
  }
  if (item.type === "permissionResponse") {
    return <PermissionResponseCard key={item.item.id} item={item.item} />;
  }
  if (item.type === "elicitationSummary") {
    return <ActivityElicitationCard key={item.item.id} item={item.item} />;
  }
  if (item.type === "canvas") {
    return null;
  }
  if (item.type === "error") {
    const isAuth = item.item.stopReason === "auth_required";
    return (
      <div
        key={item.item.id}
        className={cn(
          "mx-4 my-1 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm",
          isAuth
            ? "border-warning/20 bg-warning/[0.07] text-warning"
            : "border-destructive/20 bg-destructive/[0.07] text-destructive",
        )}
      >
        {isAuth ? (
          <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <div className="flex flex-col gap-2">
          <span>{item.item.message}</span>
          {isAuth && onAuthLogin && (
            <button
              onClick={onAuthLogin}
              className="self-start flex items-center gap-1.5 rounded-md border border-warning/35 bg-warning/10 px-2.5 py-1 text-xs font-semibold text-warning hover:bg-warning/20"
            >
              <LockKeyhole className="h-3 w-3" />
              Login
            </button>
          )}
        </div>
      </div>
    );
  }
  return null;
}
