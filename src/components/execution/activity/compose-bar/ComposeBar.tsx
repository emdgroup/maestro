import React, { useState, useRef, useCallback, useImperativeHandle, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { Send, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { api } from "@/lib/tauri-utils";
import type { JsonValue } from "@/types/bindings";
import type { AcpPromptCapabilities } from "../useAcpSessionLifecycle";
import type { AvailableCommand, UsageState, ConfigOption } from "../types";
import { useSettings } from "@/services/settings.service";
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

export interface ComposeBarHandle {
  focus(): void;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sizerRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focus() {
      textareaRef.current?.focus();
    },
  }));

  const { data: appSettings } = useSettings();
  const enterKeyBehavior = appSettings?.enter_key_behavior ?? "send_prompt";

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

  const resetForm = useCallback(() => {
    setValue("");
    mentionAC.reset();
    commandAC.reset();
    attach.reset();
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
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
      }
    },
    [value, mentionAC, commandAC],
  );

  const selectCommand = useCallback(
    (cmd: AvailableCommand) => {
      const inserted = `/${cmd.name} `;
      flushSync(() => {
        setValue(inserted);
        commandAC.reset();
      });
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = inserted.length;
        textareaRef.current.selectionEnd = inserted.length;
      }
    },
    [commandAC],
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

      let cursor = 0;
      for (const mention of sortedMentions) {
        const marker = `@${mention.displayName}`;
        const idx = trimmed.indexOf(marker, cursor);
        if (idx === -1) continue;
        const before = trimmed.slice(cursor, idx);
        if (before) mentionBlocks.push({ type: "text", text: before });
        const uri = `file://${projectPath ?? ""}/${mention.filePath}`;
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
    } finally {
      setIsSending(false);
    }
  }, [value, isSending, mentionAC, attach, logId, projectPath, embeddedContext, onSend, resetForm]);

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
    mentionAC.setMentions((prev) => prev.filter((m) => newValue.includes(`@${m.displayName}`)));
    const commandDetected = commandAC.onInputChange(newValue);
    if (commandDetected) mentionAC.closeMentions();
    else mentionAC.onInputChange(newValue, cursor);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const sendDisabled = isProcessing || isSending || !value.trim();

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
                  type="button"
                  onClick={() => void attach.handleAttach()}
                  disabled={isProcessing || isSending}
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
              className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground resize-none min-h-5.5 max-h-40 leading-relaxed custom-scrollbar"
            />
          </div>
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
                      style={{ inset: "-5px", width: "42px", height: "42px", overflow: "visible" }}
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
                        style={{
                          transformBox: "fill-box",
                          transformOrigin: "center",
                          animation: "arc-spin-cw 0.9s linear infinite",
                        }}
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
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={sendDisabled}
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
