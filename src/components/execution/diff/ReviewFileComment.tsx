import type { Dispatch, SetStateAction } from "react";
import type { PendingComment } from "./DiffViewer";
import type { DiffFileWithName } from "@/types/review";
import { PendingCommentBlock } from "./PendingCommentBlock";
import { InlineCommentInput } from "./InlineCommentInput";

interface ReviewFileCommentProps {
  selectedFile: DiffFileWithName;
  comments: PendingComment[];
  activeFileComment: boolean;
  setActiveFileComment: (open: boolean) => void;
  onRemoveComment: (id: string) => void;
  onEditComment: (id: string, newText: string) => void;
  setComments: Dispatch<SetStateAction<PendingComment[]>>;
}

export function ReviewFileComment({
  selectedFile,
  comments,
  activeFileComment,
  setActiveFileComment,
  onRemoveComment,
  onEditComment,
  setComments,
}: ReviewFileCommentProps) {
  const fileComment = comments.find(
    (c) => c.filePath === selectedFile.fileName && c.lineNumber === 0,
  );
  return (
    <div className="shrink-0 border-b border-border">
      {fileComment && !activeFileComment && (
        <PendingCommentBlock
          text={fileComment.text}
          onRemove={() => onRemoveComment(fileComment.id)}
          onEdit={(newText) => onEditComment(fileComment.id, newText)}
        />
      )}
      {activeFileComment && (
        <div className="p-2">
          <InlineCommentInput
            initialText={fileComment?.text}
            onSubmit={(text) => {
              setComments((prev) => {
                if (fileComment) {
                  return prev.map((c) =>
                    c.id === fileComment.id ? { ...c, text } : c,
                  );
                }
                return [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    filePath: selectedFile.fileName,
                    lineNumber: 0,
                    side: "new" as const,
                    text,
                  },
                ];
              });
              setActiveFileComment(false);
            }}
            onCancel={() => setActiveFileComment(false)}
          />
        </div>
      )}
    </div>
  );
}
