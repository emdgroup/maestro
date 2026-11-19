import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import { usePanelRef } from "react-resizable-panels";

// Must match the `minSize` props on the two panels in AgentActivityPanel.
const STREAM_MIN_REM = 42;
const SIDE_MIN_REM = 22;

/**
 * What a given viewport width allows: too narrow for both panels, or wide enough
 * (twice the stream minimum) that the panel may come back on its own. The band
 * between the two fits both panels but not comfortably, so it keeps what it has.
 */
export function widthVerdict(width: number, rem: number): "collapse" | "may-expand" | "keep" {
  if (width < (STREAM_MIN_REM + SIDE_MIN_REM) * rem) return "collapse";
  return width >= STREAM_MIN_REM * 2 * rem ? "may-expand" : "keep";
}

interface UseSidePanelStateArgs {
  isSelected: boolean;
  isPlanPermWithBody: boolean;
  pendingPermission: { requestId: string; payload: Record<string, unknown> } | null;
  handlePermissionRespond: (requestId: string, optionId: string | null) => Promise<void>;
  setScrollRestoreToken: React.Dispatch<React.SetStateAction<number>>;
}

export function useSidePanelState({
  isSelected,
  isPlanPermWithBody,
  pendingPermission,
  handlePermissionRespond,
  setScrollRestoreToken,
}: UseSidePanelStateArgs) {
  // A brand new session has nothing to show in the panel — start out of the way.
  const [sidePanelCollapsed, setSidePanelCollapsed] = useState(true);
  const sidePanelElementRef = useRef<HTMLDivElement>(null);
  const sidePanelRef = usePanelRef();
  const groupElementRef = useRef<HTMLDivElement>(null);
  const manuallyCollapsedRef = useRef(false);
  const didMountRef = useRef(false);
  const [maximized, setMaximized] = useState(false);
  const [sidePanelPlan, setSidePanelPlan] = useState<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);

  // The Panel's own collapse API owns the width. A CSS override would land on the
  // Panel's inner div and leave the outer flex child at its dragged size, so the
  // stream would not reclaim the space. collapse() also remembers that size, which
  // is what expand() restores.
  //
  // Animate only the changes we drive: when the panel is already where the state
  // says, the user dragged it there and a transition would lag behind the pointer.
  // The first-mount collapse is not animated either — it would play a slide on
  // every session open.
  useLayoutEffect(() => {
    const panel = sidePanelRef.current;
    const needsSync = panel != null && panel.isCollapsed() !== sidePanelCollapsed;

    const el = sidePanelElementRef.current;
    if (el && needsSync && didMountRef.current) el.style.transition = "flex-grow 200ms ease";
    didMountRef.current = true;

    if (needsSync) {
      if (sidePanelCollapsed) panel.collapse();
      else panel.expand();
    }

    const cleanup = setTimeout(() => {
      if (sidePanelElementRef.current) sidePanelElementRef.current.style.transition = "";
    }, 220);
    setScrollRestoreToken((v) => v + 1);
    return () => {
      clearTimeout(cleanup);
      if (el) el.style.transition = "";
    };
  }, [sidePanelCollapsed, sidePanelRef, setScrollRestoreToken]);

  // AgentMonitor keeps every session mounted and hides the unselected ones, so a
  // background group has no box and measures 0. Nothing measured then says anything
  // about the viewport, and acting on it collapsed the panel the user had opened
  // every time they switched sessions.
  const currentVerdict = useCallback(() => {
    const width = groupElementRef.current?.clientWidth ?? 0;
    if (width === 0) return null;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return widthVerdict(width, rem);
  }, []);

  // Dragging the separator past the panel's minimum collapses it; mirror that back
  // into state so the strip renders instead of a 44px-wide tab bar.
  const syncCollapsedFromPanel = useCallback(() => {
    if (currentVerdict() == null) return;
    setSidePanelCollapsed(sidePanelRef.current?.isCollapsed() ?? false);
  }, [sidePanelRef, currentVerdict]);

  // Under the two panels' combined minimum the side panel has to collapse. The
  // opposite rule is not mirrored here: a cached "there is room" flag went stale
  // whenever the group was last measured hidden, so auto-expand asks for the width
  // itself, at the moment it wants to expand.
  useEffect(() => {
    const el = groupElementRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === 0) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      if (widthVerdict(entry.contentRect.width, rem) === "collapse") setSidePanelCollapsed(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Collapsing by hand opts out of auto-expand until the user expands by hand again.
  const setCollapsedByUser = useCallback((v: boolean) => {
    manuallyCollapsedRef.current = v;
    setSidePanelCollapsed(v);
  }, []);

  const expandAuto = useCallback(() => {
    if (manuallyCollapsedRef.current) return;
    if (currentVerdict() !== "may-expand") return;
    setSidePanelCollapsed(false);
  }, [currentVerdict]);

  // Selecting a session drops the maximised panel back to split view. Adjusted during
  // render rather than from an effect so the new session never paints maximised first.
  const [prevIsSelected, setPrevIsSelected] = useState(isSelected);
  if (prevIsSelected !== isSelected) {
    setPrevIsSelected(isSelected);
    if (isSelected) setMaximized(false);
  }

  // Maximizing slides the panel from its column across the agent pane, which fades under it, and
  // restoring slides it back. Only transform and opacity move: the panel is laid out once at its
  // full width, before the first frame of the slide in and after the last frame of the slide out,
  // so a large diff costs one layout either way and the frames in between are composited.
  const streamPanelElementRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<{ from: number | null; gap: number; running: Animation[] }>({
    from: null,
    gap: 0,
    running: [],
  });

  function slide(from: number, to: number, fill: FillMode) {
    const panel = sidePanelElementRef.current;
    const stream = streamPanelElementRef.current;
    if (!panel || !stream) return null;
    const timing = { duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)", fill };
    const moving = panel.animate(
      { transform: [`translateX(${from}px)`, `translateX(${to}px)`] },
      timing,
    );
    // The agent pane is `invisible` while maximized; the animation overrides that for its run.
    const fading = stream.animate(
      { visibility: ["visible", "visible"], opacity: from === 0 ? [0, 1] : [1, 0] },
      timing,
    );
    slideRef.current.running = [moving, fading];
    return moving;
  }

  function handleMaximizedChange(v: boolean) {
    for (const a of slideRef.current.running) a.cancel();
    slideRef.current.running = [];
    const panel = sidePanelElementRef.current;
    const group = groupElementRef.current;
    const stream = streamPanelElementRef.current;
    const animate =
      panel && group && stream && !document.documentElement.classList.contains("reduce-motion");

    if (v) {
      if (animate) {
        // Measured before the panel leaves its column: where it starts, and the separator's width,
        // which is hidden while maximized and so cannot be measured on the way back.
        const from = panel.getBoundingClientRect().left - group.getBoundingClientRect().left;
        slideRef.current.from = from;
        slideRef.current.gap = from - stream.getBoundingClientRect().width;
      }
      setMaximized(true);
      setSidePanelCollapsed(false);
      return;
    }

    if (!animate || !maximized) {
      setMaximized(false);
      return;
    }
    // Played while still maximized, holding its last frame until the layout below cancels it, so
    // there is never a frame of the full-width panel between the slide ending and React committing.
    const to = stream.getBoundingClientRect().width + slideRef.current.gap;
    slide(0, to, "forwards")?.finished.then(
      () => setMaximized(false),
      () => {}, // cancelled: maximized again mid-slide, or the session was switched away
    );
  }

  useLayoutEffect(() => {
    if (!maximized) {
      for (const a of slideRef.current.running) a.cancel();
      slideRef.current.running = [];
      return;
    }
    const from = slideRef.current.from;
    slideRef.current.from = null;
    if (from) slide(from, 0, "none");
  }, [maximized]);

  // A plan permission arriving from the agent opens the panel on it. Adjusted during
  // render rather than from an effect so the plan is on screen in the same frame the
  // request lands, instead of one frame later.
  const inboundPlanId =
    isPlanPermWithBody && pendingPermission ? pendingPermission.requestId : null;
  const [shownPlanId, setShownPlanId] = useState(inboundPlanId);
  if (shownPlanId !== inboundPlanId) {
    setShownPlanId(inboundPlanId);
    if (inboundPlanId && pendingPermission) {
      setSidePanelPlan({
        requestId: pendingPermission.requestId,
        payload: pendingPermission.payload,
      });
      setSidePanelCollapsed(false);
    }
  }

  const handleOpenPlanOverlaySplit = useCallback(() => {
    if (!pendingPermission || !isPlanPermWithBody) return;
    setSidePanelPlan({
      requestId: pendingPermission.requestId,
      payload: pendingPermission.payload,
    });
    setSidePanelCollapsed(false);
  }, [pendingPermission, isPlanPermWithBody]);

  const handlePlanRespond = useCallback(
    (requestId: string, optionId: string | null) => {
      void handlePermissionRespond(requestId, optionId);
      setSidePanelPlan(null);
    },
    [handlePermissionRespond],
  );

  return {
    sidePanelCollapsed,
    setSidePanelCollapsed: setCollapsedByUser,
    expandAuto,
    sidePanelElementRef,
    sidePanelRef,
    syncCollapsedFromPanel,
    groupElementRef,
    streamPanelElementRef,
    maximized,
    sidePanelPlan,
    handleMaximizedChange,
    handleOpenPlanOverlaySplit,
    handlePlanRespond,
  };
}
