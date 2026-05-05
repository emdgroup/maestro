import { useState, useEffect, useCallback, useRef } from "react";

export type AcpScrollBehaviorResult = {
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
  chatContentRef: React.RefObject<HTMLDivElement | null>;
  showScrollFab: boolean;
  hasUnread: boolean;
  handleWheel: (e: React.WheelEvent) => void;
  handleChatScroll: () => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
};

export function useAcpScrollBehavior(isReady: boolean): AcpScrollBehaviorResult {
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showScrollFab, setShowScrollFab] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      const el = chatScrollRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) return;
      atBottomRef.current = false;
      setShowScrollFab(true);
    }
  }, []);

  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) {
      atBottomRef.current = true;
      setShowScrollFab(false);
      setHasUnread(false);
    }
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowScrollFab(false);
    setHasUnread(false);
  }, []);

  // ResizeObserver: auto-scroll when content grows if already at bottom
  useEffect(() => {
    if (!isReady) return;
    const scrollEl = chatScrollRef.current;
    const contentEl = chatContentRef.current;
    if (!scrollEl || !contentEl) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      } else {
        setHasUnread(true);
      }
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  }, [isReady]);

  return {
    chatScrollRef,
    chatContentRef,
    showScrollFab,
    hasUnread,
    handleWheel,
    handleChatScroll,
    scrollToBottom,
  };
}
