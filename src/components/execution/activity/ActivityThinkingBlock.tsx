import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib";
import type { ThinkingItem } from "./types";

interface ActivityThinkingBlockProps {
  thinking: ThinkingItem;
}

export function ActivityThinkingBlock({ thinking }: ActivityThinkingBlockProps) {
  const [expanded, setExpanded] = useState(thinking.isStreaming);

  // Auto-collapse when streaming ends — handled by parent re-rendering with isStreaming=false
  // which causes the default expanded=false on new mount (streaming block is replaced)

  if (thinking.isStreaming) {
    return (
      <div className="ml-9 border-l-2 border-dashed border-border pl-3 py-1.5 opacity-65">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
          <Brain className="w-3 h-3" />
          <span>Thinking</span>
          <ShimmerBar />
        </div>
        <p className="text-xs text-muted-foreground/70 leading-relaxed line-clamp-3">
          {thinking.text}
        </p>
      </div>
    );
  }

  return (
    <div className="ml-9 border-l-2 border-dashed border-border pl-3 py-1 opacity-60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground/60 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        <Brain className="w-3 h-3" />
        <span>Thought{expanded ? "" : " (click to expand)"}</span>
      </button>
      {expanded && (
        <p className={cn("text-xs text-muted-foreground/70 leading-relaxed mt-1.5 whitespace-pre-wrap")}>
          {thinking.text}
        </p>
      )}
    </div>
  );
}

function ShimmerBar() {
  return (
    <span
      className="inline-block w-14 h-[7px] rounded-sm"
      style={{
        background: "linear-gradient(90deg, var(--muted) 25%, var(--muted-foreground) 50%, var(--muted) 75%)",
        backgroundSize: "200%",
        animation: "shimmer 1.5s infinite",
      }}
    />
  );
}
