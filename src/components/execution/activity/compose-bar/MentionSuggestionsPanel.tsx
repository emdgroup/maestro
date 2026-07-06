import type { RefObject } from "react";
import { cn } from "@/lib/utils.ts";
import { iconForFilePath } from "./composeUtils";
import { SuggestionsPortalWrapper } from "./SuggestionsPortalWrapper";

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
  return (
    <SuggestionsPortalWrapper panelPos={panelPos}>
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
    </SuggestionsPortalWrapper>
  );
}
