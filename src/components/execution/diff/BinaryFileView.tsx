import { formatBytes } from "@/lib/format-utils";
import { binaryMimeForExtension } from "@/components/execution/activity/fileTypeUtils";
import { useBinaryFileInfoQuery } from "@/services/worktree.service";
import type { DiffTarget } from "@/types/bindings";

interface BinaryFileProps {
  projectId: number | null;
  /** The worktree the diff was taken in. */
  worktreePath: string | null;
  /** What the diff compares against, or null for an untracked file, which is in no revision. */
  diffTarget: DiffTarget | null;
  path: string;
}

/** The mime the bytes should be rendered as, or undefined for anything not a displayable image. */
function imageMime(path: string): string | undefined {
  const mime = binaryMimeForExtension(path);
  return mime?.startsWith("image/") ? mime : undefined;
}

/**
 * Both halves ask the same question, and asking it the same way is what keeps it one git call:
 * `wantPreview` is derived from the path rather than passed in, so the header's query key and the
 * body's are identical and TanStack serves them from one fetch.
 */
function useBinaryInfo({ projectId, worktreePath, diffTarget, path }: BinaryFileProps) {
  return useBinaryFileInfoQuery(projectId, worktreePath, diffTarget, path, imageMime(path) != null);
}

/**
 * What a binary file shows where a text file shows its `+`/`-` line counts.
 *
 * Bytes are the only thing a binary change can be counted in. A file that only exists on one side
 * is signed like a line count; one that changed on both is written as a transition, because `+3 KB
 * -1 KB` would read as three kilobytes added *and* one removed rather than a replacement.
 */
export function BinaryDiffStats(props: BinaryFileProps) {
  const { data } = useBinaryInfo(props);
  if (!data) return null;
  const { old_size, new_size } = data;
  if (old_size === 0 && new_size === 0) return null;
  return (
    <span className="flex items-center gap-1 shrink-0 text-xs font-mono">
      {old_size === 0 ? (
        <span className="text-success">+{formatBytes(new_size)}</span>
      ) : new_size === 0 ? (
        <span className="text-destructive">-{formatBytes(old_size)}</span>
      ) : (
        <span className="text-muted-foreground">
          {formatBytes(old_size)} → {formatBytes(new_size)}
        </span>
      )}
    </span>
  );
}

/**
 * A binary file's card body: the picture where there is one to show, and the sentence otherwise.
 *
 * The preview is absent for anything that is not an image, for a file past the backend's binary
 * read limit, and for a deletion — there is nothing left on disk to read. Each of those falls back
 * to `note`, which is what the card showed before any of this existed.
 */
export function BinaryFileBody({ note, ...props }: BinaryFileProps & { note: string }) {
  const { data, isLoading } = useBinaryInfo(props);
  const mime = imageMime(props.path);

  if (isLoading) {
    return <div className="px-3 py-6 text-xs text-center text-muted-foreground">Loading...</div>;
  }

  if (!mime || !data?.preview) {
    return <div className="px-3 py-6 text-xs text-center text-muted-foreground">{note}</div>;
  }

  return (
    <div className="flex flex-col items-center gap-2 px-3 py-4">
      {/* Bounded in the viewport rather than at natural size: a screenshot committed at 3x is
          several screens tall, and scrolling past it is not reading the review. */}
      <img
        src={`data:${mime};base64,${data.preview}`}
        alt={props.path}
        className="max-w-full max-h-[60vh] object-contain"
      />
      <p className="text-xs text-muted-foreground font-mono">{formatBytes(data.new_size)}</p>
    </div>
  );
}
