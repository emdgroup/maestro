import { useMemo } from "react";
import type { DiffFileWithName } from "@/types/review";
import type { DiffTarget } from "@/types/bindings";
import { useFileContentAtBaseQuery } from "@/services/worktree.service";
import { DiffViewer } from "./DiffViewer";

interface ExpandableDiffViewerProps extends Omit<
  React.ComponentProps<typeof DiffViewer>,
  "diffFile" | "loading"
> {
  file: DiffFileWithName;
  projectId: number | null;
  /** The worktree the diff was taken in. */
  cwd: string | null;
  /** What the diff compares against — determines which revision the pre-image is read from. */
  diffTarget: DiffTarget;
}

/**
 * One file's diff, with the whole file behind it once it is highlighted.
 *
 * `@git-diff-view` only offers its chunk-header expand controls when the `DiffFile` holds a full
 * copy of one side of the file; handed the old side it reconstructs the new one from the hunks.
 * Without one, it builds each side from the diff lines alone, blank lines filling the gaps, and
 * the highlighter tokenizes that. A hunk opening inside a JSDoc block then reads as code, and a
 * backtick in its prose opens a template literal that runs on through the hunks below: replayed
 * against this repository's history, a third of TypeScript cards came out mostly miscoloured,
 * and pressing a chunk header fixed them, because that loaded the file.
 *
 * So the pre-image is fetched as soon as the card is highlighted, and the colour waits for it.
 * This used to wait for a press, because Shiki took ~6x longer over two whole files than over the
 * diff lines; Lezer takes 7–30ms over a whole file. Once it is in, the library renders its own
 * expand arrows on every chunk header of this file and behaves exactly as upstream from there.
 * Until then the chunk headers are inert.
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
  highlight = true,
  ...viewerProps
}: ExpandableDiffViewerProps) {
  // A file the base does not have — an addition — has no pre-image to fetch, and its diff already
  // shows every line, so there is nothing expansion could reveal.
  const basePath = file.oldPath ?? (file.status === "A" ? null : file.fileName);

  const { data, isFetching } = useFileContentAtBaseQuery(
    projectId,
    cwd,
    diffTarget,
    basePath,
    highlight,
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

  return (
    <DiffViewer
      diffFile={diffFile}
      loading={false}
      {...viewerProps}
      // Held back only while the first fetch is out. A null (past the size cap) or a failure
      // colours the diff lines alone rather than leaving the card plain.
      highlight={highlight && !(isFetching && data === undefined)}
    />
  );
}
