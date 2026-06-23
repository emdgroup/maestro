import { useState, useRef } from "react";
import { Paperclip, Upload, X } from "lucide-react";
import type { TaskAttachment } from "@/types/bindings";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import {
  useTaskAttachmentsQuery,
  useAddTaskAttachmentMutation,
  useDeleteTaskAttachmentMutation,
  useProxyImageQuery,
} from "@/services/task.service";
import { useFileInput } from "@/components/kanban/shared/useFileInput";
import { isImageExtension } from "@/components/execution/activity/fileTypeUtils";

function isImage(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return isImageExtension(`.${ext}`);
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentThumbnail({
  attachment,
  projectId,
}: {
  attachment: TaskAttachment;
  projectId: number;
}) {
  const { data: src } = useProxyImageQuery(projectId, attachment.file_path);

  if (!src) {
    return <span className="w-20 h-20 bg-muted rounded-md animate-pulse" />;
  }

  return (
    <img
      src={src}
      alt={attachment.filename}
      className="w-20 h-20 object-cover rounded-md border border-border"
    />
  );
}

interface AttachmentSectionProps {
  taskId: number;
  projectId: number;
  isEditable: boolean;
}

export function AttachmentSection({ taskId, projectId, isEditable }: AttachmentSectionProps) {
  const { data: attachments = [] } = useTaskAttachmentsQuery(taskId);
  const addAttachment = useAddTaskAttachmentMutation();
  const removeAttachment = useDeleteTaskAttachmentMutation();
  const addAttachmentRef = useRef(addAttachment);
  addAttachmentRef.current = addAttachment;

  const [isDragOver, setIsDragOver] = useState(false);
  const resetDragOver = () => setIsDragOver(false);

  const { pickFiles } = useFileInput(
    isEditable,
    (filename, filePath) => addAttachmentRef.current.mutate({ taskId, filename, filePath }),
    { onDrop: resetDragOver, onLeave: resetDragOver },
  );

  const imageAtts = attachments.filter((a: TaskAttachment) => isImage(a.filename));
  const fileAtts = attachments.filter((a: TaskAttachment) => !isImage(a.filename));

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Paperclip className="size-3.5" />
        Attachments
      </h3>

      {attachments.length === 0 && !isEditable && (
        <p className="text-xs text-muted-foreground">No attachments</p>
      )}

      {attachments.length > 0 && (
        <div className="space-y-2">
          {imageAtts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {imageAtts.map((att: TaskAttachment) => (
                <div key={att.id} className="relative group">
                  <AttachmentThumbnail attachment={att} projectId={projectId} />
                  {isEditable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-background border border-border opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() =>
                        removeAttachment.mutate({ attachmentId: att.id, taskId: att.task_id })
                      }
                      disabled={removeAttachment.isPending}
                    >
                      <X className="size-3" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {fileAtts.length > 0 && (
            <ul className="space-y-1">
              {fileAtts.map((att: TaskAttachment) => (
                <li
                  key={att.id}
                  className="h-9 flex items-center gap-2 rounded-md border border-border bg-card px-3 text-sm"
                >
                  <span className="flex-1 truncate text-foreground">{att.filename}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatFileSize(att.file_size)}
                  </span>
                  {isEditable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() =>
                        removeAttachment.mutate({ attachmentId: att.id, taskId: att.task_id })
                      }
                      disabled={removeAttachment.isPending}
                    >
                      <X className="size-3" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isEditable && (
        <div
          className={cn(
            "border-2 border-dashed rounded-lg p-4 text-center text-sm text-muted-foreground transition-colors",
            isDragOver
              ? "border-ring bg-muted/20"
              : "border-border hover:border-muted-foreground/50",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
        >
          <Upload className="mx-auto mb-2 size-5 text-muted-foreground/60" />
          <p>
            Drop files here or{" "}
            <button
              className="text-foreground underline underline-offset-2 hover:text-primary"
              onClick={pickFiles}
            >
              browse
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
