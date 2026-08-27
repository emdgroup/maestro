import { useCallback, useMemo, useState } from "react";
import type { DiffFileWithName } from "@/types/review";
import type { DiffTarget } from "@/types/bindings";
import { useFileContentAtBaseQuery } from "@/services/worktree.service";
import { DiffViewer } from "./DiffViewer";

interface ExpandableDiffViewerProps extends Omit<
  React.ComponentProps<typeof DiffViewer>,
  "diffFile" | "loading" | "onRequestContext"
> {
  file: DiffFileWithName;
  projectId: number | null;
  /** The worktree the diff was taken in. */
  cwd: string | null;
  /** What the diff compares against — determines which revision the pre-image is read from. */
  diffTarget: DiffTarget;
}

/**
 * One file's diff, able to fetch the context git left out of it.
 *
 * `@git-diff-view` only offers its chunk-header expand controls when the `DiffFile` holds a full
 * copy of one side of the file; handed the old side it reconstructs the new one from the hunks.
 * Attaching that to every file up front is what this component exists to avoid: the structural
 * work is free, but it makes Shiki tokenize two whole files per card instead of only the diff
 * lines, which measured as a ~6x syntax-highlighting cost and turned the worst card in a large
 * review from 283ms into 1.8s of blocked main thread as it scrolled into view.
 *
 * So the fetch waits for a press on a chunk header. That press does not expand anything by
 * itself — it loads the pre-image, after which the library renders its own real arrows on every
 * chunk header of this file and behaves exactly as upstream from there.
 *
 * State lives here rather than in `DiffFileStack` for the memoisation: `DiffView` rebuilds its
 * `DiffFile` whenever the `data` prop's identity changes, so the merged object has to be stable
 * across renders. Built inside the stack's `items.map()` it would be a new object every render,
 * and every diff in the stack would rebuild and re-highlight on each one.
 */
export function ExpandableDiffViewer({
  file,
  projectId,
  cwd,
  diffTarget,
  ...viewerProps
}: ExpandableDiffViewerProps) {
  const [requested, setRequested] = useState(false);

  // A file the base does not have — an addition — has no pre-image to fetch, and its diff already
  // shows every line, so there is nothing expansion could reveal.
  const basePath = file.oldPath ?? (file.status === "A" ? null : file.fileName);

  const { data, isFetching } = useFileContentAtBaseQuery(
    projectId,
    cwd,
    diffTarget,
    basePath,
    requested,
  );

  const oldContent = data ?? null;

  const diffFile = useMemo(
    () =>
      oldContent === null
        ? file
        : {
            ...file,
            oldFile: {
              fileName: basePath ?? file.fileName,
              fileLang: file.newFile?.fileLang,
              content: oldContent,
            },
          },
    [file, oldContent, basePath],
  );

  const handleRequestContext = useCallback(() => setRequested(true), []);

  // Dropped once the content is in, so the library's own arrows take the cell over. Also withheld
  // where there is nothing to fetch, which leaves those hunk headers inert rather than clickable
  // and silently useless.
  const onRequestContext =
    basePath !== null && oldContent === null && !isFetching ? handleRequestContext : undefined;

  return (
    <DiffViewer
      diffFile={diffFile}
      loading={false}
      {...viewerProps}
      onRequestContext={onRequestContext}
    />
  );
}
