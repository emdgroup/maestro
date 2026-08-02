import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";

interface AnnotationComposerProps {
  quote: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  initialText?: string;
}

/**
 * The plan tab's comment composer.
 *
 * Deliberately not `InlineCommentInput`: that one is sized for a diff row and puts its actions
 * inside the same frame as the field. Here the card is the frame, the inner box holds only the
 * textarea, and the actions sit on the card's footer.
 */
export function AnnotationComposer({
  quote,
  onSubmit,
  onCancel,
  initialText,
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
    <div className="rounded-lg border border-accent/50 bg-popover shadow-xl overflow-hidden">
      <div className="px-3 pt-2.5 pb-2">
        <p className="text-[11px] text-muted-foreground border-l-2 border-accent pl-2 line-clamp-2">
          {quote}
        </p>
      </div>
      <div className="px-3">
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
      <div className="flex items-center justify-end gap-2 px-3 py-2">
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
