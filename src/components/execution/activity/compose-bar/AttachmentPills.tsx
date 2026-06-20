import { Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { iconForFilePath } from "./composeUtils";
import type { ExternalAttachment } from "./externalAttachment";
import type { MentionEntry } from "./mentionEntry";

const X_PATH = "M18 6L6 18M6 6l12 12";

interface Props {
  attachments: ExternalAttachment[];
  mentions: MentionEntry[];
  onRemoveAttachment: (id: string) => void;
  onRemoveMention: (id: string, filePath: string) => void;
}

export function AttachmentPills({
  attachments,
  mentions,
  onRemoveAttachment,
  onRemoveMention,
}: Props) {
  if (attachments.length === 0 && mentions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-3.5 pt-2.5">
      {attachments.map((a) => (
        <span
          key={a.id}
          className={cn(
            "inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded-md border",
            a.isImage
              ? "bg-[oklch(70%_0.14_300/0.1)] border-[oklch(70%_0.14_300/0.18)] text-[oklch(70%_0.14_300)]"
              : "bg-[oklch(72%_0.12_195/0.1)] border-[oklch(72%_0.12_195/0.18)] text-[oklch(72%_0.12_195)]",
          )}
        >
          {a.isImage ? (
            <ImageIcon className="w-2.5 h-2.5 shrink-0" />
          ) : (
            iconForFilePath(a.displayName, "w-2.5 h-2.5 shrink-0")
          )}
          {a.displayName}
          <button
            type="button"
            className="opacity-40 hover:opacity-100 transition-opacity"
            onClick={() => onRemoveAttachment(a.id)}
          >
            <svg
              className="w-2.5 h-2.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d={X_PATH} />
            </svg>
          </button>
        </span>
      ))}
      {mentions.map((m) => (
        <span
          key={m.id}
          className="inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded-md bg-accent/8 border border-accent/12 text-accent"
        >
          {iconForFilePath(m.displayName, "w-2.5 h-2.5 shrink-0")}
          {m.displayName}
          <button
            type="button"
            className="opacity-40 hover:opacity-100 transition-opacity"
            onClick={() => onRemoveMention(m.id, m.filePath)}
          >
            <svg
              className="w-2.5 h-2.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d={X_PATH} />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}
