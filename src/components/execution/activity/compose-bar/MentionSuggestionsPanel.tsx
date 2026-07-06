import { createPortal } from "react-dom";
import type { RefObject } from "react";
import { cn } from "@/lib/utils.ts";
import { iconForFilePath } from "./composeUtils";

const PANEL_CLASS =
  "fixed z-[9999] backdrop-blur-[4px] bg-muted/60 border border-border/30 rounded-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)] overflow-hidden";

interface Props {
  suggestions: string[];
  highlight: number;
  panelPos: { top: number; left: number; width: number } | null;
  buttonRefs: RefObject<Map<number, HTMLButtonElement>>;
  onSelect: (path: string) => void;
}

export function MentionSuggestionsPanel({
  suggestions,
  highlight,
  panelPos,
  buttonRefs,
  onSelect,
}: Props) {
  if (!panelPos || suggestions.length === 0) return null;
  const panelStyle = {
    left: panelPos.left,
    width: panelPos.width,
    top: panelPos.top - 4,
    transform: "translateY(-100%)",
  };
  return createPortal(
    <div className={PANEL_CLASS} style={panelStyle}>
      <div className="overflow-y-auto max-h-48 p-1 custom-scrollbar">
        {suggestions.map((path, i) => (
          <button
            key={path}
            ref={(el) => {
              if (el) buttonRefs.current.set(i, el);
              else buttonRefs.current.delete(i);
            }}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(path);
            }}
            className={cn(
              "w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/15",
            )}
          >
            {iconForFilePath(
              path,
              cn(
                "w-3 h-3 shrink-0 transition-colors",
                i === highlight ? "text-accent" : "text-muted-foreground",
              ),
            )}
            <span
              className={cn(
                "font-mono text-xs truncate transition-colors",
                i === highlight ? "text-accent" : "text-foreground",
              )}
            >
              {path}
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
