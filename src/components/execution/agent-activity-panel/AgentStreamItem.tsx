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

interface AgentStreamItemProps {
  gi: GroupedDisplayItem;
  index: number;
  allItems: GroupedDisplayItem[];
  nextSectionStartsWithMessage: boolean;
  onOpenPlanOverlay: () => void;
  toolCallMap: Map<string, ToolCallItem>;
}

export function AgentStreamItem({
  gi,
  index,
  allItems,
  nextSectionStartsWithMessage,
  onOpenPlanOverlay,
  toolCallMap,
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
  return null;
}
