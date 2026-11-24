import { useContext, useEffect, useRef, useState, useMemo } from "react";
import { Reveal } from "@/components/common/Reveal";
import { Bot, Check, ChevronRight, Circle, LoaderCircle, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/lib/format-utils";
import { MarkdownBlock } from "@/components/common/markdown/MarkdownBlock";
import { TypingDots } from "./ActivityMessageItem";
import { ToolCallTimeline } from "./ToolCallTimeline";
import type { PlanEntry, ToolCallItem } from "./types";
import { subagentName } from "./utils";
import { REVEAL_EVENT, SubagentControlsContext } from "./subagent-controls";
import { subagentPhase, type SubagentPhase } from "./subagentReducer";
import { useSettings } from "@/services/settings.service";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

function stripUsage(text: string): string {
  return text.replace(/<usage>[\s\S]*?<\/usage>/g, "").trim();
}

const sectionClass =
  "flex items-center gap-1.5 w-full px-3.5 py-2 text-[10px] font-semibold uppercase tracking-wide text-accent/55 bg-accent/[0.06] hover:text-accent hover:bg-accent/[0.09] transition-colors text-left";

function ChecklistEntry({ entry }: { entry: PlanEntry }) {
  const done = entry.status === "completed";
  const Icon = done ? Check : entry.status === "in_progress" ? LoaderCircle : Circle;
  return (
    <li className="flex items-start gap-2">
      <Icon
        className={cn(
          "mt-0.5 size-3 shrink-0",
          done ? "text-success" : "text-muted-foreground/60",
          entry.status === "in_progress" && "animate-spin text-accent",
        )}
      />
      <span className={cn(done && "text-muted-foreground line-through")}>{entry.content}</span>
    </li>
  );
}

const PHASE_LABEL: Record<SubagentPhase, string> = {
  running: "Running",
  needs: "Needs you",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
  unknown: "Unknown",
};

/** Tool calls by what they did, for the card's second stats line. */
function kindBreakdown(calls: ToolCallItem[]): string | null {
  const counts = { reads: 0, searches: 0, bash: 0, edits: 0 };
  for (const tc of calls) {
    if (tc.kind === "read") counts.reads++;
    else if (tc.kind === "search") counts.searches++;
    else if (tc.kind === "execute") counts.bash++;
    else if (tc.kind === "edit" || tc.kind === "delete" || tc.kind === "move") counts.edits++;
  }
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

const pillClass =
  "text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 mt-0.5";

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
  const [checklistOpen, setChecklistOpen] = useState(true);

  const facts = item.meta?.subagent;
  const sessionId = facts?.sessionId ?? "";
  const controls = useContext(SubagentControlsContext);
  const waiting = !!controls?.waiting.has(sessionId);
  const phase: SubagentPhase = waiting ? "needs" : subagentPhase(item);
  const isStreaming = phase === "running" || phase === "needs";
  const [stopAsked, setStopAsked] = useState(false);
  const canStop = !!controls && !!facts?.canCancel && isStreaming;

  // A chip elsewhere in the stream (Codex's `wait` row) asks for this card.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onReveal = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== sessionId) return;
      setExpanded(true);
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [sessionId]);

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

  const children = useMemo(
    () =>
      (item.childToolCallIds ?? [])
        .map((id) => toolCallMap.get(id))
        .filter((tc): tc is ToolCallItem => tc != null),
    [item.childToolCallIds, toolCallMap],
  );
  const childToolCalls = useMemo(() => children.filter((tc) => !tc.meta?.subagent), [children]);
  const nestedSubagents = useMemo(() => children.filter((tc) => tc.meta?.subagent), [children]);

  // Elapsed only for a run watched from start to end: ACP reports no duration.
  const startedAt = facts?.startedAt;
  const endedAt = facts?.endedAt;
  const usage = useMemo(() => {
    if (isStreaming) return null;
    const parts: string[] = [];
    if (startedAt !== undefined && endedAt !== undefined) {
      parts.push(formatElapsed(Math.floor((endedAt - startedAt) / 1000)));
    }
    parts.push(`${childToolCalls.length} tool call${childToolCalls.length === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }, [isStreaming, startedAt, endedAt, childToolCalls.length]);
  const toolBreakdown = useMemo(() => kindBreakdown(childToolCalls), [childToolCalls]);
  const displayText = useMemo(() => {
    let text = stripUsage(rawText);
    if (prompt && text.startsWith(prompt)) {
      text = text.slice(prompt.length).trim();
    }
    return text;
  }, [rawText, prompt]);
  const name = subagentName(item);
  const checklist = item.plan ?? [];
  const stepsDone = checklist.filter((e) => e.status === "completed").length;
  const currentStep = checklist.find((e) => e.status === "in_progress")?.content;

  // Expanding a subagent that has produced no output yet shows the prompt instead of an
  // empty card. Adjusted during render rather than from an effect so the empty state is
  // never painted first; the user can still collapse the prompt afterwards.
  const [promptNudge, setPromptNudge] = useState({ expanded, hasText: !!displayText });
  if (promptNudge.expanded !== expanded || promptNudge.hasText !== !!displayText) {
    setPromptNudge({ expanded, hasText: !!displayText });
    if (expanded && !displayText) setPromptOpen(true);
  }

  return (
    <div
      ref={rootRef}
      data-subagent={sessionId}
      className={cn(
        "group/card rounded-[10px] overflow-hidden",
        phase === "needs"
          ? "border border-warning/50 bg-gradient-to-br from-warning/12 to-transparent"
          : "border border-accent/30 bg-gradient-to-br from-accent/10 to-transparent",
        "shadow-[0_2px_8px_oklch(0%_0_0/0.08)]",
      )}
    >
      {/* The expand button covers the header, so the status pill can be a control of its own
          on top of it without nesting one button in another. */}
      <div className="relative flex items-start gap-2.5 px-3.5 py-2.5 hover:brightness-110 transition-[filter]">
        <button
          type="button"
          onClick={() => {
            if (waiting) controls?.showRequest(sessionId);
            setExpanded((v) => !v);
          }}
          aria-expanded={expanded}
          aria-label={name}
          className="absolute inset-0"
        />
        <div className="w-7 h-7 rounded-[7px] bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="w-3.5 h-3.5 text-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground/85">{name}</span>
            {[item.meta?.model, item.meta?.agentType].filter(Boolean).map((tag) => (
              <span
                key={tag}
                className="shrink-0 rounded-full border border-accent/30 px-1.5 text-[9px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {phase === "needs" ? (
              "Waiting for your approval"
            ) : isStreaming ? (
              stopAsked ? (
                "Stopping…"
              ) : checklist.length > 0 ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <TypingDots />
                  <span className="shrink-0 tabular-nums">
                    {stepsDone}/{checklist.length}
                  </span>
                  {currentStep && <span className="truncate">{currentStep}</span>}
                </span>
              ) : (
                <TypingDots />
              )
            ) : phase === "failed" && facts?.error ? (
              <span className="text-destructive/80">{facts.error}</span>
            ) : (
              usage
            )}
          </div>
          {!isStreaming && toolBreakdown && (
            <div className="text-[10px] text-muted-foreground/70">{toolBreakdown}</div>
          )}
        </div>
        {canStop && !stopAsked ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Stop ${name}`}
                  onClick={() => {
                    setStopAsked(true);
                    controls?.stop(sessionId);
                  }}
                  className={cn(
                    pillClass,
                    // Both labels share one cell, so the pill keeps its width when it turns into Stop.
                    "group/pill relative grid bg-accent/15 text-accent transition-colors",
                    // Hovering anywhere on the card offers the stop; hovering the pill itself is the one that takes it.
                    "group-hover/card:bg-destructive/10 group-hover/card:text-destructive hover:bg-destructive/20 focus-visible:bg-destructive/15 focus-visible:text-destructive",
                  )}
                />
              }
            >
              <span className="col-start-1 row-start-1 group-hover/card:invisible group-focus-visible/pill:invisible">
                {PHASE_LABEL[phase]}
              </span>
              <span className="invisible col-start-1 row-start-1 inline-flex items-center justify-center gap-1 group-hover/card:visible group-focus-visible/pill:visible">
                <Square className="size-2 fill-current" />
                Stop
              </span>
            </TooltipTrigger>
            <TooltipContent>Stop this subagent</TooltipContent>
          </Tooltip>
        ) : (
          <span
            className={cn(
              pillClass,
              phase === "running" && "bg-accent/15 text-accent",
              phase === "needs" && "bg-warning/20 text-warning",
              phase === "stopped" && "bg-warning/15 text-warning",
              phase === "done" && "bg-success/15 text-success",
              phase === "failed" && "bg-destructive/15 text-destructive",
              phase === "unknown" && "bg-muted text-muted-foreground",
            )}
          >
            {PHASE_LABEL[phase]}
          </span>
        )}
        <ChevronRight
          className={cn(
            "w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5 opacity-50 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
      </div>

      <Reveal open={expanded}>
        <div className="border-t border-accent/20">
          {prompt && (
            <div className="border-b border-border/40">
              <button
                type="button"
                onClick={() => setPromptOpen((v) => !v)}
                className={sectionClass}
              >
                <ChevronRight
                  className={cn(
                    "w-3 h-3 transition-transform duration-150",
                    promptOpen && "rotate-90",
                  )}
                />
                Prompt
              </button>
              <Reveal open={promptOpen}>
                <div className="px-3.5 py-2.5 bg-accent/[0.06] text-[11px] border-t border-accent/10">
                  <MarkdownBlock text={prompt} />
                </div>
              </Reveal>
            </div>
          )}

          {checklist.length > 0 && (
            <div className="border-b border-border/40">
              <button
                type="button"
                onClick={() => setChecklistOpen((v) => !v)}
                className={sectionClass}
              >
                <ChevronRight
                  className={cn(
                    "w-3 h-3 transition-transform duration-150",
                    checklistOpen && "rotate-90",
                  )}
                />
                Checklist ({stepsDone}/{checklist.length})
              </button>
              <Reveal open={checklistOpen}>
                <ul className="flex flex-col gap-1 px-3.5 py-2.5 bg-accent/[0.03] text-[11px] border-t border-accent/10">
                  {checklist.map((entry, i) => (
                    <ChecklistEntry key={i} entry={entry} />
                  ))}
                </ul>
              </Reveal>
            </div>
          )}

          {childToolCalls.length > 0 && toolCallsVisible && (
            <div className="border-b border-border/40">
              <button
                type="button"
                onClick={() => setToolCallsOpen((v) => !v)}
                className={sectionClass}
              >
                <ChevronRight
                  className={cn(
                    "w-3 h-3 transition-transform duration-150",
                    toolCallsOpen && "rotate-90",
                  )}
                />
                Tool Calls ({childToolCalls.length})
              </button>
              <Reveal open={toolCallsOpen}>
                <div className="px-2 py-2 bg-accent/[0.03] border-t border-accent/10">
                  <ToolCallTimeline items={childToolCalls} />
                </div>
              </Reveal>
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

          {/* Subagents this one started, each a card of its own. */}
          {nestedSubagents.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-border/40 px-3.5 py-2.5 pl-6">
              {nestedSubagents.map((nested) => (
                <SubagentCard key={nested.toolCallId} item={nested} toolCallMap={toolCallMap} />
              ))}
            </div>
          )}
        </div>
      </Reveal>
    </div>
  );
}
