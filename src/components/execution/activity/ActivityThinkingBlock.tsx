import { useState, useEffect, useRef } from "react";
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

  // Staleness is tracked the same way `ActivityMessageItem` tracks it for messages: the
  // time of the last chunk in a ref, polled against the clock. `isActivelyStreaming` is
  // then derived, so a block that has finished is never actively streaming regardless of
  // the last poll and nothing has to be reset when the stream ends.
  const lastTextRef = useRef<{ text: string; time: number }>({ text: "", time: 0 });
  const [recentlyStreamed, setRecentlyStreamed] = useState(false);
  const isActivelyStreaming = thinking.isStreaming && recentlyStreamed;

  useEffect(() => {
    if (thinking.isStreaming) {
      lastTextRef.current = { text: thinking.text, time: Date.now() };
    }
  }, [thinking.text, thinking.isStreaming]);

  useEffect(() => {
    if (!thinking.isStreaming) return;
    const interval = setInterval(() => {
      setRecentlyStreamed(Date.now() - lastTextRef.current.time <= 1500);
    }, 250);
    return () => clearInterval(interval);
  }, [thinking.isStreaming]);

  // Cutting at the last complete block keeps a half-written fence from rendering as raw
  // markdown mid-stream. Pure in the text, so it is derived rather than accumulated.
  const completedText = isActivelyStreaming ? getCompleteBlocksText(thinking.text) : "";

  if (visibility === "hide") return null;

  if (thinking.isStreaming) {
    const textToRender = isActivelyStreaming ? completedText : thinking.text;
    return (
      <div className="border-l-2 border-dashed border-border pl-3 py-1.5 opacity-65">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
          <Brain className="w-3 h-3 shimmer-thinking-icon" />
          <span className="shimmer-text">Thinking</span>
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
