import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
} from "react";
import { flushSync } from "react-dom";
import { Send, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { api } from "@/lib/tauri-utils";
import type { JsonValue } from "@/types/bindings";
import type { AcpPromptCapabilities } from "../useAcpSessionLifecycle";
import type { AvailableCommand, UsageState, ConfigOption } from "../types";
import { useSettings } from "@/services/settings.service";
import { useAcpSessionMeta } from "@/services/execution.service";
import { LiquidContextIndicator } from "../LiquidContextIndicator";
import { ConfigSelector } from "../config-selectors/ConfigSelector";
import { mimeForExtension } from "../fileTypeUtils";
import { useMentionAutocomplete } from "./useMentionAutocomplete";
import { useCommandAutocomplete } from "./useCommandAutocomplete";
import { useAttachments } from "./useAttachments";
import { usePanelPositioner } from "./usePanelPositioner";
import { AttachmentPills } from "./AttachmentPills";
import { AttachmentShelf } from "./AttachmentShelf";
import { MentionSuggestionsPanel } from "./MentionSuggestionsPanel";
import { CommandSuggestionsPanel } from "./CommandSuggestionsPanel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

/** Share of its bounds the input may grow to before it scrolls internally. */
const MAX_HEIGHT_RATIO = 0.75;

/**
 * The element the composer is laid out against — marked by the panel that positions it.
 *
 * Measured against the container rather than the window because the composer is absolutely
 * positioned inside a clipping box that is shorter than the viewport: a viewport-relative cap
 * lets the box outgrow that container, and since it grows upward from `bottom-0` what gets cut
 * off is the top — the text the user typed first, unreachable rather than merely scrolled.
 */
const BOUNDS_SELECTOR = "[data-compose-bounds]";

/** The tallest the input may render. Falls back to the window when laid out outside any bounds. */
function maxHeight(el: HTMLTextAreaElement) {
  const bounds = el.closest(BOUNDS_SELECTOR);
  return (bounds?.clientHeight ?? window.innerHeight) * MAX_HEIGHT_RATIO;
}

/**
 * Size the input to its content, capped.
 *
 * A textarea does not grow with its content, so every path that writes into this one has to
 * resize it afterwards — and each has to clamp against the same bound, or the box outgrows its
 * container and the text being typed renders behind the send row.
 */
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, maxHeight(el))}px`;
}

export interface ComposeBarHandle {
  focus(): void;
  /**
   * Put `text` in the box and focus it, without sending.
   *
   * The Overview actions that "ask the agent" go through here rather than prompting directly: the
   * user gets to read what is about to be said, edit it, and decide — which is the whole difference
   * between a suggestion and Maestro driving the agent behind their back. Anything already typed is
   * kept, because losing a half-written message to a mis-click is not recoverable.
   */
  seed(text: string): void;
}

interface ComposeBarProps {
  onSend: (content: string, contentBlocks?: JsonValue) => void;
  onCancel: () => void;
  isProcessing: boolean;
  commands: AvailableCommand[];
  embeddedContext?: boolean;
  logId?: number | null;
  projectPath?: string | null;
  configOptions: ConfigOption[];
  configValues: Record<string, string>;
  usageState: UsageState | null;
  onConfigChange: (optionId: string, value: string) => void;
  promptCapabilities?: AcpPromptCapabilities | null;
  variant?: "centered" | "docked";
  onContentChange?: (width: number | null) => void;
  ref?: React.Ref<ComposeBarHandle>;
}

export function ComposeBar({
  onSend,
  onCancel,
  isProcessing,
  commands,
  embeddedContext = false,
  logId,
  projectPath,
  configOptions,
  configValues,
  usageState,
  onConfigChange,
  promptCapabilities,
  variant = "docked",
  onContentChange,
  ref,
}: ComposeBarProps) {
  const [value, setValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sizerRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focus() {
      textareaRef.current?.focus();
    },
    seed(text: string) {
      // Committing the value synchronously is what makes the measurement in `autoGrow` read the
      // seeded text rather than what was there before.
      flushSync(() => {
        setValue((previous) => (previous.trim() ? `${previous.trimEnd()}\n\n${text}` : text));
      });
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      autoGrow(el);
    },
  }));

  const { data: appSettings } = useSettings();
  const enterKeyBehavior = appSettings?.enter_key_behavior ?? "send_prompt";

  // Mention paths come from a file search rooted at the session's cwd, which for a session
  // spawned into a worktree is not the project root. Joining them onto the project path
  // produced a URI for a file that is not there — the agent could not read it, and clicking
  // the card in the sent message failed with "cannot find the file specified".
  const { data: sessionMeta } = useAcpSessionMeta(logId ?? null);

  const mentionAC = useMentionAutocomplete({ logId });
  const commandAC = useCommandAutocomplete({ commands });
  const attach = useAttachments({ promptCapabilities, logId });
  const panelPos = usePanelPositioner(
    mentionAC.showMentions || commandAC.showCommands,
    containerRef,
  );

  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer) return;
    const trimmed = value.trim();
    if (!trimmed) {
      onContentChange?.(null);
      return;
    }
    sizer.textContent = value.split("\n").reduce((a, b) => (b.length > a.length ? b : a), "");
    onContentChange?.(sizer.getBoundingClientRect().width);
  }, [value, onContentChange]);

  // The cap is a share of the container, so it moves when the container does — the window being
  // resized, the side panel dragged, a plan panel opening above. Without this a box grown while
  // the panel was tall keeps that height inside a panel that is now shorter, which is the exact
  // clipping the container bound exists to prevent.
  useEffect(() => {
    const el = textareaRef.current;
    const bounds = el?.closest(BOUNDS_SELECTOR);
    if (!el || !bounds) return;
    const observer = new ResizeObserver(() => autoGrow(el));
    observer.observe(bounds);
    return () => observer.disconnect();
  }, []);

  const resetForm = useCallback(() => {
    setValue("");
    mentionAC.reset();
    commandAC.reset();
    attach.reset();
    setSendError(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [mentionAC, commandAC, attach]);

  const selectMention = useCallback(
    (filePath: string) => {
      const basename = filePath.split("/").pop() ?? filePath;
      const newMention = { id: crypto.randomUUID(), displayName: basename, filePath };
      const before = value.slice(0, mentionAC.mentionTriggerOffset);
      const after = value.slice(textareaRef.current?.selectionStart ?? value.length);
      const insertion = `@${basename} `;
      const newValue = `${before}${insertion}${after.trimStart()}`;
      flushSync(() => {
        setValue(newValue);
        mentionAC.onMentionSelected(newMention);
        commandAC.setShowCommands(false);
      });
      if (textareaRef.current) {
        textareaRef.current.focus();
        const cursorPos = before.length + insertion.length;
        textareaRef.current.selectionStart = cursorPos;
        textareaRef.current.selectionEnd = cursorPos;
        autoGrow(textareaRef.current);
      }
    },
    [value, mentionAC, commandAC],
  );

  const selectCommand = useCallback(
    (cmd: AvailableCommand) => {
      const before = value.slice(0, commandAC.commandTriggerOffset);
      const after = value.slice(textareaRef.current?.selectionStart ?? value.length);
      const insertion = `/${cmd.name} `;
      const newValue = `${before}${insertion}${after.trimStart()}`;
      flushSync(() => {
        setValue(newValue);
        commandAC.reset();
      });
      if (textareaRef.current) {
        textareaRef.current.focus();
        const cursorPos = before.length + insertion.length;
        textareaRef.current.selectionStart = cursorPos;
        textareaRef.current.selectionEnd = cursorPos;
        autoGrow(textareaRef.current);
      }
    },
    [value, commandAC],
  );

  const handleSend = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || isSending) return;

    const { mentions } = mentionAC;
    const { attachments } = attach;

    if (mentions.length === 0 && attachments.length === 0) {
      onSend(trimmed);
      resetForm();
      return;
    }

    if (!logId) {
      onSend(trimmed);
      resetForm();
      return;
    }

    setSendError(null);
    setIsSending(true);
    try {
      const attachmentBlocks: JsonValue[] = [];
      if (attachments.length > 0) {
        const prepared = await api.prepareExternalAttachments(
          logId,
          attachments.map((a) => ({ path: a.localAbsPath, is_image: a.isImage })),
          embeddedContext,
        );
        for (const p of prepared) {
          attachmentBlocks.push(p.content_block as JsonValue);
        }
      }

      const fileContents = new Map<string, { text: string; mime: string | undefined } | null>();
      if (mentions.length > 0 && embeddedContext) {
        const results = await Promise.allSettled(
          mentions.map(async (m) => {
            const text = await api.readSessionFile(logId, m.filePath);
            return { path: m.filePath, text, mime: mimeForExtension(m.filePath) };
          }),
        );
        for (const r of results) {
          if (r.status === "fulfilled") {
            fileContents.set(r.value.path, { text: r.value.text, mime: r.value.mime });
          }
        }
      }

      const mentionBlocks: JsonValue[] = [];
      const sortedMentions = [...mentions].sort((a, b) => {
        const idxA = trimmed.indexOf(`@${a.displayName}`);
        const idxB = trimmed.indexOf(`@${b.displayName}`);
        return idxA - idxB;
      });

      const mentionRoot = (sessionMeta?.cwd ?? projectPath ?? "").replace(/[\\/]+$/, "");

      let cursor = 0;
      for (const mention of sortedMentions) {
        const marker = `@${mention.displayName}`;
        const idx = trimmed.indexOf(marker, cursor);
        if (idx === -1) continue;
        const before = trimmed.slice(cursor, idx);
        if (before) mentionBlocks.push({ type: "text", text: before });
        const uri = `file://${mentionRoot}/${mention.filePath}`;
        const fetched = fileContents.get(mention.filePath);
        if (fetched) {
          mentionBlocks.push({
            type: "resource",
            resource: {
              uri,
              text: fetched.text,
              ...(fetched.mime ? { mimeType: fetched.mime } : {}),
            },
          });
        } else {
          mentionBlocks.push({ type: "resource_link", name: mention.displayName, uri });
        }
        cursor = idx + marker.length;
      }

      const trailing = trimmed.slice(cursor);
      if (trailing) mentionBlocks.push({ type: "text", text: trailing });

      onSend(trimmed, [...attachmentBlocks, ...mentionBlocks] as JsonValue);
      resetForm();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSending(false);
    }
  }, [
    value,
    isSending,
    mentionAC,
    attach,
    logId,
    projectPath,
    sessionMeta,
    embeddedContext,
    onSend,
    resetForm,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const modeOption = configOptions.find((o) => o.category === "mode");
    if (e.key === "Tab" && e.shiftKey && modeOption && modeOption.options.length > 0) {
      e.preventDefault();
      const currentModeValue = configValues[modeOption.id] ?? modeOption.currentValue;
      const idx = modeOption.options.findIndex((o) => o.value === currentModeValue);
      const next = (Math.max(idx, 0) + 1) % modeOption.options.length;
      onConfigChange(modeOption.id, modeOption.options[next].value);
      return;
    }
    if (mentionAC.handleKeyDown(e, selectMention)) return;
    if (commandAC.handleKeyDown(e, selectCommand)) return;
    if (e.key === "Escape" && isProcessing) {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      textareaRef.current?.blur();
      return;
    }
    if (enterKeyBehavior === "new_line") {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!isProcessing && !isSending && value.trim()) void handleSend();
      }
    } else {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!isProcessing && !isSending && value.trim()) void handleSend();
      }
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const cursor = e.target.selectionStart ?? newValue.length;
    setValue(newValue);
    if (sendError) setSendError(null);
    mentionAC.setMentions((prev) => prev.filter((m) => newValue.includes(`@${m.displayName}`)));
    const commandDetected = commandAC.onInputChange(newValue, cursor);
    if (commandDetected) mentionAC.closeMentions();
    else mentionAC.onInputChange(newValue, cursor);
    autoGrow(e.target);
  };

  const hasAttachmentErrors = attach.attachments.some((a) => !!a.error);
  const sendDisabled = isProcessing || isSending || !value.trim() || hasAttachmentErrors;

  return (
    <>
      <span
        ref={sizerRef}
        aria-hidden
        style={{
          position: "fixed",
          left: "-9999px",
          top: "-9999px",
          visibility: "hidden",
          whiteSpace: "pre",
          fontSize: "0.875rem",
          lineHeight: "1.625",
          fontFamily: "inherit",
          pointerEvents: "none",
        }}
      />
      <MentionSuggestionsPanel
        suggestions={mentionAC.mentionSuggestions}
        highlight={mentionAC.mentionHighlight}
        panelPos={mentionAC.showMentions ? panelPos : null}
        buttonRefs={mentionAC.mentionButtonRefs}
        onSelect={selectMention}
      />
      <CommandSuggestionsPanel
        commands={commandAC.filteredCommands}
        highlight={commandAC.commandHighlight}
        panelPos={commandAC.showCommands ? panelPos : null}
        buttonRefs={commandAC.commandButtonRefs}
        onSelect={selectCommand}
      />
      <AttachmentShelf
        attachments={attach.attachments}
        onRemove={(id) => attach.setAttachments((prev) => prev.filter((x) => x.id !== id))}
      />
      <div
        ref={containerRef}
        className={cn(
          "rounded-[25px] border backdrop-blur-xs transition-colors duration-200",
          "bg-muted/60 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)]",
          isFocused ? "border-accent/40" : "border-border/30",
          variant === "centered" && "shadow-lg",
        )}
      >
        <div className="relative">
          <AttachmentPills
            mentions={mentionAC.mentions}
            onRemoveMention={(id, filePath) => {
              mentionAC.setMentions((prev) => prev.filter((x) => x.id !== id));
              setValue((v) => v.replace(`@${filePath} `, "").replace(`@${filePath}`, ""));
            }}
          />
          <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1">
            {logId && (
              <Tooltip>
                <TooltipTrigger
                  render={<button type="button" disabled={isProcessing || isSending} />}
                  onClick={() => void attach.handleAttach()}
                  className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-muted-foreground border border-transparent hover:border-border/40 hover:text-accent hover:bg-accent/8 disabled:opacity-20 disabled:cursor-not-allowed transition-all duration-150"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                </TooltipTrigger>
                <TooltipContent>Attach external files</TooltipContent>
              </Tooltip>
            )}
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={(e) => void attach.handlePaste(e)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder={
                logId ? "Ask anything, use @ for context, / for commands" : "Send a message…"
              }
              rows={1}
              className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground resize-none min-h-5.5 leading-relaxed custom-scrollbar"
            />
          </div>
          {sendError && <p className="px-3.5 pb-1 text-xs text-destructive">{sendError}</p>}
          <div className="flex items-center gap-2 pl-2 pr-2 pb-2">
            <div className="w-8 h-8 flex items-center justify-center shrink-0">
              <LiquidContextIndicator
                usage={usageState ?? { used: 0, size: 1, cost: null }}
                onCompact={isProcessing ? undefined : () => onSend("/compact")}
              />
            </div>
            {configOptions.map((opt) => (
              <ConfigSelector
                key={opt.id}
                option={opt}
                value={configValues[opt.id] ?? opt.currentValue}
                onChange={(v) => onConfigChange(opt.id, v)}
              />
            ))}
            <div className="ml-auto">
              {isProcessing ? (
                <Tooltip>
                  <TooltipTrigger
                    type="button"
                    onClick={onCancel}
                    className="w-8 h-8 rounded-full border border-destructive/40 bg-destructive/8 text-destructive flex items-center justify-center shrink-0 opacity-60 hover:opacity-100 hover:bg-destructive/15 transition-colors relative"
                  >
                    <svg
                      viewBox="0 0 42 42"
                      className="absolute pointer-events-none"
                      style={{
                        inset: "-5px",
                        width: "42px",
                        height: "42px",
                        overflow: "visible",
                        // Animate the svg root, not the circle: transform animations on
                        // SVG child elements run on the renderer main thread and freeze
                        // under load, while the root element composites. Origin matches
                        // the circle's center so the arc traces the same path.
                        animation: "arc-spin-cw 0.9s linear infinite",
                        transformOrigin: "20px 20px",
                      }}
                    >
                      <circle
                        cx="20"
                        cy="20"
                        r="16"
                        fill="none"
                        stroke="currentColor"
                        strokeOpacity={1}
                        strokeWidth={1.8}
                        strokeLinecap="round"
                        strokeDasharray="22 79"
                      />
                    </svg>
                    <svg className="w-3.5 h-3.5 relative" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="4" y="4" width="16" height="16" rx="2.5" />
                    </svg>
                  </TooltipTrigger>
                  <TooltipContent>Cancel</TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={<button type="button" disabled={sendDisabled} />}
                    onClick={() => void handleSend()}
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-accent/15 text-accent border border-accent/25 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1)] hover:bg-accent/30 hover:border-accent/40 hover:scale-105 active:scale-95 disabled:opacity-20 disabled:cursor-not-allowed disabled:hover:scale-100 transition-all duration-150"
                  >
                    <Send className="w-4 h-4 translate-x-[-0.5px] translate-y-[0.5px]" />
                  </TooltipTrigger>
                  <TooltipContent>Send (Enter)</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
