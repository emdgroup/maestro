import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import { Button } from "@/ui/button";
import { cn } from "@/lib";
import { MarkdownBlock } from "./MarkdownBlock";

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

function extractBodyText(payload: Record<string, unknown>): string | null {
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
  const toolCall = payload.toolCall as Record<string, unknown> | undefined;
  return toolCall?.kind === "switch_mode";
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

// ── Icons ────────────────────────────────────────────────────────────────────

function IconShield() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function IconBot() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <path d="M12 11V7" />
      <circle cx="12" cy="5" r="2" />
      <circle cx="9" cy="15.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15.5" r="1" fill="currentColor" stroke="none" />
      <path d="M9 19h6" strokeLinecap="round" />
    </svg>
  );
}

function IconUnlock() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}

function IconChevronLeft() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

const ACCEPT_ICONS = [IconShield, IconPencil, IconBot, IconUnlock];

function isBypassOption(name: string): boolean {
  return name.toLowerCase().includes("bypass");
}

function KbdHint({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-[5px] py-px rounded-[3px] text-[10px] font-medium font-mono bg-black/10 border border-black/10 opacity-60 leading-[1.6] flex-shrink-0">
      {label}
    </span>
  );
}

// ── Plan overlay ──────────────────────────────────────────────────────────────

interface PlanPermissionOverlayProps {
  requestId: string;
  bodyText: string | null;
  options: PermissionOption[] | null;
  onRespond: (requestId: string, optionId: string | null) => void;
}

function PlanPermissionOverlay({ requestId, bodyText, options, onRespond }: PlanPermissionOverlayProps) {
  const acceptOptions = options ? options.filter((o) => isAllowKind(o.kind)) : [];
  const rejectOption = options ? options.find((o) => !isAllowKind(o.kind)) ?? null : null;

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
      <div className="flex-1 overflow-y-auto custom-scrollbar px-5 pt-4 pb-[120px]">
        {bodyText && (
          <div className="text-sm leading-relaxed text-foreground">
            <MarkdownBlock text={bodyText} />
          </div>
        )}
      </div>

      {/* Floating glass action area */}
      <div className="absolute bottom-0 left-0 right-0 px-3 pb-3 pt-1 pointer-events-none">
        <div className="pointer-events-auto rounded-2xl backdrop-blur-[4px] bg-input/60 border border-border/30 overflow-hidden shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)]">
          {/* Accept track */}
          {acceptOptions.length > 0 && (
            <div className="flex border-b border-border/30">
              {acceptOptions.map((opt, idx) => {
                const Icon = ACCEPT_ICONS[idx] ?? IconShield;
                const isBypass = isBypassOption(opt.name);
                return (
                  <button
                    key={opt.optionId}
                    type="button"
                    onClick={() => onRespond(requestId, opt.optionId)}
                    className={cn(
                      "group flex-1 flex flex-row items-center justify-center gap-[9px] px-2.5 py-[11px]",
                      "cursor-pointer transition-colors duration-100 border-none bg-transparent font-[inherit]",
                      idx > 0 && "border-l border-border/30",
                      isBypass
                        ? "bg-warning/12 hover:bg-warning/20"
                        : "hover:bg-muted/60",
                    )}
                  >
                    <span
                      className={cn(
                        "flex-shrink-0 transition-colors duration-100 leading-none",
                        isBypass
                          ? "text-warning/60 group-hover:text-warning"
                          : "text-muted-foreground group-hover:text-foreground",
                      )}
                    >
                      <Icon />
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
                        {ACCEPT_DESCRIPTIONS[idx] ?? ""}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Reject track */}
          <button
            type="button"
            onClick={() => onRespond(requestId, rejectOption?.optionId ?? null)}
            className="w-full flex items-center justify-center gap-2 px-3.5 py-2 cursor-pointer transition-colors duration-100 border-none bg-transparent font-[inherit] hover:bg-muted/60"
          >
            <span className="text-muted-foreground/40 leading-none transition-colors duration-100">
              <IconChevronLeft />
            </span>
            <span className="text-[12px] font-medium text-muted-foreground transition-colors duration-100">
              {rejectOption?.name ?? "Keep planning"}
            </span>
            <span className="text-[11px] text-muted-foreground/40">— return without executing</span>
            <KbdHint label="Esc" />
          </button>
        </div>
      </div>
    </div>
  );
}

const ACCEPT_DESCRIPTIONS = [
  "Approve each tool use",
  "File ops auto-approved",
  "All tools, full session",
  "No safety checks",
];

export function PermissionPrompt({ requestId, payload, onRespond, fullHeight }: PermissionPromptProps) {
  const [expanded, setExpanded] = useState(false);

  const title = extractTitle(payload);
  const bodyText = extractBodyText(payload);
  const options = extractOptions(payload);
  const isPlan = isPlanPermission(payload);
  const isLong = bodyText && bodyText.length > BODY_COLLAPSE_LIMIT;

  const buttons = (
    <div className={cn("flex flex-wrap gap-2", fullHeight && "mt-2.5 shrink-0")}>
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
  );

  if (fullHeight) {
    return <PlanPermissionOverlay requestId={requestId} bodyText={bodyText} options={options} onRespond={onRespond} />;
  }

  return (
    <div className="border-t border-border bg-background px-3.5 py-3">
      <div className="flex items-center gap-2.5 mb-2.5">
        <div className="w-8 h-8 rounded-md bg-accent/10 border border-accent/30 flex items-center justify-center flex-shrink-0">
          <Shield className="w-4 h-4 text-accent" />
        </div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
      </div>

      {bodyText && isPlan ? (
        <div className="mb-2.5 max-h-[60vh] overflow-y-auto custom-scrollbar rounded-md border border-border bg-muted/30 p-3">
          <div className="text-sm leading-relaxed text-foreground">
            <MarkdownBlock text={bodyText} />
          </div>
        </div>
      ) : bodyText ? (
        <div className="mb-2.5">
          <pre
            className={cn(
              "text-xs text-muted-foreground whitespace-pre-wrap font-sans",
              !expanded && isLong && "line-clamp-4",
            )}
          >
            {bodyText}
          </pre>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-accent hover:text-accent/80 mt-1 transition-colors"
            >
              {expanded ? "show less" : "show more"}
            </button>
          )}
        </div>
      ) : null}

      {buttons}
    </div>
  );
}
