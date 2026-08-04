import { useState } from "react";
import { Pencil, Trash2, Send, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { AnnotationComposer } from "@/components/execution/side-panel/annotations/AnnotationComposer";
import { CaptureChip } from "@/components/execution/side-panel/annotations/CaptureChip";

interface PendingCommentBlockProps {
  text: string;
  onRemove: () => void;
  onEdit?: (newText: string) => void;
  /** Send this one comment to the session now. Omitted where comments only leave in a batch. */
  onSend?: () => void;
  sendDisabled?: boolean;
  /** Drop the inline frame, for a host that already draws a card around this. */
  bare?: boolean;
  /** Step to the neighbouring comment. Supplied only where the comments form a sequence. */
  onPrev?: () => void;
  onNext?: () => void;
  /** Position in that sequence, as `[index, total]`, shown beside the chevrons. */
  position?: [number, number];
  /** A capture the comment was taken over, shown above the text. Canvas annotations only. */
  imageDataUrl?: string;
  /**
   * Drop the capture from the comment, offered while editing. Unrecoverable — the region cannot be
   * re-shot from here — so it is kept out of the read-only view rather than sitting one stray click
   * away from the send button.
   */
  onRemoveImage?: () => void;
}

export function PendingCommentBlock({
  text,
  onRemove,
  onEdit,
  onSend,
  sendDisabled,
  bare,
  onPrev,
  onNext,
  position,
  imageDataUrl,
  onRemoveImage,
}: PendingCommentBlockProps) {
  const [editing, setEditing] = useState(false);
  const frame = bare ? "p-3" : "mx-4 my-2 rounded-md border border-accent/40 bg-accent/8 p-3";

  // Read-only, the capture is something to look at rather than an attachment to manage, so it is
  // shown full width instead of as the chip the editor uses.
  const capture = imageDataUrl ? (
    <img
      src={imageDataUrl}
      alt="The region this comment was left on"
      className="mb-2 w-full rounded border border-border object-contain"
    />
  ) : null;

  // The editor is the one the comment was written in — same field, same shortcut hint, same
  // buttons — so editing does not look like a different feature from creating. It owns the
  // draft and the Escape/⌘⏎ handling, which is why neither lives here.
  if (editing) {
    return (
      <div className={frame}>
        {/* The same chip the note was written with, not a second presentation of it: editing is
            the same act as creating, so the capture is managed the same way in both. */}
        {imageDataUrl && (
          <div className="mb-2">
            <CaptureChip dataUrl={imageDataUrl} onRemove={onRemoveImage} />
          </div>
        )}
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

  const actions = (
    <>
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
          title="Edit"
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
    </>
  );

  // With somewhere to step to, the controls earn a bar of their own: chevrons, position and
  // actions are all about *which* comment this is, and reading them on the same line as the
  // comment's text leaves neither legible.
  if (onPrev && onNext) {
    return (
      <div className={cn(bare ? undefined : "mx-4 my-2 rounded-md border border-accent/40")}>
        <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border">
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
            <span className="ml-1 text-[10px] font-mono text-muted-foreground tabular-nums">
              {position[0]} / {position[1]}
            </span>
          )}
          <div className="flex items-center gap-0.5 ml-auto">{actions}</div>
        </div>
        <div className="px-3 py-2.5 text-sm">
          {capture}
          <MarkdownBlock text={text} />
        </div>
      </div>
    );
  }

  return (
    <div className={cn(frame, "flex items-start gap-2")}>
      <div className="text-sm flex-1 min-w-0">
        {capture}
        <MarkdownBlock text={text} />
      </div>
      {actions}
    </div>
  );
}
