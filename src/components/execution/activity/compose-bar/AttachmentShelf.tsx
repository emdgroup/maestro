import {
  FileTextIcon,
  FileCodeIcon,
  FileSpreadsheet,
  FileTerminal,
  FileArchive,
  FileIcon,
  XIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { useHorizontalScrollFade } from "@/hooks/useHorizontalScrollFade";
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
} from "@/components/ui/attachment";
import type { ExternalAttachment } from "./externalAttachment";

function imageMime(displayName: string): string {
  const ext = displayName.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

export function docIcon(displayName: string) {
  const ext = displayName.split(".").pop()?.toLowerCase() ?? "";
  if (["csv", "tsv", "xlsx", "xls", "ods"].includes(ext)) return FileSpreadsheet;
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "rs",
      "py",
      "go",
      "rb",
      "java",
      "c",
      "cpp",
      "h",
      "hpp",
      "cs",
      "php",
      "swift",
      "kt",
      "json",
      "yaml",
      "yml",
      "toml",
      "xml",
      "env",
      "ini",
      "conf",
      "cfg",
    ].includes(ext)
  )
    return FileCodeIcon;
  if (["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"].includes(ext)) return FileTerminal;
  if (["zip", "tar", "gz", "7z", "rar", "bz2", "xz"].includes(ext)) return FileArchive;
  if (["txt", "md", "mdx", "pdf", "doc", "docx", "odt", "rtf", "pptx", "ppt"].includes(ext))
    return FileTextIcon;
  return FileIcon;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function useLocalImageDataUrl(localAbsPath: string, mime: string) {
  return useQuery({
    queryKey: ["local-image", localAbsPath],
    queryFn: async () => {
      const b64 = await api.readLocalFileBinary(localAbsPath);
      return `data:${mime};base64,${b64}`;
    },
    staleTime: Infinity,
  });
}

function ImageCard({
  attachment,
  onRemove,
}: {
  attachment: ExternalAttachment;
  onRemove: () => void;
}) {
  const mime = imageMime(attachment.displayName);
  const { data: dataUrl } = useLocalImageDataUrl(attachment.localAbsPath, mime);
  const meta =
    attachment.sizeBytes !== undefined ? formatFileSize(attachment.sizeBytes) : undefined;

  return (
    <Attachment size="sm">
      <AttachmentMedia variant="image">
        {dataUrl && <img src={dataUrl} alt={attachment.displayName} />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.displayName}</AttachmentTitle>
        {meta && <AttachmentDescription>{meta}</AttachmentDescription>}
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
  const Icon = docIcon(attachment.displayName);
  const meta =
    attachment.sizeBytes !== undefined ? formatFileSize(attachment.sizeBytes) : undefined;

  return (
    <Attachment size="sm">
      <AttachmentMedia>
        <Icon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{attachment.displayName}</AttachmentTitle>
        {meta && <AttachmentDescription>{meta}</AttachmentDescription>}
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
