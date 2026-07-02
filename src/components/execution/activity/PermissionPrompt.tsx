import { useEffect, useMemo, useRef, useState } from "react";
import {
  Shield,
  Pencil,
  Terminal,
  Eye,
  Trash2,
  ShieldCheck,
  ShieldEllipsis,
  ShieldAlert,
  ShieldOff,
  ChevronLeft,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/ui/button";
import { cn } from "@/lib/ui-utils";
import { MarkdownBlock } from "./MarkdownBlock";
import type { ToolCallItem } from "@/components/execution/activity/types.ts";

interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

interface PermissionPromptProps {
  requestId: string;
  payload: Record<string, unknown>;
  onRespond: (requestId: string, optionId: string | null) => void;
  fullHeight?: boolean;
}

export function isAllowKind(kind: string): boolean {
  return kind === "allow_once" || kind === "allow_always";
}

function extractOptions(payload: Record<string, unknown>): PermissionOption[] | null {
  const opts = payload.options;
  if (!Array.isArray(opts) || opts.length === 0) return null;
  return opts as PermissionOption[];
}

function extractTitle(payload: Record<string, unknown>): string {
  const toolCall = payload.toolCall as Record<string, unknown> | undefined;
  const title = toolCall?.title as string | undefined;
  if (title) return title;
  const tool = payload.tool as string | undefined;
  if (!tool) return "Action";
  const map: Record<string, string> = {
    write_file: "Write file",
    read_file: "Read file",
    execute_command: "Run command",
    bash: "Run command",
    shell: "Run command",
    edit_file: "Edit file",
    delete_file: "Delete file",
    create_file: "Create file",
  };
  return map[tool] ?? tool;
}

export function extractBodyText(payload: Record<string, unknown>): string | null {
  const toolCall = payload.toolCall as Record<string, unknown> | undefined;
  const content = toolCall?.content as Array<Record<string, unknown>> | undefined;
  if (!content) return null;
  const texts: string[] = [];
  for (const c of content) {
    // Direct text block (legacy/simplified format)
    if (c.type === "text" && typeof c.text === "string") {
      texts.push(c.text as string);
    }
    // ACP ToolCallContent::Content format: {type:"content", content:{type:"text", text:"..."}}
    if (c.type === "content") {
      const inner = c.content as Record<string, unknown> | undefined;
      if (inner?.type === "text" && typeof inner.text === "string") {
        texts.push(inner.text as string);
      }
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : null;
}

export function isPlanPermission(payload: Record<string, unknown>): boolean {
  const toolCall = payload.toolCall as ToolCallItem | undefined;
  return !!toolCall && isPlanToolCallItem(toolCall);
}

export function isPlanToolCallItem(tc: ToolCallItem): boolean {
  return tc.kind === "switch_mode";
}

function LegacyButtons({
  requestId,
  onRespond,
}: {
  requestId: string;
  onRespond: (requestId: string, optionId: string | null) => void;
}) {
  return (
    <div className="flex gap-2">
      <Button variant="ghost" size="sm" onClick={() => onRespond(requestId, null)}>
        Deny
      </Button>
      <Button variant="accent" size="sm" onClick={() => onRespond(requestId, "allow")}>
        Allow
      </Button>
    </div>
  );
}

const BODY_COLLAPSE_LIMIT = 300;

// ── Accept option metadata ────────────────────────────────────────────────────

type AcceptMeta = { icon: React.ElementType; description: string; order: number };

const OPTION_META: Record<string, AcceptMeta> = {
  default: { icon: ShieldCheck, description: "Approve each tool use", order: 0 },
  acceptEdits: { icon: ShieldEllipsis, description: "File ops auto-approved", order: 1 },
  auto: { icon: ShieldAlert, description: "All tools, full session", order: 2 },
  bypassPermissions: { icon: ShieldOff, description: "No safety checks", order: 3 },
};

function getAcceptMeta(option: PermissionOption): AcceptMeta {
  return OPTION_META[option.optionId] ?? { icon: ShieldCheck, description: "", order: 99 };
}

function isBypassOption(optionId: string): boolean {
  return optionId === "bypassPermissions";
}

function KbdHint({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1.25 py-px rounded-[3px] text-[10px] font-medium font-mono bg-black/10 border border-black/10 opacity-60 leading-[1.6] shrink-0">
      {label}
    </span>
  );
}

// ── Layout tier ───────────────────────────────────────────────────────────────

type LayoutTier = "wide" | "medium" | "narrow";

function useLayoutTier(ref: React.RefObject<HTMLDivElement | null>): LayoutTier {
  const [tier, setTier] = useState<LayoutTier>("wide");
  useEffect(() => {
    if (!ref.current) return;
    const obs = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setTier(w >= 900 ? "wide" : w >= 500 ? "medium" : "narrow");
    });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [ref]);
  return tier;
}

// ── Compact option row (medium / narrow stacks) ───────────────────────────────

interface StackOptionButtonProps {
  opt: PermissionOption;
  idx: number;
  requestId: string;
  onRespond: (requestId: string, optionId: string | null) => void;
  isFirst?: boolean;
}

function StackOptionButton({ opt, idx, requestId, onRespond, isFirst }: StackOptionButtonProps) {
  const meta = getAcceptMeta(opt);
  const isBypass = isBypassOption(opt.optionId);
  return (
    <button
      onClick={() => onRespond(requestId, opt.optionId)}
      className={cn(
        "w-full flex items-center gap-2.5 px-3 py-2 text-left bg-transparent border-none",
        "transition-colors duration-100",
        !isFirst && "border-t border-border/20",
        isBypass ? "bg-warning/8 hover:bg-warning/16" : "hover:bg-muted/60",
      )}
    >
      <span
        className={cn(
          "shrink-0 leading-none",
          isBypass ? "text-warning/60" : "text-muted-foreground",
        )}
      >
        <meta.icon size={15} />
      </span>
      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span
          className={cn(
            "text-[11px] font-semibold leading-[1.2]",
            isBypass ? "text-warning/75" : "text-muted-foreground",
          )}
        >
          {opt.name}
        </span>
        <span
          className={cn(
            "text-[10px] leading-[1.3]",
            isBypass ? "text-warning/45" : "text-muted-foreground/50",
          )}
        >
          {meta.description}
        </span>
      </span>
      <KbdHint label={String(idx + 1)} />
    </button>
  );
}

// ── Plan overlay ──────────────────────────────────────────────────────────────

interface PlanPermissionOverlayProps {
  requestId: string;
  bodyText: string | null;
  options: PermissionOption[] | null;
  onRespond: (requestId: string, optionId: string | null) => void;
}

function PlanPermissionOverlay({
  requestId,
  bodyText,
  options,
  onRespond,
}: PlanPermissionOverlayProps) {
  const acceptOptions = useMemo(
    () =>
      options
        ? options
            .filter((o) => isAllowKind(o.kind))
            .sort((a, b) => getAcceptMeta(a).order - getAcceptMeta(b).order)
        : [],
    [options],
  );
  const rejectOption = options ? (options.find((o) => !isAllowKind(o.kind)) ?? null) : null;
  const primaryOption = acceptOptions[0] ?? null;
  const stackOptions = acceptOptions.slice(1);

  const barRef = useRef<HTMLDivElement>(null);
  const tier = useLayoutTier(barRef);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [tier]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onRespond(requestId, rejectOption?.optionId ?? null);
        return;
      }
      const idx = parseInt(e.key, 10) - 1;
      if (!isNaN(idx) && idx >= 0 && idx < acceptOptions.length) {
        onRespond(requestId, acceptOptions[idx].optionId);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [requestId, acceptOptions, rejectOption, onRespond]);

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      {/* Scrollable plan content — bottom padding clears the floating bar */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-5 pt-4 pb-30">
        {bodyText && (
          <div className="text-sm leading-relaxed text-foreground">
            <MarkdownBlock text={bodyText} />
          </div>
        )}
      </div>

      {/* Floating glass action area */}
      <div className="absolute bottom-0 left-0 right-0 px-3 pb-3 pt-1 pointer-events-none">
        <div
          ref={barRef}
          className="pointer-events-auto rounded-2xl backdrop-blur-xs bg-muted/60 border border-border/30 overflow-hidden shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)]"
        >
          {/* ── Wide tier: horizontal row ── */}
          {tier === "wide" && (
            <>
              {acceptOptions.length > 0 && (
                <div className="flex border-b border-border/30">
                  {acceptOptions.map((opt, idx) => {
                    const meta = getAcceptMeta(opt);
                    const isBypass = isBypassOption(opt.optionId);
                    return (
                      <Button
                        key={opt.optionId}
                        variant="ghost"
                        onClick={() => onRespond(requestId, opt.optionId)}
                        className={cn(
                          "group flex-1 flex flex-row items-center justify-center gap-2.25 px-2.5 py-2.75 h-auto",
                          "transition-colors duration-100 border-none bg-transparent",
                          idx > 0 && "border-l border-border/30",
                          isBypass ? "bg-warning/12 hover:bg-warning/20" : "hover:bg-muted/60",
                        )}
                      >
                        <span
                          className={cn(
                            "shrink-0 transition-colors duration-100 leading-none",
                            isBypass
                              ? "text-warning/60 group-hover:text-warning"
                              : "text-muted-foreground group-hover:text-foreground",
                          )}
                        >
                          <meta.icon size={16} />
                        </span>
                        <span className="flex flex-col gap-0.5 text-left min-w-0">
                          <span className="flex items-center gap-1">
                            <span
                              className={cn(
                                "text-[11px] font-semibold leading-[1.2] whitespace-nowrap transition-colors duration-100",
                                isBypass
                                  ? "text-warning/75 group-hover:text-warning"
                                  : "text-muted-foreground group-hover:text-foreground",
                              )}
                            >
                              {opt.name}
                            </span>
                            <KbdHint label={String(idx + 1)} />
                          </span>
                          <span
                            className={cn(
                              "text-[10px] leading-[1.3] whitespace-nowrap transition-colors duration-100",
                              isBypass
                                ? "text-warning/45 group-hover:text-warning/65"
                                : "text-muted-foreground/50 group-hover:text-muted-foreground",
                            )}
                          >
                            {meta.description}
                          </span>
                        </span>
                      </Button>
                    );
                  })}
                </div>
              )}
              <Button
                variant="ghost"
                onClick={() => onRespond(requestId, rejectOption?.optionId ?? null)}
                className="w-full flex items-center justify-center gap-2 px-3.5 py-2 h-auto transition-colors duration-100 border-none bg-transparent hover:bg-muted/60"
              >
                <span className="text-muted-foreground/40 leading-none transition-colors duration-100">
                  <ChevronLeft size={13} />
                </span>
                <span className="text-[12px] font-medium text-muted-foreground transition-colors duration-100">
                  {rejectOption?.name ?? "Keep planning"}
                </span>
                <KbdHint label="Esc" />
              </Button>
            </>
          )}

          {/* ── Medium tier: 2 equal columns ── */}
          {tier === "medium" && (
            <div className="flex items-stretch">
              {/* Left: reject — flex-1, stretches to full bar height */}
              <button
                onClick={() => onRespond(requestId, rejectOption?.optionId ?? null)}
                className="flex-1 flex flex-col items-center justify-center gap-1 py-2 px-3
                           border-r border-border/30 bg-transparent
                           hover:bg-muted/60 transition-colors duration-100
                           text-muted-foreground/50 hover:text-muted-foreground"
              >
                <span className="text-[10px] font-medium leading-tight text-center">
                  {rejectOption?.name ?? "Keep planning"}
                </span>
                <KbdHint label="Esc" />
              </button>
              {/* Right: approve — options column + shared chevron column */}
              <div className="flex-1 flex items-stretch min-w-0">
                <div className="flex-1 flex flex-col min-w-0">
                  {primaryOption && (
                    <StackOptionButton
                      opt={primaryOption}
                      idx={0}
                      requestId={requestId}
                      onRespond={onRespond}
                      isFirst={true}
                    />
                  )}
                  {expanded &&
                    stackOptions.map((opt, i) => (
                      <StackOptionButton
                        key={opt.optionId}
                        opt={opt}
                        idx={i + 1}
                        requestId={requestId}
                        onRespond={onRespond}
                        isFirst={false}
                      />
                    ))}
                </div>
                {stackOptions.length > 0 && (
                  <>
                    <div className="w-px bg-border/30" />
                    <button
                      onClick={() => setExpanded((v) => !v)}
                      className="w-8 shrink-0 flex items-center justify-center bg-transparent
                                 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/60
                                 transition-colors duration-100"
                    >
                      <ChevronDown
                        size={13}
                        className={cn(
                          "transition-transform duration-200",
                          expanded && "rotate-180",
                        )}
                      />
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── Narrow tier: single column ── */}
          {tier === "narrow" && (
            <div className="flex flex-col">
              {/* Approve: options column + shared chevron column */}
              <div className="flex items-stretch">
                <div className="flex-1 flex flex-col min-w-0">
                  {primaryOption && (
                    <StackOptionButton
                      opt={primaryOption}
                      idx={0}
                      requestId={requestId}
                      onRespond={onRespond}
                      isFirst={true}
                    />
                  )}
                  {expanded &&
                    stackOptions.map((opt, i) => (
                      <StackOptionButton
                        key={opt.optionId}
                        opt={opt}
                        idx={i + 1}
                        requestId={requestId}
                        onRespond={onRespond}
                        isFirst={false}
                      />
                    ))}
                </div>
                {stackOptions.length > 0 && (
                  <>
                    <div className="w-px bg-border/30" />
                    <button
                      onClick={() => setExpanded((v) => !v)}
                      className="w-8 shrink-0 flex items-center justify-center bg-transparent
                                 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/60
                                 transition-colors duration-100"
                    >
                      <ChevronDown
                        size={13}
                        className={cn(
                          "transition-transform duration-200",
                          expanded && "rotate-180",
                        )}
                      />
                    </button>
                  </>
                )}
              </div>
              {/* Reject pinned to bottom */}
              <button
                onClick={() => onRespond(requestId, rejectOption?.optionId ?? null)}
                className="flex items-center gap-2 px-3 py-2 border-t border-border/30
                           bg-transparent hover:bg-muted/60 transition-colors duration-100
                           text-muted-foreground/50 hover:text-muted-foreground"
              >
                <span className="text-[11px] font-medium">
                  {rejectOption?.name ?? "Keep planning"}
                </span>
                <span className="ml-auto">
                  <KbdHint label="Esc" />
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const TOOL_ICON_MAP: Record<string, React.ElementType> = {
  write_file: Pencil,
  edit_file: Pencil,
  create_file: Pencil,
  execute_command: Terminal,
  bash: Terminal,
  shell: Terminal,
  read_file: Eye,
  delete_file: Trash2,
};

function getToolIcon(payload: Record<string, unknown>): React.ElementType {
  const tool = payload.tool as string | undefined;
  if (tool && TOOL_ICON_MAP[tool]) return TOOL_ICON_MAP[tool];
  return Shield;
}

export function PermissionPrompt({
  requestId,
  payload,
  onRespond,
  fullHeight,
}: PermissionPromptProps) {
  const [expanded, setExpanded] = useState(false);

  const title = extractTitle(payload);
  const bodyText = extractBodyText(payload);
  const options = extractOptions(payload);
  const isLong = bodyText && bodyText.length > BODY_COLLAPSE_LIMIT;

  if (fullHeight) {
    return (
      <PlanPermissionOverlay
        requestId={requestId}
        bodyText={bodyText}
        options={options}
        onRespond={onRespond}
      />
    );
  }

  const ToolIcon = getToolIcon(payload);

  return (
    <div className="rounded-[10px] border border-accent/30 bg-gradient-to-br from-accent/10 to-transparent p-3.5 flex flex-col gap-2.5 shadow-[0_2px_8px_oklch(0%_0_0/0.08)]">
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-[7px] bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0">
          <ToolIcon className="w-4 h-4 text-accent" />
        </div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
      </div>

      {bodyText && (
        <div>
          <div
            className={cn(
              "px-2.5 py-2 bg-background/60 rounded-md border border-border/50 text-xs text-muted-foreground font-mono",
              !expanded && isLong ? "truncate" : "whitespace-pre-wrap break-words",
            )}
          >
            {bodyText}
          </div>
          {isLong && (
            <Button
              variant="ghost"
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-accent hover:text-accent/80 mt-1 h-auto p-0"
            >
              {expanded ? "show less" : "show more"}
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 justify-end">
        {options ? (
          options.map((opt) => (
            <Button
              key={opt.optionId}
              variant={isAllowKind(opt.kind) ? "accent" : "ghost"}
              size="sm"
              onClick={() => onRespond(requestId, opt.optionId)}
            >
              {opt.name}
            </Button>
          ))
        ) : (
          <LegacyButtons requestId={requestId} onRespond={onRespond} />
        )}
      </div>
    </div>
  );
}
