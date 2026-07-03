import { useMemo, useRef } from "react";
import type { ActivityItem } from "../activity/types";

const WORKING_FILE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".svg",
  ".mmd",
  ".mermaid",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".tsv",
  ".html",
  ".css",
  ".sql",
  ".sh",
  ".bash",
  ".py",
  ".js",
  ".ts",
  ".rs",
  ".log",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

export const WRITE_KINDS = new Set([
  "edit",
  "delete",
  "move",
  "write_file",
  "edit_file",
  "create_file",
]);

export type WorkingFileEntry = { path: string; addedAt: number };

export function isWorkingFile(path: string): boolean {
  const inHiddenDir = /\/\.[^/]+\//.test(path) || /^\.[^/]+\//.test(path);
  if (!inHiddenDir) return false;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return WORKING_FILE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export function useWorkingFileTracker(
  sessionKey: number,
  items: ActivityItem[],
): { workingFiles: WorkingFileEntry[]; sessionChangedFiles: string[] } {
  const seenAt = useRef<Map<string, number>>(new Map());
  const lastSessionKey = useRef<number | null>(null);

  return useMemo(() => {
    if (lastSessionKey.current !== sessionKey) {
      seenAt.current.clear();
      lastSessionKey.current = sessionKey;
    }
    const now = Date.now();
    const working = new Set<string>();
    const changed = new Set<string>();
    for (const item of items) {
      if (item.type !== "toolCall") continue;
      const tc = item.item;
      for (const c of tc.content) {
        if (c.type === "diff") {
          changed.add(c.path);
          if (isWorkingFile(c.path)) {
            working.add(c.path);
            if (!seenAt.current.has(c.path)) seenAt.current.set(c.path, now);
          }
        }
      }
      if (WRITE_KINDS.has(tc.kind)) {
        for (const loc of tc.locations) {
          changed.add(loc.path);
          if (isWorkingFile(loc.path)) {
            working.add(loc.path);
            if (!seenAt.current.has(loc.path)) seenAt.current.set(loc.path, now);
          }
        }
      }
    }
    return {
      workingFiles: [...working].map((path) => ({
        path,
        addedAt: seenAt.current.get(path) ?? now,
      })),
      sessionChangedFiles: [...changed],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, items]);
}
