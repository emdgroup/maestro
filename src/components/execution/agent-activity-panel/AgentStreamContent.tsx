import { AnimatePresence } from "framer-motion";
import { ActivityUserMessage } from "../activity/ActivityUserMessage";
import { AgentResponseSection } from "../activity/AgentResponseSection";
import { AgentStreamItem } from "./AgentStreamItem";
import type { AgentSectionItem, GroupedDisplayItem } from "../activity/utils";
import type { ToolCallItem, CanvasSurface } from "../activity/types";
import { cn } from "@/lib/utils.ts";
import { useSettings } from "@/services/settings.service";
import React from "react";
import {
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from "@/ui/message-scroller";
import { OpenFileContext } from "../activity/MarkdownBlock";

interface AgentStreamContentProps {
  agentSections: AgentSectionItem[];
  toolCallMap: Map<string, ToolCallItem>;
  canvasMap: Map<string, CanvasSurface>;
  onOpenPlanOverlay: () => void;
  onOpenFile?: (uri: string) => void;
  inlinePermission: React.ReactNode;
  bottomPadding?: number;
  onAuthLogin?: () => void;
}

export function AgentStreamContent({
  agentSections,
  toolCallMap,
  canvasMap,
  onOpenPlanOverlay,
  onOpenFile,
  inlinePermission,
  bottomPadding,
  onAuthLogin,
}: AgentStreamContentProps) {
  const { data: appSettings } = useSettings();
  const isCompact = appSettings?.agent_stream_width === "compact";
  const thinkingHidden = appSettings?.thinking_visibility === "hide";
  const toolCallsHidden = appSettings?.tool_call_visibility === "hide";

  return (
    <OpenFileContext.Provider value={onOpenFile}>
      <MessageScroller className="absolute inset-0">
        <MessageScrollerViewport className="overflow-x-hidden">
          <MessageScrollerContent
            className={cn("gap-3 pt-3", isCompact && "max-w-3xl mx-auto w-full")}
            style={bottomPadding ? { paddingBottom: bottomPadding } : undefined}
          >
            {agentSections.map((section) => {
              if (section.type === "standalone") {
                const gi = section.item;
                if (gi.type !== "solo" || gi.item.type !== "userMessage") return null;
                const msgId = gi.item.item.id;
                return (
                  <MessageScrollerItem key={msgId} messageId={msgId} className="px-3">
                    <ActivityUserMessage message={gi.item.item} onOpenFile={onOpenFile} />
                  </MessageScrollerItem>
                );
              }

              const { items, showConnector } = section;

              const visibleItems = items.filter((gi) => {
                if (gi.type === "toolGroup") return !toolCallsHidden;
                if (gi.item.type === "thinking") return !thinkingHidden;
                return true;
              });
              if (visibleItems.length === 0) return null;

              const firstItem = items[0];
              const sectionKey =
                firstItem.type === "toolGroup"
                  ? `tg-${firstItem.items[0].toolCallId}`
                  : firstItem.item.type === "toolCall"
                    ? firstItem.item.item.toolCallId
                    : firstItem.item.type === "canvas"
                      ? firstItem.item.item.surfaceId
                      : firstItem.item.item.id;

              const sharedItemProps = {
                onOpenPlanOverlay,
                toolCallMap,
                canvasMap,
                onAuthLogin,
              };

              return (
                <MessageScrollerItem key={sectionKey} messageId={sectionKey} className="px-3">
                  <AgentResponseSection showConnector={showConnector}>
                    {visibleItems.map((gi) => (
                      <AgentStreamItem key={getItemKey(gi)} gi={gi} {...sharedItemProps} />
                    ))}
                  </AgentResponseSection>
                </MessageScrollerItem>
              );
            })}
            <AnimatePresence>{inlinePermission}</AnimatePresence>
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </OpenFileContext.Provider>
  );
}

export function getItemKey(gi: GroupedDisplayItem): string {
  if (gi.type === "toolGroup") return `tg-${gi.items[0].toolCallId}`;
  const item = gi.item;
  if (item.type === "toolCall") return item.item.toolCallId;
  if (item.type === "canvas") return item.item.surfaceId;
  return item.item.id;
}
