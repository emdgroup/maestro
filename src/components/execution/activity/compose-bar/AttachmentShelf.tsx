import { XIcon, AlertCircleIcon } from "lucide-react";
import { fileIcon, imageMimeForExtension } from "../fileTypeUtils";
import { useLocalImageDataUrl } from "@/services/connection.service";
import { useHorizontalScrollFade } from "@/hooks/useHorizontalScrollFade";
import { DynamicIcon } from "@/ui/dynamic-icon";
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
} from "@/ui/attachment";
import type { ExternalAttachment } from "./externalAttachment";
import { formatBytes } from "@/lib/format-utils";

function ImageCard({
  attachment,
  onRemove,
}: {
  attachment: ExternalAttachment;
  onRemove: () => void;
}) {
  const mime = imageMimeForExtension(attachment.displayName);
  const { data: dataUrl } = useLocalImageDataUrl(
    attachment.error ? "" : attachment.localAbsPath,
    mime,
  );
  const meta = attachment.sizeBytes !== undefined ? formatBytes(attachment.sizeBytes) : undefined;

  return (
    <Attachment size="sm" state={attachment.error ? "error" : "done"}>
      <AttachmentMedia variant="image">
        {attachment.error ? (
          <AlertCircleIcon className="w-4 h-4" />
        ) : (
          dataUrl && <img src={dataUrl} alt={attachment.displayName} />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.displayName}</AttachmentTitle>
        <AttachmentDescription>{attachment.error ?? meta}</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction aria-label={`Remove ${attachment.displayName}`} onClick={onRemove}>
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  );
}

function DocCard({
  attachment,
  onRemove,
}: {
  attachment: ExternalAttachment;
  onRemove: () => void;
}) {
  const icon = fileIcon(attachment.displayName);
  const meta = attachment.sizeBytes !== undefined ? formatBytes(attachment.sizeBytes) : undefined;

  return (
    <Attachment size="sm" state={attachment.error ? "error" : "done"}>
      <AttachmentMedia>
        {attachment.error ? <AlertCircleIcon className="w-4 h-4" /> : <DynamicIcon icon={icon} />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.displayName}</AttachmentTitle>
        <AttachmentDescription>{attachment.error ?? meta}</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction aria-label={`Remove ${attachment.displayName}`} onClick={onRemove}>
          <XIcon />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  );
}

interface AttachmentShelfProps {
  attachments: ExternalAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentShelf({ attachments, onRemove }: AttachmentShelfProps) {
  const { ref: shelfRef, maskStyle } = useHorizontalScrollFade<HTMLDivElement>(attachments.length);

  if (attachments.length === 0) return null;

  return (
    <div
      ref={shelfRef}
      className="flex gap-3 px-3.5 py-1 pb-2 overflow-x-auto scrollbar-none"
      style={maskStyle}
    >
      {attachments.map((a) =>
        a.isImage ? (
          <ImageCard key={a.id} attachment={a} onRemove={() => onRemove(a.id)} />
        ) : (
          <DocCard key={a.id} attachment={a} onRemove={() => onRemove(a.id)} />
        ),
      )}
    </div>
  );
}
