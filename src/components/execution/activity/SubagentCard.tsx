import { useState, useEffect, useMemo } from "react";
import { Bot, ChevronRight, Box, Loader2 } from "lucide-react";
import {
  FileText,
  Terminal,
  Pencil,
  Search,
  Trash2,
  Globe,
  Brain,
  ArrowRightLeft,
  Settings2,
} from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { formatElapsed, humanizeTokenCount } from "@/lib/format-utils";
import { MarkdownBlock } from "./MarkdownBlock";
import { TypingDots } from "./ActivityMessageItem";
import { ToolCallContentBlock } from "./ActivityToolCallGroup";
import { subagentName } from "./utils";
import { useSettings } from "@/services/settings.service";
import type { ToolCallItem } from "./types";

const KIND_ICON: Record<string, React.ElementType> = {
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Settings2,
  read_file: FileText,
  write_file: Pencil,
  edit_file: Pencil,
  create_file: Pencil,
  run_terminal: Terminal,
  bash: Terminal,
  shell: Terminal,
};

function stripUsage(text: string): string {
  return text.replace(/<usage>[\s\S]*?<\/usage>/g, "").trim();
}

function SubagentToolCallList({ items }: { items: ToolCallItem[] }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden divide-y divide-border/40">
      {items.map((tc) => {
        const Icon = KIND_ICON[tc.kind] ?? Box;
        const isReadFile = tc.kind === "read_file" || tc.kind === "read";
        const hasContent = !isReadFile && tc.content.length > 0;
        const isExpanded = expandedIds.has(tc.toolCallId);

        return (
          <div key={tc.toolCallId}>
            <button
              type="button"
              disabled={!hasContent}
              onClick={() => hasContent && toggleExpand(tc.toolCallId)}
              className={cn(
                "flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors",
                hasContent ? "cursor-pointer hover:bg-muted/30" : "cursor-default",
                isExpanded && "bg-muted/20",
                tc.status === "in_progress" && "animate-pulse",
              )}
            >
              <Icon
                className={cn(
                  "w-3.5 h-3.5 shrink-0",
                  tc.status === "error" ? "text-destructive" : "text-muted-foreground",
                )}
              />
              <span
                className={cn(
                  "font-medium truncate flex-1",
                  tc.status === "error" ? "text-destructive" : "text-foreground/80",
                )}
              >
                {tc.title}
              </span>
              {tc.status === "in_progress" && (
                <Loader2 className="w-3 h-3 animate-spin text-secondary shrink-0" />
              )}
              {tc.status === "error" && (
                <span className="text-[10px] text-destructive shrink-0">Failed</span>
              )}
            </button>
            {isExpanded && (
              <div className="px-3 pb-2.5 pt-1.5 bg-muted/10 space-y-1.5 border-t border-border/40">
                {tc.content.map((c, i) => (
                  <ToolCallContentBlock key={i} content={c} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface SubagentCardProps {
  item: ToolCallItem;
  toolCallMap: Map<string, ToolCallItem>;
}

export function SubagentCard({ item, toolCallMap }: SubagentCardProps) {
  const { data: settings } = useSettings();
  const toolCallVisibility = settings?.tool_call_visibility ?? "auto";

  const [expanded, setExpanded] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [toolCallsOpen, setToolCallsOpen] = useState(() => toolCallVisibility !== "collapse");

  useEffect(() => {
    if (toolCallVisibility === "collapse") {
      setToolCallsOpen(false);
    } else if (toolCallVisibility === "show") {
      setToolCallsOpen(true);
    }
  }, [toolCallVisibility]);
  const isStreaming = item.status === "in_progress" || item.status === "pending";

  const prompt = typeof item.rawInput?.prompt === "string" ? item.rawInput.prompt : null;

  const rawText = useMemo(() => {
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
  }, [item.content, prompt]);
  const usage = useMemo(() => {
    if (isStreaming) return null;
    const ms = item.rawInput?.totalDurationMs;
    const tokens = item.rawInput?.totalTokens;
    const tools = item.rawInput?.totalToolUseCount;
    if (typeof ms !== "number" || typeof tokens !== "number" || typeof tools !== "number")
      return null;
    return {
      duration: formatElapsed(Math.floor(ms / 1000)),
      tokens: humanizeTokenCount(tokens),
      tools: String(tools),
    };
  }, [isStreaming, item.rawInput]);
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
          <div className="text-xs font-medium text-foreground/85">{name}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {isStreaming ? (
              <TypingDots />
            ) : usage ? (
              `${usage.duration} · ${usage.tokens} tokens · ${usage.tools} tool calls`
            ) : null}
          </div>
        </div>
        <span
          className={cn(
            "text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 mt-0.5",
            isStreaming && "bg-accent/15 text-accent",
            item.status === "completed" && "bg-success/15 text-success",
            item.status === "error" && "bg-destructive/15 text-destructive",
          )}
        >
          {isStreaming ? "Running" : item.status === "completed" ? "Done" : "Failed"}
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

          {childToolCalls.length > 0 && toolCallVisibility !== "hide" && (
            <div className="border-b border-border/40">
              <button
                type="button"
                onClick={() => {
                  if (toolCallVisibility !== "show") setToolCallsOpen((v) => !v);
                }}
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
                  <SubagentToolCallList items={childToolCalls} />
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
