import { ActivityMessageItem } from "../activity/ActivityMessageItem";
import { ActivityThinkingBlock } from "../activity/ActivityThinkingBlock";
import { ActivityToolCallGroup } from "../activity/ActivityToolCallGroup";
import { ActivityFileCard } from "../activity/ActivityFileCard";
import { PlanReviewCard } from "../activity/PlanReviewCard";
import { CanvasRenderer } from "../activity/canvas/CanvasRenderer";
import { SubagentCard } from "../activity/SubagentCard";
import { PermissionResponseCard } from "../activity/PermissionResponseCard";
import { ActivityElicitationCard } from "../activity/ActivityElicitationCard";
import { isSubagentToolCall } from "../activity/utils";
import { isWorkingFile, WRITE_KINDS } from "./useWorkingFileTracker";
import type { GroupedDisplayItem } from "../activity/utils";
import type { ToolCallItem, CanvasSurface } from "../activity/types";
import { isPlanToolCallItem } from "@/components/execution/activity/PermissionPrompt.tsx";

interface AgentStreamItemProps {
  gi: GroupedDisplayItem;
  index: number;
  allItems: GroupedDisplayItem[];
  nextSectionStartsWithMessage: boolean;
  onOpenPlanOverlay: () => void;
  toolCallMap: Map<string, ToolCallItem>;
  canvasMap: Map<string, CanvasSurface>;
  onOpenPanel?: (panel: "working-files" | "review-changes", initialFile?: string) => void;
}

export function AgentStreamItem({
  gi,
  index,
  allItems,
  nextSectionStartsWithMessage,
  onOpenPlanOverlay,
  toolCallMap,
  canvasMap,
  onOpenPanel,
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

    const groupDone = gi.items.every((i) => i.status === "completed" || i.status === "error");
    const groupWorkingFiles: string[] = [];
    const groupChangedFiles: string[] = [];
    if (groupDone) {
      for (const tc of gi.items) {
        for (const c of tc.content) {
          if (c.type === "diff") {
            if (isWorkingFile(c.path)) groupWorkingFiles.push(c.path);
            else groupChangedFiles.push(c.path);
          }
        }
        if (WRITE_KINDS.has(tc.kind)) {
          for (const loc of tc.locations) {
            if (isWorkingFile(loc.path)) groupWorkingFiles.push(loc.path);
            else groupChangedFiles.push(loc.path);
          }
        }
      }
    }
    const uniqueWorkingFiles = [...new Set(groupWorkingFiles)];
    const uniqueChangedFiles = [...new Set(groupChangedFiles)];
    const groupKey = `tg-${gi.items[0].toolCallId}`;
    return (
      <div key={groupKey} className="space-y-3">
        <ActivityToolCallGroup items={gi.items} hasSubsequentMessage={hasSubsequentMessage} />
        {groupDone && uniqueWorkingFiles.length > 0 && (
          <ActivityFileCard
            variant="working-files"
            fileNames={uniqueWorkingFiles}
            onClick={() => onOpenPanel?.("working-files", uniqueWorkingFiles[0])}
          />
        )}
        {groupDone && uniqueChangedFiles.length > 0 && (
          <ActivityFileCard
            variant="review-changes"
            fileNames={uniqueChangedFiles}
            onClick={() => onOpenPanel?.("review-changes", uniqueChangedFiles[0])}
          />
        )}
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
    const surface = canvasMap.get(item.item.surfaceId);
    if (!surface || surface.components.length === 0) return null;
    return <CanvasRenderer key={item.item.surfaceId} surface={surface} />;
  }
  return null;
}
