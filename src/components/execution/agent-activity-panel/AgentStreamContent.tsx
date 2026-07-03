import { AnimatePresence } from "framer-motion";
import { ActivityUserMessage } from "../activity/ActivityUserMessage";
import { AgentResponseSection } from "../activity/AgentResponseSection";
import { AgentStreamItem } from "./AgentStreamItem";
import type { AgentSectionItem, GroupedDisplayItem } from "../activity/utils";
import type { ToolCallItem, CanvasSurface, UserMessageItem } from "../activity/types";
import { cn } from "@/lib/ui-utils";
import { useSettings } from "@/services/settings.service";
import React from "react";

interface AgentStreamContentProps {
  agentSections: AgentSectionItem[];
  lastUserMessage: UserMessageItem | null;
  toolCallMap: Map<string, ToolCallItem>;
  canvasMap: Map<string, CanvasSurface>;
  onOpenPlanOverlay: () => void;
  inlinePermission: React.ReactNode;
  bottomBar: React.ReactNode;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
  chatContentRef: React.RefObject<HTMLDivElement | null>;
  lastUserMsgRef: React.RefObject<HTMLDivElement | null>;
  handleWheel: React.WheelEventHandler<HTMLDivElement>;
  handleChatScroll: React.UIEventHandler<HTMLDivElement>;
}

export function AgentStreamContent({
  agentSections,
  lastUserMessage,
  toolCallMap,
  canvasMap,
  onOpenPlanOverlay,
  inlinePermission,
  bottomBar,
  chatScrollRef,
  chatContentRef,
  lastUserMsgRef,
  handleWheel,
  handleChatScroll,
}: AgentStreamContentProps) {
  const { data: appSettings } = useSettings();
  const isCompact = appSettings?.agent_stream_width === "compact";

  return (
    <div
      className="absolute inset-0 overflow-y-auto overflow-x-hidden flex flex-col custom-scrollbar"
      ref={chatScrollRef}
      onScroll={handleChatScroll}
      onWheel={handleWheel}
    >
      <div className={cn("flex-1 flex flex-col", isCompact && "max-w-3xl mx-auto w-full")}>
        <div ref={chatContentRef} className="flex-1 p-3 space-y-3">
          {agentSections.map((section, sectionIndex) => {
            if (section.type === "standalone") {
              const gi = section.item;
              if (gi.type !== "solo" || gi.item.type !== "userMessage") return null;
              const isLast = gi.item.item.id === lastUserMessage?.id;
              return (
                <div key={gi.item.item.id} ref={isLast ? lastUserMsgRef : undefined}>
                  <ActivityUserMessage message={gi.item.item} />
                </div>
              );
            }

            const { items, showConnector } = section;
            const firstItem = items[0];
            const sectionKey =
              firstItem.type === "toolGroup"
                ? `tg-${firstItem.items[0].toolCallId}`
                : firstItem.item.type === "toolCall"
                  ? firstItem.item.item.toolCallId
                  : firstItem.item.type === "canvas"
                    ? firstItem.item.item.surfaceId
                    : firstItem.item.item.id;

            const nextSectionStartsWithMessage = (() => {
              for (let si = sectionIndex + 1; si < agentSections.length; si++) {
                const next = agentSections[si];
                if (next.type === "agentSection") {
                  const first = next.items[0];
                  return first.type === "solo" && first.item.type === "message";
                }
              }
              return false;
            })();

            const sharedItemProps = {
              allItems: items,
              nextSectionStartsWithMessage,
              onOpenPlanOverlay,
              toolCallMap,
              canvasMap,
            };

            return (
              <AgentResponseSection key={sectionKey} showConnector={showConnector}>
                {items.map((gi, index) => (
                  <AgentStreamItem
                    key={getItemKey(gi)}
                    gi={gi}
                    index={index}
                    {...sharedItemProps}
                  />
                ))}
              </AgentResponseSection>
            );
          })}
          <AnimatePresence>{inlinePermission}</AnimatePresence>
        </div>
        {bottomBar}
      </div>
    </div>
  );
}

function getItemKey(gi: GroupedDisplayItem): string {
  if (gi.type === "toolGroup") return `tg-${gi.items[0].toolCallId}`;
  const item = gi.item;
  if (item.type === "toolCall") return item.item.toolCallId;
  if (item.type === "canvas") return item.item.surfaceId;
  return item.item.id;
}
