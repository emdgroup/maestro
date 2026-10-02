import { FileWarning, Paperclip, Upload, X } from "lucide-react";
import { toast } from "sonner";
import type { ConnectionKey, TaskAttachment } from "@/types/bindings";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { openFileWithConnection } from "@/lib/file-opener";
import { cn } from "@/lib/utils";
import { useSelectedProject } from "@/store/projectStore";
import { useWslConnections } from "@/services/connection.service";
import { Button } from "@/ui/button";
import { ZoomableContent } from "@/ui/zoomable-content";
import {
  useTaskAttachmentsQuery,
  useDeleteTaskAttachmentMutation,
  useProxyImageQuery,
} from "@/services/task.service";
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
  openAttachment,
}: {
  attachment: TaskAttachment;
  projectId: number;
  openAttachment: OpenAttachment;
}) {
  const { data: src, isPending } = useProxyImageQuery(projectId, attachment.file_path);

  if (isPending) {
    return <span className="w-20 h-20 bg-muted rounded-md animate-pulse" />;
  }

  // `proxy_image` answers with an error the query maps to null — a file that has moved or been
  // deleted since it was attached, so say so rather than pulse forever. Still clickable: the
  // native opener reports what actually went wrong.
  if (!src) {
    return (
      <button
        aria-label={`Open ${attachment.filename}`}
        title={attachment.file_path}
        className="w-20 h-20 flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border px-1 text-[10px] text-muted-foreground"
        onClick={() => void openAttachment(attachment.file_path)}
      >
        <FileWarning className="size-4" />
        <span className="w-full truncate">{attachment.filename}</span>
      </button>
    );
  }

  return (
    <ZoomableContent
      ariaLabel={attachment.filename}
      lightboxContent={<img src={src} alt={attachment.filename} />}
    >
      <img
        src={src}
        alt={attachment.filename}
        className="w-20 h-20 object-cover rounded-md border border-border"
      />
    </ZoomableContent>
  );
}

type OpenAttachment = (filePath: string) => Promise<void>;

/**
 * An attachment is a copy in the project, on the project's machine, so it opens the way any other
 * project file does: natively when the project is local, and through a host copy (or the WSL share)
 * when it is not. A file that has since gone surfaces as the toast below.
 */
function useOpenAttachment(): OpenAttachment {
  const project = useSelectedProject();
  const { data: wslConnections } = useWslConnections();
  const connection: ConnectionKey = project ? connectionKeyFromProject(project) : { type: "local" };
  const wslDistroName =
    connection.type === "wsl"
      ? wslConnections?.find((c) => c.id === connection.id)?.distro_name
      : undefined;

  return async (filePath: string) => {
    try {
      await openFileWithConnection(connection, filePath, {
        sshConnectionId: connection.type === "ssh" ? connection.id : undefined,
        wslDistroName,
      });
    } catch (e) {
      toast.error(`Could not open ${filePath}`, { description: String(e) });
    }
  };
}

interface AttachmentSectionProps {
  taskId: number;
  projectId: number;
  isEditable: boolean;
  onPickFiles: () => void;
  /** Driven by the parent's file input: a webview drag never reaches HTML5 drag events. */
  isDragging: boolean;
}

/**
 * The task's attachment list, straight from `list_task_attachments`.
 *
 * Presentational on the write side: the parent owns the one `useFileInput`, because each call
 * registers its own paste and drop listeners and a second one would attach every pasted image
 * twice, under two different temp paths that no dedupe can collapse.
 */
export function AttachmentSection({
  taskId,
  projectId,
  isEditable,
  onPickFiles,
  isDragging,
}: AttachmentSectionProps) {
  const { data: attachments = [] } = useTaskAttachmentsQuery(projectId, taskId);
  const removeAttachment = useDeleteTaskAttachmentMutation();
  const openAttachment = useOpenAttachment();

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
                  <AttachmentThumbnail
                    attachment={att}
                    projectId={projectId}
                    openAttachment={openAttachment}
                  />
                  {isEditable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${att.filename}`}
                      className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-background border border-border opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() =>
                        removeAttachment.mutate({
                          projectId,
                          attachmentId: att.id,
                          taskId: att.task_id,
                        })
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
                  <button
                    className="flex-1 min-w-0 truncate text-left text-foreground hover:underline underline-offset-2"
                    onClick={() => void openAttachment(att.file_path)}
                  >
                    {att.filename}
                  </button>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatFileSize(att.file_size)}
                  </span>
                  {isEditable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${att.filename}`}
                      className="h-6 w-6 shrink-0"
                      onClick={() =>
                        removeAttachment.mutate({
                          projectId,
                          attachmentId: att.id,
                          taskId: att.task_id,
                        })
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
            isDragging
              ? "border-ring bg-muted/20"
              : "border-border hover:border-muted-foreground/50",
          )}
        >
          <Upload className="mx-auto mb-2 size-5 text-muted-foreground/60" />
          <p>
            Drop files here or{" "}
            <button
              className="text-foreground underline underline-offset-2 hover:text-primary"
              onClick={onPickFiles}
            >
              browse
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
