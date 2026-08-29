import { useCallback, useMemo } from "react";
import { treeFileOrder } from "./file-tree";
import {
  displayItemPath,
  type DiffFileWithName,
  type DisplayItem,
  type FileStatus,
} from "@/types/review";
import type { DiffFileStackHandle } from "./DiffFileStack";

/** The two counts a `--stat` query answers with, as one number. */
export function fileCountFrom(stats?: { file_count: number; untracked_count: number }): number {
  return stats ? stats.file_count + stats.untracked_count : 0;
}

/**
 * A diff's files as one ordered sequence.
 *
 * Modified and untracked files interleave rather than the new ones trailing: a reviewer reads a
 * task's changes as a whole, and a new file is no less part of them than a changed one. The order
 * is the file tree's, so the sidebar and the card stack agree on what comes next — which is also
 * what makes a row's index the card's index, and so what lets a click scroll to it and a scroll
 * highlight it back.
 */
export function buildDisplayItems(
  diffFiles: DiffFileWithName[],
  untrackedFiles: string[],
): DisplayItem[] {
  const items: DisplayItem[] = [
    ...diffFiles.map((file): DisplayItem => ({ kind: "diff", file })),
    ...untrackedFiles.map((path): DisplayItem => ({ kind: "untracked", path })),
  ];
  const order = treeFileOrder(
    items.map((item) => ({ fileName: displayItemPath(item), hunks: [] })),
  );
  const rank = new Map(order.map((path, index) => [path, index]));
  return [...items].sort(
    (a, b) => (rank.get(displayItemPath(a)) ?? 0) - (rank.get(displayItemPath(b)) ?? 0),
  );
}

/**
 * The same files as the file panel wants them: a path and a one-letter status.
 *
 * Untracked files keep their own letter rather than borrowing `A`. The two look the same in a
 * diff — every line is new — but they are not the same thing to a reviewer: an added file is part
 * of the change being reviewed, while an untracked one is a file nobody has told git about yet,
 * and may be a build artefact the agent never meant to leave behind.
 */
export function toPanelFiles(items: DisplayItem[]): Array<{
  fileName: string;
  status: FileStatus;
}> {
  return items.map((item) =>
    item.kind === "diff"
      ? { fileName: item.file.fileName, status: item.file.status ?? ("M" as const) }
      : { fileName: item.path, status: "U" as const },
  );
}

interface ReviewItemsInput {
  diffFiles: DiffFileWithName[];
  untrackedFiles: string[];
  /**
   * Applied to the stack as well as the panel — with the files rendered as a list rather than one
   * at a time, narrowing only the panel would leave the two disagreeing on screen.
   */
  search: string;
  selectedIndex: number;
  stackRef: React.RefObject<DiffFileStackHandle | null>;
}

/** The file list a review shows, and how its sidebar points into it. */
export function useReviewItems({
  diffFiles,
  untrackedFiles,
  search,
  selectedIndex,
  stackRef,
}: ReviewItemsInput) {
  const items = useMemo(() => {
    const ordered = buildDisplayItems(diffFiles, untrackedFiles);
    const query = search.trim().toLowerCase();
    return query
      ? ordered.filter((item) => displayItemPath(item).toLowerCase().includes(query))
      : ordered;
  }, [diffFiles, untrackedFiles, search]);

  const panelFiles = useMemo(() => toPanelFiles(items), [items]);

  /** Clicking a file in the panel scrolls the stack to it, rather than swapping the pane. */
  const selectFile = useCallback(
    (fileName: string) => {
      const index = items.findIndex((item) => displayItemPath(item) === fileName);
      if (index >= 0) stackRef.current?.navigateTo(index);
    },
    [items, stackRef],
  );

  const selectedPath = items[selectedIndex] ? displayItemPath(items[selectedIndex]) : null;

  return { items, panelFiles, selectFile, selectedPath };
}
