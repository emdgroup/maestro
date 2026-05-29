import { useState, useEffect, useCallback, useRef } from "react";

export type AcpScrollBehaviorResult = {
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
  chatContentRef: React.RefObject<HTMLDivElement | null>;
  lastUserMsgRef: React.RefObject<HTMLDivElement | null>;
  atBottomRef: React.RefObject<boolean>;
  showScrollFab: boolean;
  hasUnread: boolean;
  isLastUserMsgPinned: boolean;
  handleWheel: (e: React.WheelEvent) => void;
  handleChatScroll: () => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollToLastUserMsg: () => void;
};

export function useAcpScrollBehavior(
  isReady: boolean,
  lastUserMessageId: string | null,
): AcpScrollBehaviorResult {
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const lastUserMsgRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const scrollingToMsgRef = useRef(false);
  const [showScrollFab, setShowScrollFab] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const [isLastUserMsgPinned, setIsLastUserMsgPinned] = useState(false);

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
      if (!scrollingToMsgRef.current) {
        atBottomRef.current = true;
        setShowScrollFab(false);
        setHasUnread(false);
      }
    } else {
      scrollingToMsgRef.current = false;
    }
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowScrollFab(false);
    setHasUnread(false);
  }, []);

  const scrollToLastUserMsg = useCallback(() => {
    const scrollEl = chatScrollRef.current;
    const msgEl = lastUserMsgRef.current;
    if (!scrollEl || !msgEl) return;
    scrollingToMsgRef.current = true;
    setIsLastUserMsgPinned(false);
    const top = msgEl.offsetTop - 10;
    scrollEl.scrollTo({ top, behavior: "smooth" });
    atBottomRef.current = false;
    setShowScrollFab(true);
  }, []);

  useEffect(() => {
    setIsLastUserMsgPinned(false);
    const scrollEl = chatScrollRef.current;
    const msgEl = lastUserMsgRef.current;
    if (!scrollEl || !msgEl) return;

    let observerCleanup: (() => void) | null = null;
    const frameId = requestAnimationFrame(() => {
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (scrollingToMsgRef.current) {
            setIsLastUserMsgPinned(false);
            return;
          }
          const rootRect = entry.rootBounds;
          const isAbove = rootRect && entry.boundingClientRect.bottom < rootRect.top + 10;
          setIsLastUserMsgPinned(!entry.isIntersecting && !!isAbove);
        },
        { root: scrollEl, threshold: 0 },
      );
      observer.observe(msgEl);
      observerCleanup = () => observer.disconnect();
    });
    return () => {
      cancelAnimationFrame(frameId);
      observerCleanup?.();
    };
  }, [isReady, lastUserMessageId]);

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
    lastUserMsgRef,
    atBottomRef,
    showScrollFab,
    hasUnread,
    isLastUserMsgPinned,
    handleWheel,
    handleChatScroll,
    scrollToBottom,
    scrollToLastUserMsg,
  };
}
