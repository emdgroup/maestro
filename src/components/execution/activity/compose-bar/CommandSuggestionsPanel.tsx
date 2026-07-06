import { createPortal } from "react-dom";
import type { RefObject } from "react";
import { cn } from "@/lib/utils.ts";
import type { AvailableCommand } from "../types";

const PANEL_CLASS =
  "fixed z-[9999] backdrop-blur-[4px] bg-muted/60 border border-border/30 rounded-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)] overflow-hidden";

interface Props {
  commands: AvailableCommand[];
  highlight: number;
  panelPos: { top: number; left: number; width: number } | null;
  buttonRefs: RefObject<Map<number, HTMLButtonElement>>;
  onSelect: (cmd: AvailableCommand) => void;
}

export function CommandSuggestionsPanel({
  commands,
  highlight,
  panelPos,
  buttonRefs,
  onSelect,
}: Props) {
  if (!panelPos) return null;
  const panelStyle = {
    left: panelPos.left,
    width: panelPos.width,
    top: panelPos.top - 4,
    transform: "translateY(-100%)",
  };
  return createPortal(
    <div className={PANEL_CLASS} style={panelStyle}>
      <div className="flex max-h-48">
        <div className="overflow-y-auto shrink-0 border-r border-border/20 p-1 max-w-[40%] custom-scrollbar">
          {commands.length > 0 ? (
            commands.map((cmd, i) => (
              <button
                key={cmd.name}
                ref={(el) => {
                  if (el) buttonRefs.current.set(i, el);
                  else buttonRefs.current.delete(i);
                }}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(cmd);
                }}
                className={cn(
                  "w-full flex items-center rounded-lg px-2 py-1.5 text-left transition-colors whitespace-nowrap hover:bg-accent/15",
                )}
              >
                <span
                  className={cn(
                    "font-mono text-xs transition-colors",
                    i === highlight ? "text-accent font-medium" : "text-accent/70",
                  )}
                >
                  /{cmd.name}
                </span>
              </button>
            ))
          ) : (
            <div className="px-2 py-2 text-xs text-muted-foreground whitespace-nowrap">
              No matching commands
            </div>
          )}
        </div>
        <div className="flex-1 p-3 overflow-y-auto min-w-0 custom-scrollbar">
          {commands[highlight] && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {commands[highlight].description}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
