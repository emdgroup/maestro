import { createPortal } from "react-dom";
import type { ReactNode } from "react";

const PANEL_CLASS =
  "fixed z-[9999] rounded-xl bg-card/75 dark:bg-card/25 backdrop-blur-[24px] backdrop-saturate-150 border border-foreground/9 shadow-pop overflow-hidden";

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
