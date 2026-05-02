import {
  useState,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useEffect,
  useLayoutEffect,
  useId,
} from "react";
import { createPortal } from "react-dom";
import { Send, Paperclip } from "lucide-react";
import { cn } from "@/lib";
import { humanizeTokenCount } from "@/lib";
import { api } from "@/lib/tauri-utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/ui/tooltip";
import type { JsonValue } from "@/types/bindings";
import type { AvailableCommand, UsageState } from "./types";
import type { MentionEntry } from "./MentionEntry";

export type PermissionMode = "ask" | "auto" | "plan";

export interface ModelOption {
  id: string;
  label: string;
}

interface ComposeBarProps {
  onSend: (content: string, contentBlocks?: JsonValue) => void;
  onCancel: () => void;
  isProcessing: boolean;
  commands: AvailableCommand[];
  embeddedContext?: boolean;
  logId?: number | null;
  projectPath?: string | null;
  models: ModelOption[];
  modelId: string;
  permissionMode: PermissionMode;
  usageState: UsageState | null;
  onModelChange: (id: string) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
}

export interface ComposeBarHandle {
  focus(): void;
}

const MIME_MAP: Record<string, string> = {
  ".rs": "text/x-rust",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rb": "text/x-ruby",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".toml": "text/x-toml",
  ".json": "application/json",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".sh": "text/x-sh",
  ".html": "text/html",
  ".css": "text/css",
  ".sql": "text/x-sql",
  ".graphql": "text/x-graphql",
};

function mimeForPath(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME_MAP[ext];
}

