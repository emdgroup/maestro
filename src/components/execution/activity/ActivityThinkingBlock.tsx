import { useState, useEffect, useRef, useMemo } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import type { ThinkingItem } from "./types";
import { MarkdownBlock, getCompleteBlocksText } from "./MarkdownBlock";
import { useSettings } from "@/services/settings.service";

interface ActivityThinkingBlockProps {
  thinking: ThinkingItem;
  hasSubsequentMessage: boolean;
}

export function ActivityThinkingBlock({
  thinking,
  hasSubsequentMessage,
}: ActivityThinkingBlockProps) {
  const { data: settings } = useSettings();
  const visibility = settings?.thinking_visibility ?? "auto";

  const userToggled = useRef(false);
  const [expanded, setExpanded] = useState(() => {
    if (visibility === "collapse") return false;
    if (visibility === "show") return true;
    // "auto": expanded while streaming; hide mode doesn't matter (handled below)
    return thinking.isStreaming;
  });
  useEffect(() => {
    if (visibility === "collapse") {
      setExpanded(false);
      userToggled.current = false;
    } else if (visibility === "show") {
      setExpanded(true);
      userToggled.current = false;
    } else if (visibility === "auto") {
      setExpanded(thinking.isStreaming);
      userToggled.current = false;
    }
  }, [visibility]);

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

  // Auto mode: collapse when a subsequent agent message arrives (unless user toggled manually)
  useEffect(() => {
    if (
      visibility === "auto" &&
      hasSubsequentMessage &&
      !thinking.isStreaming &&
      !userToggled.current
    ) {
      setExpanded(false);
    }
  }, [visibility, hasSubsequentMessage, thinking.isStreaming]);

  const completedText = useMemo(() => {
    if (!isActivelyStreaming) return "";
    const safe = getCompleteBlocksText(thinking.text);
    if (safe.length > highWaterRef.current.length) {
      highWaterRef.current = safe;
    }
    return highWaterRef.current;
  }, [thinking.text, isActivelyStreaming]);

  if (visibility === "hide") return null;

  function handleToggle() {
    userToggled.current = true;
    setExpanded((v) => !v);
  }

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
        onClick={handleToggle}
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
