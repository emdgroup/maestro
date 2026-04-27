import { useState, useRef, useCallback } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/lib";

interface ComposeBarProps {
  onSend: (content: string) => void;
  onCancel: () => void;
  isProcessing: boolean;
}

export function ComposeBar({ onSend, onCancel, isProcessing }: ComposeBarProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isProcessing && value.trim()) handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    // Auto-grow
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div className="border-t border-border bg-background px-3.5 py-3">
      <div
        className={cn(
          "flex items-end gap-2 bg-muted/40 border border-border rounded-xl px-3 py-2",
          "focus-within:border-accent/50 transition-colors",
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Send a message…"
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
            onClick={handleSend}
            disabled={!value.trim()}
            className="w-7 h-7 rounded-lg bg-accent text-accent-foreground flex items-center justify-center flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            title="Send (Enter)"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
