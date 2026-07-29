import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";

// Must match the `minSize` props on the two panels in AgentActivityPanel.
const STREAM_MIN_REM = 42;
const SIDE_MIN_REM = 22;

/**
 * What a given viewport width allows: too narrow for both panels, or wide enough
 * (twice the stream minimum) that the panel may come back on its own.
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
  const [canAutoExpand, setCanAutoExpand] = useState(false);
  const sidePanelElementRef = useRef<HTMLDivElement>(null);
  const groupElementRef = useRef<HTMLDivElement>(null);
  const manuallyCollapsedRef = useRef(false);
  const [maximized, setMaximized] = useState(false);
  const [sidePanelPlan, setSidePanelPlan] = useState<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);

  // Animate only the collapse/expand width change — a permanent transition would
  // lag behind the resize handle while dragging.
  useLayoutEffect(() => {
    const el = sidePanelElementRef.current;
    if (el) el.style.transition = "flex-basis 200ms ease, flex-grow 200ms ease";
    const cleanup = setTimeout(() => {
      if (sidePanelElementRef.current) sidePanelElementRef.current.style.transition = "";
    }, 220);
    setScrollRestoreToken((v) => v + 1);
    return () => {
      clearTimeout(cleanup);
      if (el) el.style.transition = "";
    };
  }, [sidePanelCollapsed, setScrollRestoreToken]);

  // Width rules: under the two panels' combined minimum the side panel must collapse;
  // at twice the stream minimum there is room to bring it back on its own.
  useEffect(() => {
    const el = groupElementRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const verdict = widthVerdict(entry.contentRect.width, rem);
      if (verdict === "collapse") setSidePanelCollapsed(true);
      setCanAutoExpand(verdict === "may-expand");
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
    setSidePanelCollapsed(false);
  }, []);

  useEffect(() => {
    if (isSelected) setMaximized(false);
  }, [isSelected]);

  function handleMaximizedChange(v: boolean) {
    setMaximized(v);
    if (v) setSidePanelCollapsed(false);
  }

  useEffect(() => {
    if (!isPlanPermWithBody || !pendingPermission) return;
    setSidePanelPlan({
      requestId: pendingPermission.requestId,
      payload: pendingPermission.payload,
    });
    setSidePanelCollapsed(false);
  }, [isPlanPermWithBody, pendingPermission]);

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
    canAutoExpand,
    expandAuto,
    sidePanelElementRef,
    groupElementRef,
    maximized,
    sidePanelPlan,
    handleMaximizedChange,
    handleOpenPlanOverlaySplit,
    handlePlanRespond,
  };
}
