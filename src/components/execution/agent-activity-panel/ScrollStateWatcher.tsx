import { useEffect, useLayoutEffect, useRef } from "react";
import { useMessageScroller, useMessageScrollerScrollable } from "@/ui/message-scroller";

/** Keeps the conversation scrolled where the user expects it, and marks an idle session seen. */
export function ScrollStateWatcher({
  isSelected,
  activeTab,
  activityStatus,
  activitySeen,
  sessionId,
  markSeen,
  userMessageCount,
  lastAgentSectionId,
}: {
  isSelected: boolean;
  activeTab: string;
  activityStatus: string | undefined;
  activitySeen: boolean | undefined;
  sessionId: string;
  markSeen: (sessionId: string) => void;
  userMessageCount: number;
  lastAgentSectionId: string | null;
}) {
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  const scrollable = useMessageScrollerScrollable();

  const prevCountRef = useRef(userMessageCount);
  useEffect(() => {
    if (userMessageCount > prevCountRef.current) {
      scrollToEnd({ behavior: "instant" });
    }
    prevCountRef.current = userMessageCount;
  }, [userMessageCount, scrollToEnd]);

  const prevIsSelectedRef = useRef(isSelected);
  useLayoutEffect(() => {
    const wasSelected = prevIsSelectedRef.current;
    prevIsSelectedRef.current = isSelected;
    if (!isSelected || wasSelected) return;
    scrollToEnd({ behavior: "instant" });
  }, [isSelected, scrollToEnd]);

  useEffect(() => {
    if (!isSelected || !lastAgentSectionId) return;
    const id = requestAnimationFrame(() => {
      const sectionEl = document.querySelector(
        `[data-message-id="${CSS.escape(lastAgentSectionId)}"]`,
      );
      if (sectionEl && sectionEl.getBoundingClientRect().top < 0) {
        scrollToMessage(lastAgentSectionId, { align: "start", behavior: "instant" });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [isSelected, lastAgentSectionId, scrollToMessage]);

  useEffect(() => {
    if (
      isSelected &&
      activeTab === "agents" &&
      !scrollable.end &&
      activityStatus === "idle" &&
      !activitySeen
    ) {
      markSeen(sessionId);
    }
  }, [isSelected, activeTab, scrollable.end, activityStatus, activitySeen, sessionId, markSeen]);
  return null;
}
