import { useEffect, useMemo, useRef } from "react";
import type { ActivityItem } from "../activity/types";

const WORKING_FILE_EXTENSIONS = new Set([
  ".md", ".txt", ".svg", ".mmd", ".mermaid",
  ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".tsv",
  ".html", ".css", ".sql", ".sh", ".bash",
  ".py", ".js", ".ts", ".rs",
  ".log", ".png", ".jpg", ".jpeg", ".gif", ".webp",
]);

export const WRITE_KINDS = new Set([
  "edit", "delete", "move", "write_file", "edit_file", "create_file",
]);

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
  onWorkingFilesChange: ((sessionKey: number, files: string[]) => void) | undefined,
  onSessionChangedFilesChange: ((sessionKey: number, files: string[]) => void) | undefined,
): { workingFiles: string[]; sessionChangedFiles: string[] } {
  const { workingFiles, sessionChangedFiles } = useMemo(() => {
    const working = new Set<string>();
    const changed = new Set<string>();
    for (const item of items) {
      if (item.type !== "toolCall") continue;
      const tc = item.item;
      for (const c of tc.content) {
        if (c.type === "diff") {
          changed.add(c.path);
          if (isWorkingFile(c.path)) working.add(c.path);
        }
      }
      if (WRITE_KINDS.has(tc.kind)) {
        for (const loc of tc.locations) {
          changed.add(loc.path);
          if (isWorkingFile(loc.path)) working.add(loc.path);
        }
      }
    }
    return { workingFiles: [...working], sessionChangedFiles: [...changed] };
  }, [items]);

  // Callback refs prevent effect re-runs on parent re-renders (new function identity each render).
  const onWorkingFilesChangeRef = useRef(onWorkingFilesChange);
  onWorkingFilesChangeRef.current = onWorkingFilesChange;
  const onSessionChangedFilesChangeRef = useRef(onSessionChangedFilesChange);
  onSessionChangedFilesChangeRef.current = onSessionChangedFilesChange;

  useEffect(() => {
    onWorkingFilesChangeRef.current?.(sessionKey, workingFiles);
    onSessionChangedFilesChangeRef.current?.(sessionKey, sessionChangedFiles);
  }, [sessionKey, workingFiles, sessionChangedFiles]);

  return { workingFiles, sessionChangedFiles };
}
