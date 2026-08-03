import { useState } from "react";
import { Pencil, Trash2, Send, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/ui/button";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { AnnotationComposer } from "@/components/execution/side-panel/annotations/AnnotationComposer";

interface PendingCommentBlockProps {
  text: string;
  onRemove: () => void;
  onEdit?: (newText: string) => void;
  /** Send this one comment to the session now. Omitted where comments only leave in a batch. */
  onSend?: () => void;
  sendDisabled?: boolean;
  /** Step to the neighbouring comment. Supplied only where the comments form a sequence. */
  onPrev?: () => void;
  onNext?: () => void;
  /** Position in that sequence, as `[index, total]`, shown beside the chevrons. */
  position?: [number, number];
}

export function PendingCommentBlock({
  text,
  onRemove,
  onEdit,
  onSend,
  sendDisabled,
  onPrev,
  onNext,
  position,
}: PendingCommentBlockProps) {
  const [editing, setEditing] = useState(false);

  // The editor is the one the comment was written in — same field, same shortcut hint, same
  // buttons — so editing does not look like a different feature from creating. It owns the
  // draft and the Escape/⌘⏎ handling, which is why neither lives here.
  if (editing) {
    return (
      <div className="mx-4 my-2 rounded-md border border-accent/40 bg-accent/8 p-3">
        <AnnotationComposer
          bare
          initialText={text}
          onSubmit={(next) => {
            if (next !== text) onEdit?.(next);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  const nav = onPrev && onNext && (
    <div className="flex items-center gap-0.5 shrink-0">
      <Button
        variant="ghost"
        size="icon-xs"
        title="Previous comment"
        className="text-muted-foreground hover:text-foreground"
        onClick={onPrev}
      >
        <ChevronUp className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Next comment"
        className="text-muted-foreground hover:text-foreground"
        onClick={onNext}
      >
        <ChevronDown className="size-3" />
      </Button>
      {position && (
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
          {position[0]} / {position[1]}
        </span>
      )}
    </div>
  );

  return (
    <div className="mx-4 my-2 rounded-md border border-accent/40 bg-accent/8 p-3 flex items-start gap-2">
      {nav}
      <div className="text-sm flex-1 min-w-0">
        <MarkdownBlock text={text} />
      </div>
      {onSend && (
        <Button
          variant="ghost"
          size="icon-xs"
          title={sendDisabled ? "Agent is busy" : "Send this annotation"}
          disabled={sendDisabled}
          className="shrink-0 text-muted-foreground hover:text-accent"
          onClick={onSend}
        >
          <Send className="size-3" />
        </Button>
      )}
      {onEdit && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        title="Delete"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <Trash2 className="size-3" />
      </Button>
    </div>
  );
}
