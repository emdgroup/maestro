import { useState, useEffect, useRef, useMemo } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import type { ThinkingItem } from "./types";
import { MarkdownBlock, getCompleteBlocksText } from "./MarkdownBlock";

interface ActivityThinkingBlockProps {
  thinking: ThinkingItem;
}

export function ActivityThinkingBlock({ thinking }: ActivityThinkingBlockProps) {
  const [expanded, setExpanded] = useState(thinking.isStreaming);
  const lastTextRef = useRef<{ text: string; time: number }>({ text: "", time: 0 });
  const [isActivelyStreaming, setIsActivelyStreaming] = useState(false);
  const highWaterRef = useRef("");

  useEffect(() => {
    if (thinking.isStreaming) {
      lastTextRef.current = { text: thinking.text, time: Date.now() };
    } else {
      highWaterRef.current = "";
    }
  }, [thinking.text, thinking.isStreaming]);

  useEffect(() => {
    if (!thinking.isStreaming) {
      setIsActivelyStreaming(false);
      return;
    }
    const interval = setInterval(() => {
      const stale = Date.now() - lastTextRef.current.time > 1500;
      setIsActivelyStreaming(!stale);
    }, 250);
    return () => clearInterval(interval);
  }, [thinking.isStreaming]);

  const completedText = useMemo(() => {
    if (!isActivelyStreaming) return "";
    const safe = getCompleteBlocksText(thinking.text);
    if (safe.length > highWaterRef.current.length) {
      highWaterRef.current = safe;
    }
    return highWaterRef.current;
  }, [thinking.text, isActivelyStreaming]);

  // Auto-collapse when streaming ends — handled by parent re-rendering with isStreaming=false
  // which causes the default expanded=false on new mount (streaming block is replaced)

  if (thinking.isStreaming) {
    const textToRender = isActivelyStreaming ? completedText : thinking.text;
    return (
      <div className="border-l-2 border-dashed border-border pl-3 py-1.5 opacity-65">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
          <Brain className="w-3 h-3 shimmer-thinking-icon" />
          <span className="shimmer-thinking-text">Thinking</span>
        </div>
        <div className="text-xs text-muted-foreground/70 leading-relaxed">
          {textToRender ? <MarkdownBlock text={textToRender} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="border-l-2 border-dashed border-border pl-3 py-1 opacity-60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground/60 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Brain className="w-3 h-3" />
        <span>Thought{expanded ? "" : " (click to expand)"}</span>
      </button>
      {expanded && (
        <div className={cn("text-xs text-muted-foreground/70 leading-relaxed mt-1.5")}>
          <MarkdownBlock text={thinking.text} />
        </div>
      )}
    </div>
  );
}
