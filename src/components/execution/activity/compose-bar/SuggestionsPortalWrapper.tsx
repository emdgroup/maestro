import { createPortal } from "react-dom";
import type { ReactNode } from "react";

const PANEL_CLASS =
  "fixed z-[9999] backdrop-blur-[4px] bg-muted/60 border border-border/30 rounded-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)] overflow-hidden";

interface SuggestionsPortalWrapperProps {
  panelPos: { left: number; width: number; top: number };
  children: ReactNode;
}

export function SuggestionsPortalWrapper({ panelPos, children }: SuggestionsPortalWrapperProps) {
  const panelStyle = {
    left: panelPos.left,
    width: panelPos.width,
    top: panelPos.top - 4,
    transform: "translateY(-100%)",
  };
  return createPortal(
    <div className={PANEL_CLASS} style={panelStyle}>
      {children}
    </div>,
    document.body,
  );
}
