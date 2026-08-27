import { PendingCommentBlock } from "./PendingCommentBlock";
import { InlineCommentInput } from "./InlineCommentInput";
import type { CommentNav } from "./useCommentNavigation";

/**
 * A file's own note — the one anchored to the file rather than to a line.
 *
 * Shaped as intents rather than as a setter so both comment stores can drive it: task review
 * writes a `PendingComment` into `reviewStore`, the session panel an annotation into
 * `annotationStore`. `onSubmit` covers creating and editing alike, which is what keeps the two
 * paths from drifting — they used to reach the same outcome by two different routes.
 */
export interface FileCommentApi {
  comment: { id: string; text: string } | null;
  onSubmit: (text: string) => void;
  onRemove: () => void;
  /** Send this one note now. Omitted where notes only leave in a batch — task review's Rework. */
  onSend?: () => void;
  sendDisabled?: boolean;
  /** Its place in the review's whole set, from `useCommentNavigation`. */
  nav?: CommentNav | null;
}

interface ReviewFileCommentProps {
  fileComment: FileCommentApi;
  /** Whether the editor is open. Owned by the card, so the button and the input stay together. */
  editing: boolean;
  onEditingChange: (open: boolean) => void;
}

export function ReviewFileComment({
  fileComment,
  editing,
  onEditingChange,
}: ReviewFileCommentProps) {
  const { comment, onSubmit, onRemove, onSend, sendDisabled, nav } = fileComment;
  if (!comment && !editing) return null;

  return (
    <div className="shrink-0 border-b border-border">
      {comment &&
        !editing && (
          // Tagged so comment navigation can find it: `buildExtendData` skips line 0, so unlike a
          // line comment this one has no anchor inside the diff itself.
          <div data-comment-id={comment.id}>
            <PendingCommentBlock
              text={comment.text}
              onRemove={onRemove}
              onEdit={onSubmit}
              onSend={onSend}
              sendDisabled={sendDisabled}
              {...(nav ?? {})}
            />
          </div>
        )}
      {editing && (
        <div className="p-2">
          <InlineCommentInput
            initialText={comment?.text}
            onSubmit={(text) => {
              onSubmit(text);
              onEditingChange(false);
            }}
            onCancel={() => onEditingChange(false)}
          />
        </div>
      )}
    </div>
  );
}
