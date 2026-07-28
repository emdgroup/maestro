import { useState, useEffect, useMemo } from "react";
import { Bot, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { formatElapsed, humanizeTokenCount } from "@/lib/format-utils";
import { MarkdownBlock } from "./MarkdownBlock";
import { TypingDots } from "./ActivityMessageItem";
import { ToolCallTimeline } from "./ToolCallTimeline";
import { subagentName } from "./utils";
import { useSettings } from "@/services/settings.service";
import type { ToolCallItem } from "./types";

function stripUsage(text: string): string {
  return text.replace(/<usage>[\s\S]*?<\/usage>/g, "").trim();
}

interface SubagentCardProps {
  item: ToolCallItem;
  toolCallMap: Map<string, ToolCallItem>;
}

export function SubagentCard({ item, toolCallMap }: SubagentCardProps) {
  const { data: settings } = useSettings();
  const toolCallsVisible = settings?.tool_call_visibility !== "hide";

  const [expanded, setExpanded] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [toolCallsOpen, setToolCallsOpen] = useState(true);

  const isStreaming = item.status === "in_progress" || item.status === "pending";
  const isInterrupted = item.status === "interrupted";

  const prompt = typeof item.rawInput?.prompt === "string" ? item.rawInput.prompt : null;

  // Only the open card reads this. Collapsed, a streaming subagent would otherwise
  // re-join and re-scan its whole transcript on every chunk for nothing.
  const rawText = useMemo(() => {
    if (!expanded) return "";
    const textBlocks = item.content
      .filter(
        (c): c is { type: "content"; content: { type: "text"; text: string } } =>
          c.type === "content",
      )
      .map((c) => c.content.text);
    if (prompt && textBlocks.length > 0 && textBlocks[0].trim() === prompt.trim()) {
      return textBlocks.slice(1).join("");
    }
    return textBlocks.join("");
  }, [expanded, item.content, prompt]);
  const usage = useMemo(() => {
    if (isStreaming) return null;
    const meta = item.meta;
    const ms = meta?.totalDurationMs;
    const tokens = meta?.totalTokens;
    const tools = meta?.totalToolUseCount;
    if (typeof ms !== "number" || typeof tokens !== "number" || typeof tools !== "number")
      return null;
    // A headline token count is mostly cache reads. Splitting it says what the run
    // actually cost, and the split is only shown when the agent reported one.
    const parts = [formatElapsed(Math.floor(ms / 1000))];
    if (meta?.outputTokens != null && meta?.cachedTokens != null) {
      parts.push(
        `${humanizeTokenCount(meta.outputTokens)} out`,
        `${humanizeTokenCount(meta.cachedTokens)} cached`,
      );
    } else {
      parts.push(`${humanizeTokenCount(tokens)} tokens`);
    }
    parts.push(`${tools} tool calls`);
    return parts.join(" · ");
  }, [isStreaming, item.meta]);

  const toolBreakdown = useMemo(() => {
    const stats = item.meta?.toolStats;
    if (!stats) return null;
    const parts: string[] = [];
    const add = (n: number | undefined, label: string) => {
      if (n) parts.push(`${n} ${label}`);
    };
    add(stats.reads, "reads");
    add(stats.searches, "searches");
    add(stats.bash, "bash");
    add(stats.edits, "edits");
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [item.meta]);
  const displayText = useMemo(() => {
    let text = stripUsage(rawText);
    if (prompt && text.startsWith(prompt)) {
      text = text.slice(prompt.length).trim();
    }
    return text;
  }, [rawText, prompt]);
  const name = subagentName(item);

  const childToolCalls = useMemo(() => {
    if (!item.childToolCallIds || item.childToolCallIds.length === 0) return [];
    return item.childToolCallIds
      .map((id) => toolCallMap.get(id))
      .filter((tc): tc is ToolCallItem => tc != null);
  }, [item.childToolCallIds, toolCallMap]);

  useEffect(() => {
    if (expanded && !displayText) {
      setPromptOpen(true);
    }
  }, [expanded, displayText]);

  return (
    <div
      className={cn(
        "rounded-[10px] overflow-hidden",
        "border border-accent/30 bg-gradient-to-br from-accent/10 to-transparent",
        "shadow-[0_2px_8px_oklch(0%_0_0/0.08)]",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-start gap-2.5 w-full px-3.5 py-2.5 text-left hover:brightness-110 transition-[filter]"
      >
        <div className="w-7 h-7 rounded-[7px] bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="w-3.5 h-3.5 text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground/85">{name}</span>
            {item.meta?.model && (
              <span className="shrink-0 rounded-full border border-accent/30 px-1.5 text-[9px] text-muted-foreground">
                {item.meta.model}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {isStreaming ? (
              <TypingDots />
            ) : isInterrupted ? (
              <span className="text-warning/70">Session interrupted</span>
            ) : (
              usage
            )}
          </div>
          {!isStreaming && toolBreakdown && (
            <div className="text-[10px] text-muted-foreground/70">{toolBreakdown}</div>
          )}
        </div>
        <span
          className={cn(
            "text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 mt-0.5",
            isStreaming && "bg-accent/15 text-accent",
            isInterrupted && "bg-warning/15 text-warning",
            item.status === "completed" && "bg-success/15 text-success",
            item.status === "error" && "bg-destructive/15 text-destructive",
          )}
        >
          {isStreaming
            ? "Running"
            : isInterrupted
              ? "Interrupted"
              : item.status === "completed"
                ? "Done"
                : "Failed"}
        </span>
        <ChevronRight
          className={cn(
            "w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5 opacity-50 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-accent/20">
          {prompt && (
            <div className="border-b border-border/40">
              <button
                type="button"
                onClick={() => setPromptOpen((v) => !v)}
                className="flex items-center gap-1.5 w-full px-3.5 py-2 text-[10px] font-semibold uppercase tracking-wide text-accent/55 bg-accent/[0.06] hover:text-accent hover:bg-accent/[0.09] transition-colors text-left"
              >
                <ChevronRight
                  className={cn(
                    "w-3 h-3 transition-transform duration-150",
                    promptOpen && "rotate-90",
                  )}
                />
                Prompt
              </button>
              {promptOpen && (
                <div className="px-3.5 py-2.5 bg-accent/[0.06] text-[11px] border-t border-accent/10">
                  <MarkdownBlock text={prompt} />
                </div>
              )}
            </div>
          )}

          {childToolCalls.length > 0 && toolCallsVisible && (
            <div className="border-b border-border/40">
              <button
                type="button"
                onClick={() => setToolCallsOpen((v) => !v)}
                className="flex items-center gap-1.5 w-full px-3.5 py-2 text-[10px] font-semibold uppercase tracking-wide text-accent/55 bg-accent/[0.06] hover:text-accent hover:bg-accent/[0.09] transition-colors text-left"
              >
                <ChevronRight
                  className={cn(
                    "w-3 h-3 transition-transform duration-150",
                    toolCallsOpen && "rotate-90",
                  )}
                />
                Tool Calls ({childToolCalls.length})
              </button>
              {toolCallsOpen && (
                <div className="px-2 py-2 bg-accent/[0.03] border-t border-accent/10">
                  <ToolCallTimeline items={childToolCalls} />
                </div>
              )}
            </div>
          )}

          <div className="px-3.5 py-3 text-xs leading-relaxed">
            {displayText ? (
              <>
                <MarkdownBlock text={displayText} />
                {isStreaming && (
                  <span className="mt-1 block">
                    <TypingDots />
                  </span>
                )}
              </>
            ) : isStreaming ? (
              <TypingDots />
            ) : (
              <span className="text-muted-foreground italic">No output.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
