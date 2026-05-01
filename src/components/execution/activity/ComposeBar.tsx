import {
  useState,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useEffect,
} from "react";
import { ArrowUp, Square, X, Paperclip } from "lucide-react";
import { cn, getFolderName } from "@/lib";
import { api } from "@/lib/tauri-utils";
import type { JsonValue } from "@/types/bindings";
import type { AvailableCommand } from "./types";
import type { MentionEntry } from "./MentionEntry";

interface ComposeBarProps {
  onSend: (content: string, contentBlocks?: JsonValue) => void;
  onCancel: () => void;
  isProcessing: boolean;
  commands: AvailableCommand[];
  embeddedContext?: boolean;
  logId?: number | null;
  projectPath?: string | null;
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
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const mentionSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useImperativeHandle(ref, () => ({
      focus() {
        textareaRef.current?.focus();
      },
    }));

    const filteredCommands = commands.filter((cmd) =>
      cmd.name.toLowerCase().startsWith(commandFilter.toLowerCase()),
    );

    // Debounced file search
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

    const closeMentions = useCallback(() => {
      setShowMentions(false);
      setMentionSuggestions([]);
      setMentionQuery("");
    }, []);

    const selectMention = useCallback(
      (filePath: string) => {
        const displayName = getFolderName(filePath);
        const newMention: MentionEntry = {
          id: `${Date.now()}-${Math.random()}`,
          displayName,
          filePath,
        };
        // Replace "@query" text starting at triggerOffset with displayName token
        const before = value.slice(0, mentionTriggerOffset);
        const after = value.slice(textareaRef.current?.selectionStart ?? value.length);
        const newValue = `${before}${after.trimStart()}`;
        setValue(newValue);
        setMentions((prev) => [...prev, newMention]);
        closeMentions();
        setShowCommands(false);
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
            textareaRef.current.selectionStart = before.length;
            textareaRef.current.selectionEnd = before.length;
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
          }
        });
      },
      [value, mentionTriggerOffset, closeMentions],
    );

    const removeMention = useCallback((id: string) => {
      setMentions((prev) => prev.filter((m) => m.id !== id));
    }, []);

    const handleSend = useCallback(async () => {
      const trimmed = value.trim();
      if (!trimmed && mentions.length === 0) return;
      if (isSending) return;

      if (mentions.length === 0 || !logId) {
        // Plain text — no mentions or no active session
        onSend(trimmed || "");
        setValue("");
        setShowCommands(false);
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        return;
      }

      // Build structured content blocks
      setIsSending(true);
      try {
        const textContent = trimmed;
        const contentBlocks: JsonValue[] = [];

        if (textContent) {
          contentBlocks.push({ type: "text", text: textContent });
        }

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

        onSend(textContent, contentBlocks as JsonValue);
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
      const inserted = `${cmd.name} `;
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
        if (!isProcessing && !isSending && (value.trim() || mentions.length > 0)) {
          void handleSend();
        }
      }
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursor = e.target.selectionStart ?? newValue.length;
      setValue(newValue);

      // Slash command detection (only when full input is a /command with no space)
      if (newValue.startsWith("/") && !newValue.includes(" ")) {
        setCommandFilter(newValue.slice(1));
        setShowCommands(true);
        setCommandHighlight(0);
        closeMentions();
      } else {
        setShowCommands(false);
      }

      // @ mention detection: find last @ before cursor that is at word boundary
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

    const sendDisabled =
      isProcessing || isSending || (!value.trim() && mentions.length === 0);

    return (
      <div className="border-t border-border bg-background px-3.5 py-3">
        <div className="relative">
          {/* Mention suggestions dropdown */}
          {showMentions && mentionSuggestions.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-1 z-50 bg-popover border border-border rounded-xl p-1 shadow-md max-h-48 overflow-y-auto">
              {mentionSuggestions.map((path, i) => (
                <button
                  key={path}
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
          )}
          {/* Slash command suggestions dropdown */}
          {showCommands && filteredCommands.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-1 z-50 bg-popover border border-border rounded-xl p-1 shadow-md">
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.name}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectCommand(cmd);
                  }}
                  className={cn(
                    "w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                    i === commandHighlight ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <span className="font-mono text-xs text-accent shrink-0">{cmd.name}</span>
                  <span className="text-xs text-muted-foreground truncate">{cmd.description}</span>
                </button>
              ))}
            </div>
          )}
          <div
            className={cn(
              "flex flex-col gap-0 bg-muted/40 border border-border rounded-xl",
              "focus-within:border-accent/50 transition-colors",
            )}
          >
            {/* Mention pills */}
            {mentions.length > 0 && (
              <div className="flex flex-wrap gap-1 px-3 pt-2">
                {mentions.map((m) => (
                  <span
                    key={m.id}
                    className="inline-flex items-center gap-1 rounded-md bg-accent/10 border border-accent/20 text-accent px-1.5 py-0.5 text-xs font-mono"
                  >
                    <Paperclip className="w-2.5 h-2.5" />
                    {m.displayName}
                    <button
                      type="button"
                      onClick={() => removeMention(m.id)}
                      className="ml-0.5 hover:text-destructive transition-colors"
                      aria-label={`Remove ${m.displayName}`}
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2 px-3 py-2">
              <textarea
                ref={textareaRef}
                value={value}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                placeholder={mentions.length > 0 ? "Add a message…" : logId ? "Send a message… (@ to attach files)" : "Send a message…"}
                rows={1}
                className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground resize-none min-h-[22px] max-h-[160px] leading-relaxed"
              />
              {isProcessing ? (
                <button
                  type="button"
                  onClick={onCancel}
                  className="w-7 h-7 rounded-lg bg-destructive/15 border border-destructive/40 text-destructive flex items-center justify-center flex-shrink-0 hover:bg-destructive/25 transition-colors"
                  title="Cancel"
                >
                  <Square className="w-3 h-3 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={sendDisabled}
                  className="w-7 h-7 rounded-lg bg-accent text-accent-foreground flex items-center justify-center flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                  title="Send (Enter)"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  },
);