function LiquidContextIndicator({ usage }: { usage: UsageState }) {
  const clipId = useId();
  const ratio = Math.min(1, Math.max(0, usage.size > 0 ? usage.used / usage.size : 0));
  const fillY = 20 - ratio * 20;
  const q1Y = fillY - 1.2;
  const q2Y = fillY + 1.2;

  const isCritical = ratio >= 0.85;
  const isWarning = ratio >= 0.75;
  const isAmber = ratio >= 0.6;

  const fillColor = isCritical ? "var(--destructive)" : isAmber ? "var(--warning)" : "var(--success)";
  const ringColor = isCritical
    ? "var(--destructive)"
    : isWarning
      ? "var(--warning)"
      : "var(--border)";
  const ringOpacity = isWarning || isCritical ? 0.5 : 1;

  const pct = Math.round(ratio * 100);
  const costStr =
    usage.cost !== null
      ? ` · ${usage.cost.amount.toFixed(usage.cost.amount < 0.01 ? 4 : 2)} ${usage.cost.currency}`
      : "";
  const tooltipText =
    usage.size <= 1
      ? "Context window"
      : `${pct}% · ${humanizeTokenCount(usage.used)} / ${humanizeTokenCount(usage.size)}${costStr}`;

  const fillPath = `M0 ${fillY.toFixed(2)} Q4 ${q1Y.toFixed(2)} 10 ${fillY.toFixed(2)} Q16 ${q2Y.toFixed(2)} 20 ${fillY.toFixed(2)} L20 20 L0 20 Z`;
  const highlightPath = `M0 ${fillY.toFixed(2)} Q4 ${q1Y.toFixed(2)} 10 ${fillY.toFixed(2)} Q16 ${q2Y.toFixed(2)} 20 ${fillY.toFixed(2)}`;

  const pulseStyle: React.CSSProperties | undefined = isCritical
    ? { animation: "ctx-pulse 1.4s ease-in-out infinite" }
    : isWarning
      ? { animation: "ctx-pulse 2s ease-in-out infinite" }
      : undefined;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="inline-flex items-center">
          <span className="w-4 h-4 origin-center cursor-help" style={pulseStyle}>
              <svg viewBox="0 0 20 20" className="w-full h-full block">
                <defs>
                  <clipPath id={clipId}>
                    <circle cx="10" cy="10" r="7.5" />
                  </clipPath>
                </defs>
                <circle
                  cx="10"
                  cy="10"
                  r="8.5"
                  fill="none"
                  stroke={ringColor}
                  strokeOpacity={ringOpacity}
                  strokeWidth="1.5"
                />
                <g clipPath={`url(#${clipId})`}>
                  <path d={fillPath} fill={fillColor} />
                  <path d={highlightPath} stroke="white" strokeWidth="0.7" fill="none" opacity="0.35" />
                </g>
              </svg>
            </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="text-[11px]">{tooltipText}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export const ComposeBar = forwardRef<ComposeBarHandle, ComposeBarProps>(
  function ComposeBar(
    {
      onSend,
      onCancel,
      isProcessing,
      commands,
      embeddedContext = false,
      logId,
      projectPath,
      models,
      modelId,
      permissionMode,
      usageState,
      onModelChange,
      onPermissionModeChange,
    },
    ref,
  ) {
    const [value, setValue] = useState("");
    const [showCommands, setShowCommands] = useState(false);
    const [commandFilter, setCommandFilter] = useState("");
    const [commandHighlight, setCommandHighlight] = useState(0);
    const [mentions, setMentions] = useState<MentionEntry[]>([]);
    const [showMentions, setShowMentions] = useState(false);
    const [mentionSuggestions, setMentionSuggestions] = useState<string[]>([]);
    const [mentionHighlight, setMentionHighlight] = useState(0);
    const [mentionQuery, setMentionQuery] = useState("");
    const [mentionTriggerOffset, setMentionTriggerOffset] = useState(0);
    const [isSending, setIsSending] = useState(false);
    const [isFocused, setIsFocused] = useState(false);
    const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const mentionSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mentionButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
    const commandButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

    useImperativeHandle(ref, () => ({
      focus() {
        textareaRef.current?.focus();
      },
    }));

    const filteredCommands = commands.filter((cmd) =>
      cmd.name.toLowerCase().startsWith(commandFilter.toLowerCase()),
    );

    useEffect(() => {
      if (!showMentions || !logId) return;
      if (mentionSearchRef.current) clearTimeout(mentionSearchRef.current);
      mentionSearchRef.current = setTimeout(async () => {
        try {
          const results = await api.searchSessionFiles(logId, mentionQuery, 20);
          setMentionSuggestions(results);
          setMentionHighlight(0);
        } catch {
          setMentionSuggestions([]);
        }
      }, 120);
      return () => {
        if (mentionSearchRef.current) clearTimeout(mentionSearchRef.current);
      };
    }, [showMentions, mentionQuery, logId]);

    useEffect(() => {
      const button = mentionButtonRefs.current.get(mentionHighlight);
      if (button) button.scrollIntoView({ block: "nearest" });
    }, [mentionHighlight]);

    useEffect(() => {
      const button = commandButtonRefs.current.get(commandHighlight);
      if (button) button.scrollIntoView({ block: "nearest" });
    }, [commandHighlight]);

    useLayoutEffect(() => {
      if (!showMentions && !showCommands) {
        setPanelPos(null);
        return;
      }
      const el = containerRef.current;
      if (!el) return;
      const update = () => {
        const rect = el.getBoundingClientRect();
        setPanelPos({ top: rect.top, left: rect.left, width: rect.width });
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      window.addEventListener("scroll", update, true);
      return () => {
        ro.disconnect();
        window.removeEventListener("scroll", update, true);
      };
    }, [showMentions, showCommands]);

    const closeMentions = useCallback(() => {
      setShowMentions(false);
      setMentionSuggestions([]);
      setMentionQuery("");
    }, []);

    const selectMention = useCallback(
      (filePath: string) => {
        const newMention: MentionEntry = {
          id: `${Date.now()}-${Math.random()}`,
          displayName: filePath,
          filePath,
        };
        const before = value.slice(0, mentionTriggerOffset);
        const after = value.slice(textareaRef.current?.selectionStart ?? value.length);
        const insertion = `@${filePath} `;
        const newValue = `${before}${insertion}${after.trimStart()}`;
        setValue(newValue);
        setMentions((prev) => [...prev, newMention]);
        closeMentions();
        setShowCommands(false);
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            const cursorPos = before.length + insertion.length;
            textareaRef.current.selectionStart = cursorPos;
            textareaRef.current.selectionEnd = cursorPos;
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
          }
        });
      },
      [value, mentionTriggerOffset, closeMentions],
    );

    const handleSend = useCallback(async () => {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (isSending) return;

      if (mentions.length === 0 || !logId) {
        onSend(trimmed);
        setValue("");
        setShowCommands(false);
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        return;
      }

      setIsSending(true);
      try {
        const contentBlocks: JsonValue[] = [];
        let messageText = trimmed;
        for (const mention of mentions) {
          messageText = messageText.replace(`@${mention.filePath}`, "").trim();
        }
        contentBlocks.push({ type: "text", text: messageText });

        for (const mention of mentions) {
          const uri = `file://${projectPath ?? ""}/${mention.filePath}`;
          if (embeddedContext) {
            try {
              const fileText = await api.readSessionFile(logId, mention.filePath);
              const mime = mimeForPath(mention.filePath);
              contentBlocks.push({
                type: "resource",
                resource: {
                  uri,
                  text: fileText,
                  ...(mime ? { mimeType: mime } : {}),
                },
              });
            } catch {
              contentBlocks.push({
                type: "resource_link",
                name: mention.displayName,
                uri,
              });
            }
          } else {
            contentBlocks.push({
              type: "resource_link",
              name: mention.displayName,
              uri,
            });
          }
        }

        onSend(trimmed, contentBlocks as JsonValue);
        setValue("");
        setMentions([]);
        setShowCommands(false);
        closeMentions();
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      } finally {
        setIsSending(false);
      }
    }, [value, mentions, isSending, logId, projectPath, embeddedContext, onSend, closeMentions]);

    const selectCommand = useCallback((cmd: AvailableCommand) => {
      const inserted = `/${cmd.name} `;
      setValue(inserted);
      setShowCommands(false);
      setCommandFilter("");
      setCommandHighlight(0);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.selectionStart = inserted.length;
          textareaRef.current.selectionEnd = inserted.length;
        }
      });
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showMentions && mentionSuggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionHighlight((i) => (i + 1) % mentionSuggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionHighlight(
            (i) => (i - 1 + mentionSuggestions.length) % mentionSuggestions.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (mentionSuggestions[mentionHighlight]) {
            selectMention(mentionSuggestions[mentionHighlight]);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeMentions();
          return;
        }
      }

      if (showCommands && filteredCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setCommandHighlight((i) => (i + 1) % filteredCommands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setCommandHighlight(
            (i) => (i - 1 + filteredCommands.length) % filteredCommands.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          selectCommand(filteredCommands[commandHighlight]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowCommands(false);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!isProcessing && !isSending && value.trim()) {
          void handleSend();
        }
      }
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursor = e.target.selectionStart ?? newValue.length;
      setValue(newValue);

      setMentions((prev) => prev.filter((m) => newValue.includes(`@${m.filePath}`)));

      const trimmedForCmd = newValue.trimStart();
      if (trimmedForCmd.startsWith("/") && !trimmedForCmd.includes(" ")) {
        setCommandFilter(trimmedForCmd.slice(1));
        setShowCommands(true);
        setCommandHighlight(0);
        closeMentions();
      } else {
        setShowCommands(false);
      }

      if (logId) {
        const textToCursor = newValue.slice(0, cursor);
        const atMatch = textToCursor.match(/(?:^|[\s\n])(@)([^\s]*)$/);
        if (atMatch) {
          const triggerPos = textToCursor.lastIndexOf("@");
          const query = atMatch[2];
          setMentionTriggerOffset(triggerPos);
          setMentionQuery(query);
          setShowMentions(true);
        } else {
          closeMentions();
        }
      }

      const el = e.target;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    };

    const sendDisabled = isProcessing || isSending || !value.trim();

    const panelStyle = panelPos
      ? { left: panelPos.left, width: panelPos.width, top: panelPos.top - 4, transform: "translateY(-100%)" }
      : undefined;

    const panelClass =
      "fixed z-[9999] backdrop-blur-[4px] bg-input/60 border border-border/30 rounded-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)] overflow-hidden";

    return (
      <>
        {/* Mention suggestions — portaled to body to escape backdrop-filter stacking context */}
        {showMentions && mentionSuggestions.length > 0 && panelPos &&
          createPortal(
            <div className={panelClass} style={panelStyle}>
              <div className="overflow-y-auto max-h-48 p-1 custom-scrollbar">
                {mentionSuggestions.map((path, i) => (
                  <button
                    key={path}
                    ref={(el) => {
                      if (el) mentionButtonRefs.current.set(i, el);
                      else mentionButtonRefs.current.delete(i);
                    }}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectMention(path);
                    }}
                    className={cn(
                      "w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                      i === mentionHighlight ? "bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <Paperclip className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="font-mono text-xs text-foreground truncate">{path}</span>
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )}

        {/* Slash command suggestions — portaled to body, two-column split layout */}
        {showCommands && panelPos &&
          createPortal(
            <div className={panelClass} style={panelStyle}>
              <div className="flex max-h-48">
                <div className="overflow-y-auto shrink-0 border-r border-border/20 p-1 max-w-[40%] custom-scrollbar">
                  {filteredCommands.length > 0 ? (
                    filteredCommands.map((cmd, i) => (
                      <button
                        key={cmd.name}
                        ref={(el) => {
                          if (el) commandButtonRefs.current.set(i, el);
                          else commandButtonRefs.current.delete(i);
                        }}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectCommand(cmd);
                        }}
                        className={cn(
                          "w-full flex items-center rounded-lg px-2 py-1.5 text-left transition-colors whitespace-nowrap",
                          i === commandHighlight ? "bg-muted" : "hover:bg-muted/50",
                        )}
                      >
                        <span className="font-mono text-xs text-accent">/{cmd.name}</span>
                      </button>
                    ))
                  ) : (
                    <div className="px-2 py-2 text-xs text-muted-foreground whitespace-nowrap">No matching commands</div>
                  )}
                </div>
                <div className="flex-1 p-3 overflow-y-auto min-w-0 custom-scrollbar">
                  {filteredCommands[commandHighlight] && (
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {filteredCommands[commandHighlight].description}
                    </p>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )}

      <div
        ref={containerRef}
        className={cn(
          "rounded-2xl border backdrop-blur-[4px] transition-colors duration-200",
          "bg-input/60 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)]",
          isFocused ? "border-accent/40" : "border-border/30",
        )}
      >
        <div className="relative">

          {/* File pills */}
          {mentions.length > 0 && (
            <div className="flex flex-wrap gap-1 px-3.5 pt-2.5">
              {mentions.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded-md bg-accent/8 border border-accent/12 text-accent"
                >
                  <Paperclip className="w-2.5 h-2.5 shrink-0" />
                  {m.displayName}
                  <button
                    type="button"
                    className="opacity-40 hover:opacity-100 transition-opacity"
                    onClick={() =>
                      setMentions((prev) => {
                        const next = prev.filter((x) => x.id !== m.id);
                        setValue((v) => v.replace(`@${m.filePath} `, "").replace(`@${m.filePath}`, ""));
                        return next;
                      })
                    }
                  >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Textarea + send/stop row */}
          <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder={logId ? "Send a message… (@ files, / commands)" : "Send a message…"}
              rows={1}
              className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground resize-none min-h-5.5 max-h-40 leading-relaxed"
            />
            {isProcessing ? (
              <button
                type="button"
                onClick={onCancel}
                className="w-8 h-8 rounded-full border border-destructive/40 bg-destructive/8 text-destructive flex items-center justify-center shrink-0 hover:bg-destructive/15 transition-colors relative"
                title="Cancel"
              >
                <svg
                  viewBox="0 0 42 42"
                  className="absolute pointer-events-none"
                  style={{ inset: "-5px", width: "42px", height: "42px", overflow: "visible" }}
                >
                  <circle
                    cx="20" cy="20" r="16"
                    fill="none"
                    stroke="currentColor"
                    strokeOpacity={1}
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeDasharray="22 79"
                    style={{ transformBox: "fill-box", transformOrigin: "center", animation: "arc-spin-cw 0.9s linear infinite" }}
                  />
                </svg>
                <svg className="w-3.5 h-3.5 relative" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2.5" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={sendDisabled}
                className="w-8 h-8 rounded-full bg-accent text-accent-foreground flex items-center justify-center flex-shrink-0 disabled:opacity-25 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                title="Send (Enter)"
              >
                <Send className="w-4 h-4 translate-x-[-0.5px] translate-y-[0.5px]" />
              </button>
            )}
          </div>

          {/* Meta row: context indicator · model · permission mode */}
          <div className="flex items-center gap-1 px-3 pb-2">
            <LiquidContextIndicator usage={usageState ?? { used: 0, size: 1, cost: null }} />

            {models.length > 0 && (
              <Select
                value={modelId}
                onValueChange={(v) => v && onModelChange(v)}
                disabled={isProcessing}
              >
                <SelectTrigger className="h-auto data-[size=default]:h-auto py-0.5 pl-1.5 pr-1 text-[11px] w-auto border-transparent bg-transparent shadow-none text-muted-foreground hover:border-border hover:bg-muted/50 transition-colors [&_svg]:size-3 disabled:opacity-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select
              value={permissionMode}
              onValueChange={(v) => v && onPermissionModeChange(v as PermissionMode)}
              disabled={isProcessing}
            >
              <SelectTrigger className="h-auto data-[size=default]:h-auto py-0.5 pl-1.5 pr-1 text-[11px] w-auto border-transparent bg-transparent shadow-none text-muted-foreground hover:border-border hover:bg-muted/50 transition-colors [&_svg]:size-3 disabled:opacity-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="ask" className="text-xs">Ask before edits</SelectItem>
                <SelectItem value="auto" className="text-xs">Edit automatically</SelectItem>
                <SelectItem value="plan" className="text-xs">Plan mode</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      </>
    );
  },
);
