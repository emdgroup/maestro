import { useCallback, useEffect, useRef, useState } from "react";
import { displayItemPath, type DisplayItem } from "@/types/review";

/**
 * What each file looked like, for deciding whether it changed since it was marked.
 *
 * An untracked file's body is fetched per card rather than carried by the diff, so there is
 * nothing to fingerprint here and editing one does not clear its mark.
 */
function fingerprints(items: DisplayItem[]): Map<string, string> {
  return new Map(
    items.map((item) => [
      displayItemPath(item),
      item.kind === "diff" ? item.file.hunks.join("\n") : "",
    ]),
  );
}

/**
 * Which files the reader has marked viewed, dropped again when the file changes underneath them.
 *
 * The diff re-fetches on an interval while the agent keeps working, so a mark left standing claims
 * a file was read at a version that is no longer on screen. A file with no fingerprint yet — the
 * first diff to arrive after the marks were restored from storage — is left alone, otherwise
 * reopening a review would clear everything it just remembered.
 *
 * `items` must be the whole file list, not a searched subset: a file filtered out of view can
 * still change, and it has to lose its mark when it does.
 */
export function useViewedFiles(items: DisplayItem[], initial?: () => Set<string>) {
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(() => initial?.() ?? new Set());
  const seen = useRef(fingerprints(items));

  useEffect(() => {
    const next = fingerprints(items);
    setViewedFiles((prev) => {
      const stale = [...prev].filter(
        (path) => seen.current.has(path) && next.get(path) !== seen.current.get(path),
      );
      seen.current = next;
      if (stale.length === 0) return prev;
      const kept = new Set(prev);
      for (const path of stale) kept.delete(path);
      return kept;
    });
  }, [items]);

  const toggleViewed = useCallback((fileName: string) => {
    setViewedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }, []);

  return { viewedFiles, toggleViewed };
}
