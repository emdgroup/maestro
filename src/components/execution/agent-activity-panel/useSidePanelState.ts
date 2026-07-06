import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { extractBodyText } from "../activity/PermissionPrompt";

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
  const [sidePanelCollapsed, setSidePanelCollapsed] = useState(false);
  const sidePanelRef = useRef<PanelImperativeHandle>(null);
  const sidePanelElementRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const [maximized, setMaximized] = useState(false);
  const [sidePanelPlan, setSidePanelPlan] = useState<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);

  useLayoutEffect(() => {
    const el = sidePanelElementRef.current;
    if (el) {
      el.style.transition = sidePanelCollapsed
        ? "flex-basis 200ms ease-in, flex-grow 200ms ease-in"
        : "flex-basis 200ms ease-out, flex-grow 200ms ease-out";
    }
    const raf = requestAnimationFrame(() => {
      if (sidePanelCollapsed) {
        sidePanelRef.current?.collapse();
        leftPanelRef.current?.expand();
      } else {
        sidePanelRef.current?.expand();
      }
    });
    const cleanup = setTimeout(() => {
      if (sidePanelElementRef.current) {
        sidePanelElementRef.current.style.transition = "";
      }
    }, 220);
    setScrollRestoreToken((v) => v + 1);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(cleanup);
      if (el) el.style.transition = "";
    };
  }, [sidePanelCollapsed, setScrollRestoreToken]);

  useEffect(() => {
    if (isSelected) {
      setMaximized(false);
      leftPanelRef.current?.expand();
    }
  }, [isSelected]);

  function handleMaximizedChange(v: boolean) {
    setMaximized(v);
    if (v) {
      setSidePanelCollapsed(false);
      leftPanelRef.current?.collapse();
    } else {
      leftPanelRef.current?.expand();
    }
  }

  useEffect(() => {
    if (!isPlanPermWithBody || !pendingPermission) return;
    if (!extractBodyText(pendingPermission.payload)) return;
    setSidePanelPlan({
      requestId: pendingPermission.requestId,
      payload: pendingPermission.payload,
    });
    setSidePanelCollapsed(false);
  }, [isPlanPermWithBody, pendingPermission]);

  const handleOpenPlanOverlaySplit = useCallback(() => {
    if (!pendingPermission) return;
    if (!extractBodyText(pendingPermission.payload)) return;
    setSidePanelPlan({
      requestId: pendingPermission.requestId,
      payload: pendingPermission.payload,
    });
    setSidePanelCollapsed(false);
  }, [pendingPermission]);

  const handlePlanRespond = useCallback(
    (requestId: string, optionId: string | null) => {
      void handlePermissionRespond(requestId, optionId);
      setSidePanelPlan(null);
    },
    [handlePermissionRespond],
  );

  return {
    sidePanelCollapsed,
    setSidePanelCollapsed,
    sidePanelRef,
    sidePanelElementRef,
    leftPanelRef,
    maximized,
    sidePanelPlan,
    handleMaximizedChange,
    handleOpenPlanOverlaySplit,
    handlePlanRespond,
  };
}
