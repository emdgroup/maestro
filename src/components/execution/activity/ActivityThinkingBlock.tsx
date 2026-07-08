import { useState, useEffect, useRef, useMemo } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/ui/collapsible";
import type { ThinkingItem } from "./types";
import { MarkdownBlock, getCompleteBlocksText } from "./MarkdownBlock";
import { useSettings } from "@/services/settings.service";

interface ActivityThinkingBlockProps {
  thinking: ThinkingItem;
}

export function ActivityThinkingBlock({ thinking }: ActivityThinkingBlockProps) {
  const { data: settings } = useSettings();
  const visibility = settings?.thinking_visibility ?? "auto";

  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);

  // Reset user override when visibility setting changes
  const prevVisibilityRef = useRef(visibility);
  if (prevVisibilityRef.current !== visibility) {
    prevVisibilityRef.current = visibility;
    if (userExpanded !== null) setUserExpanded(null);
  }

  // Compute expanded during render — no stale render from effect
  const expanded =
    userExpanded !== null
      ? userExpanded
      : visibility === "collapse"
        ? false
        : visibility === "show"
          ? true
          : thinking.isStreaming; // "auto": expanded while streaming, collapsed otherwise

  const [isActivelyStreaming, setIsActivelyStreaming] = useState(false);
  const highWaterRef = useRef("");

  useEffect(() => {
    if (!thinking.isStreaming) {
      setIsActivelyStreaming(false);
      highWaterRef.current = "";
      return;
    }
    // New text arrived — mark as actively streaming and reset stale timer
    setIsActivelyStreaming(true);
    const id = setTimeout(() => setIsActivelyStreaming(false), 1500);
    return () => clearTimeout(id);
  }, [thinking.text, thinking.isStreaming]);

  const completedText = useMemo(() => {
    if (!isActivelyStreaming) return "";
    const safe = getCompleteBlocksText(thinking.text);
    if (safe.length > highWaterRef.current.length) {
      highWaterRef.current = safe;
    }
    return highWaterRef.current;
  }, [thinking.text, isActivelyStreaming]);

  if (visibility === "hide") return null;

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
    <Collapsible
      open={expanded}
      onOpenChange={(newOpen) => setUserExpanded(newOpen)}
      className="border-l-2 border-dashed border-border pl-3 py-1 opacity-60"
    >
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground/60 transition-colors">
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Brain className="w-3 h-3" />
        <span>Thought{expanded ? "" : " (click to expand)"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="text-xs text-muted-foreground/70 leading-relaxed mt-1.5">
        <MarkdownBlock text={thinking.text} />
      </CollapsibleContent>
    </Collapsible>
  );
}
