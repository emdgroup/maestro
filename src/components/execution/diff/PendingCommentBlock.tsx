import { useState, useRef, useEffect } from "react";
import { Pencil, X } from "lucide-react";
import { Button } from "@/ui/button";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";

interface PendingCommentBlockProps {
  text: string;
  onRemove: () => void;
  onEdit?: (newText: string) => void;
}

export function PendingCommentBlock({ text, onRemove, onEdit }: PendingCommentBlockProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  function handleSave() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== text) {
      onEdit?.(trimmed);
    }
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setDraft(text);
      setEditing(false);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleSave();
    }
  }

  if (editing) {
    return (
      <div className="mx-4 my-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full min-h-[60px] resize-y bg-transparent text-sm outline-none"
          rows={3}
        />
        <div className="flex justify-end gap-2 mt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(text);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!draft.trim()}>
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-4 my-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-2">
      <div className="text-sm flex-1 min-w-0">
        <MarkdownBlock text={text} />
      </div>
      {onEdit && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
        >
          <Pencil className="size-3" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
