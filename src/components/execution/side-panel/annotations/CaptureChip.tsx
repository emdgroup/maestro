import { X } from "lucide-react";
import { Attachment, AttachmentMedia } from "@/ui/attachment";
import { Button } from "@/ui/button";

interface CaptureChipProps {
  dataUrl: string;
  /** Drop the capture. Omitted where the capture is not the user's to remove. */
  onRemove?: () => void;
}

/**
 * The screenshot attached to a canvas annotation, as it appears while the note is being written or
 * rewritten.
 *
 * Shared by the composer and by `PendingCommentBlock`'s edit mode so the two are the same control:
 * editing a note is the same act as writing one, and a capture that changes shape between them
 * reads as a different feature. The read-only bubble shows the image full width instead — there it
 * is something to look at rather than an attachment to manage.
 */
export function CaptureChip({ dataUrl, onRemove }: CaptureChipProps) {
  return (
    <Attachment size="sm" className="w-full">
      <AttachmentMedia variant="image">
        <img src={dataUrl} alt="Region capture" />
      </AttachmentMedia>
      <span className="flex-1 min-w-0 truncate px-1 text-xs text-muted-foreground">
        Region capture
      </span>
      {onRemove && (
        <Button
          variant="ghost"
          size="icon-xs"
          title="Remove the screenshot from this note"
          className="mr-1 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
        >
          <X className="size-3" />
        </Button>
      )}
    </Attachment>
  );
}
