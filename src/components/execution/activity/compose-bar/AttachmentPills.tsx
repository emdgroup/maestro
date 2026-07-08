import { iconForFilePath } from "./composeUtils";
import type { MentionEntry } from "./mentionEntry";

const X_PATH = "M18 6L6 18M6 6l12 12";

interface Props {
  mentions: MentionEntry[];
  onRemoveMention: (id: string, filePath: string) => void;
}

export function AttachmentPills({ mentions, onRemoveMention }: Props) {
  if (mentions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 px-3.5 pt-2.5">
      {mentions.map((m) => (
        <span
          key={m.id}
          title={m.filePath}
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
