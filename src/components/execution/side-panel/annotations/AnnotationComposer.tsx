import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/ui/button";

interface AnnotationComposerProps {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  initialText?: string;
  /** Drop the card shell, for a host that already draws its own frame. */
  bare?: boolean;
}

/**
 * The comment editor, for both writing a new note and editing a saved one.
 *
 * Deliberately not `InlineCommentInput`: that one is sized for a diff row and puts its actions
 * inside the same frame as the field. Here the inner box holds only the textarea and the actions
 * sit below it, so the same editor works whether or not it supplies its own card.
 *
 * The selected text is not repeated here — it is highlighted in the plan directly underneath,
 * and the quote block that used to sit at the top only made the card tall enough to fall off
 * the bottom of the pane.
 */
export function AnnotationComposer({
  onSubmit,
  onCancel,
  initialText,
  bare,
}: AnnotationComposerProps) {
  const [text, setText] = useState(initialText ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function submit() {
    const trimmed = text.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <div
      className={cn(
        !bare && "rounded-lg border border-accent/50 bg-popover shadow-xl overflow-hidden",
      )}
    >
      <div className={cn(!bare && "px-3 pt-3")}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder="Leave a comment for the agent…"
          rows={3}
          className="w-full min-h-[72px] resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none transition-colors focus:border-accent placeholder:text-muted-foreground"
        />
      </div>
      <div className={cn("flex items-center justify-end gap-2 pt-2", !bare && "px-3 pb-2")}>
        <span className="mr-auto text-[10px] text-muted-foreground font-mono">⌘⏎</span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" className="h-7 text-xs" disabled={!text.trim()} onClick={submit}>
          {initialText ? "Save" : "Add"}
        </Button>
      </div>
    </div>
  );
}
