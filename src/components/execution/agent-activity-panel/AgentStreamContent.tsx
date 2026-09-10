import { ActivityUserMessage } from "../activity/ActivityUserMessage";
import { AgentResponseSection } from "../activity/AgentResponseSection";
import { AgentStreamItem } from "./AgentStreamItem";
import type { AgentSectionItem, GroupedDisplayItem } from "../activity/utils";
import type { ToolCallItem, AvailableCommand } from "../activity/types";
import { cn } from "@/lib/utils";
import { useSettings } from "@/services/settings.service";
import React, { memo, useRef } from "react";
import {
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  useMessageScroller,
} from "@/ui/message-scroller";
import { OpenFileContext, CommandsContext } from "../activity/MarkdownBlock";

/* Keys the scroller itself treats as scroll input. */
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);

/* How long after a gesture a scroll still counts as that gesture's. */
const GESTURE_WINDOW_MS = 150;

/*
  `data-scrollable` is written synchronously by the scroller's own scroll handler, which runs
  before ours; the `useMessageScrollerScrollable()` snapshot is a render behind and would still
  say "not at the end" here. It also reports the *content's* end, ignoring the anchor spacer,
  which is what makes it the right test — reaching the last message counts as the bottom even
  with dead space still reserved below it.
*/
function isAtEnd(viewport: HTMLElement) {
  return !viewport.getAttribute("data-scrollable")?.includes("end");
}

/*
  Within a section that *did* change, only the row holding the new text should re-render.
  `groupToolCalls` keeps wrapper identity for the rest, so a default shallow compare is enough
  and no custom comparator is warranted.
*/
const MemoAgentStreamItem = memo(AgentStreamItem);

/*
  The stream's bail-out boundary. `groupIntoAgentSections` hands back the *same* section object
  for a section nothing changed in, so a shallow compare here skips the whole subtree: the
  `visibleItems` filter, the key derivation, and every row below. Without it a one-token chunk
  re-rendered the entire transcript, because `AgentStreamContent` re-maps all its sections and
  React has no per-element bail-out of its own.

  The React Compiler does not remove the need for this. It memoizes values *inside* a component;
  what is needed across a `.map()` is a bail-out at the component's prop boundary, which is
  `memo`'s job and only `memo`'s.
*/
const AgentSectionRow = memo(function AgentSectionRow({
  section,
  sectionKey,
  toolCallMap,
  livePlanToolCallId,
  thinkingHidden,
  toolCallsHidden,
  onAuthLogin,
}: {
  section: Extract<AgentSectionItem, { type: "agentSection" }>;
  sectionKey: string;
  toolCallMap: Map<string, ToolCallItem>;
  livePlanToolCallId: string | null;
  thinkingHidden: boolean;
  toolCallsHidden: boolean;
  onAuthLogin?: () => void;
}) {
  const visibleItems = section.items.filter((gi) => {
    if (gi.type === "toolGroup") {
      if (toolCallsHidden) return false;
      return !gi.items.some((tc) => tc.toolCallId === livePlanToolCallId);
    }
    if (gi.item.type === "thinking") return !thinkingHidden;
    return true;
  });
  if (visibleItems.length === 0) return null;

  return (
    <MessageScrollerItem messageId={sectionKey} className="px-3">
      <AgentResponseSection>
        {visibleItems.map((gi, i) => (
          <MemoAgentStreamItem
            key={getItemKey(gi)}
            gi={gi}
            isLastInSection={i === visibleItems.length - 1}
            toolCallMap={toolCallMap}
            onAuthLogin={onAuthLogin}
          />
        ))}
      </AgentResponseSection>
    </MessageScrollerItem>
  );
});

interface AgentStreamContentProps {
  agentSections: AgentSectionItem[];
  toolCallMap: Map<string, ToolCallItem>;
  /**
   * The plan tool call whose request is still open, if any. Its row is left out of the stream
   * because `inlinePermission` renders it at the bottom instead — two of the same card, one of
   * them scrolled away mid-conversation, is worse than one in the place the user is answering from.
   */
  livePlanToolCallId: string | null;
  onOpenFile?: (uri: string) => void;
  bottomPadding?: number;
  onAuthLogin?: () => void;
  commands: AvailableCommand[];
}

export function AgentStreamContent({
  agentSections,
  toolCallMap,
  livePlanToolCallId,
  onOpenFile,
  bottomPadding,
  onAuthLogin,
  commands,
}: AgentStreamContentProps) {
  const { data: appSettings } = useSettings();
  const isCompact = appSettings?.agent_stream_width === "compact";
  const thinkingHidden = appSettings?.thinking_visibility === "hide";
  const toolCallsHidden = appSettings?.tool_call_visibility === "hide";
  const { scrollToEnd } = useMessageScroller();

  /*
    Scrolling to the bottom means the same thing as pressing the scroll-to-bottom FAB: drop the
    anchor spacer's dead space and resume following the stream. The scroller does not do this on
    its own — it re-follows once its own state settles, but leaves the spacer until the next
    chunk arrives, and the trailing ticks of a flick that lands on the bottom scroll nothing, so
    no scroll event follows to settle on and the stream is left unfollowed.

    Gated on a recent gesture and on *crossing* into the end zone, because the scroller's own
    jumps — pinning a newly arrived section to the top of the viewport — also land at the end of
    the content, and turning those into a jump to the bottom would defeat them.
  */
  const lastGestureRef = useRef(0);
  const wasAtEndRef = useRef(true);

  const markGesture = () => {
    lastGestureRef.current = Date.now();
  };

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const atEnd = isAtEnd(e.currentTarget);
    const crossedIntoEnd = atEnd && !wasAtEndRef.current;
    wasAtEndRef.current = atEnd;
    if (crossedIntoEnd && Date.now() - lastGestureRef.current < GESTURE_WINDOW_MS) {
      scrollToEnd({ behavior: "auto" });
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    markGesture();
    // Wheeling further down at the bottom moves nothing, so no scroll event reaches
    // handleScroll — this is the only chance to treat it as hitting the bottom.
    if (e.deltaY > 0 && isAtEnd(e.currentTarget)) scrollToEnd({ behavior: "auto" });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (SCROLL_KEYS.has(e.key)) markGesture();
  };

  return (
    <OpenFileContext.Provider value={onOpenFile}>
      <CommandsContext.Provider value={commands}>
        <MessageScroller className="absolute inset-0">
          {/*
            Reserve the scrollbar's width whether or not it is showing — the content is
            centred, so a scrollbar appearing mid-stream would otherwise nudge every
            message sideways.
          */}
          <MessageScrollerViewport
            className="overflow-x-hidden [scrollbar-gutter:stable]"
            onScroll={handleScroll}
            onWheel={handleWheel}
            onTouchMove={markGesture}
            onKeyDown={handleKeyDown}
          >
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

                // Derived here rather than in the row because it is also the React key, which
                // has to be on the element this callback returns.
                const sectionKey = getItemKey(section.items[0]);

                return (
                  <AgentSectionRow
                    key={sectionKey}
                    section={section}
                    sectionKey={sectionKey}
                    toolCallMap={toolCallMap}
                    livePlanToolCallId={livePlanToolCallId}
                    thinkingHidden={thinkingHidden}
                    toolCallsHidden={toolCallsHidden}
                    onAuthLogin={onAuthLogin}
                  />
                );
              })}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </CommandsContext.Provider>
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
