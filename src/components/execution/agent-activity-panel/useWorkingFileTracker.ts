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

/**
 * `root` is the session's working directory, stripped before the dot-directory test: an
 * isolated task runs in `<project>/.maestro/worktrees/<name>`, so on the absolute path every
 * file the agent touched sat in a dot-directory and counted as an artifact.
 */
export function isWorkingFile(path: string, root?: string): boolean {
  let rel = path.replace(/\\/g, "/");
  const base = root?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && rel.startsWith(base + "/")) rel = rel.slice(base.length + 1);
  if (!/(^|\/)\.[^/]+\//.test(rel)) return false;
  const dot = rel.lastIndexOf(".");
  if (dot === -1) return false;
  return WORKING_FILE_EXTENSIONS.has(rel.slice(dot).toLowerCase());
}

export function useWorkingFileTracker(
  sessionId: string,
  items: ActivityItem[],
  cwd?: string,
): { workingFiles: WorkingFileEntry[] } {
  const seenAt = useRef<Map<string, number>>(new Map());
  const lastSessionId = useRef<string | null>(null);

  return useMemo(() => {
    if (lastSessionId.current !== sessionId) {
      seenAt.current.clear();
      lastSessionId.current = sessionId;
    }
    const now = Date.now();
    const working = new Set<string>();
    const add = (path: string) => {
      if (!isWorkingFile(path, cwd)) return;
      working.add(path);
      if (!seenAt.current.has(path)) seenAt.current.set(path, now);
    };

    for (const item of items) {
      if (item.type !== "toolCall") continue;
      const tc = item.item;
      for (const c of tc.content) {
        if (c.type === "diff") add(c.path);
      }
      if (WRITE_KINDS.has(tc.kind)) {
        for (const loc of tc.locations) add(loc.path);
        // ACP puts the file on `locations`, but agents that skip it still send it on the
        // tool input — the same fallback `agentMeta` resolves `filePath` with. Reading
        // only `locations` here meant those agents produced no artifacts at all, so
        // neither the Overview card nor the Artifacts tab ever appeared for them.
        if (tc.meta?.filePath) add(tc.meta.filePath);
      }
    }
    return {
      workingFiles: [...working].map((path) => ({
        path,
        addedAt: seenAt.current.get(path) ?? now,
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, items, cwd]);
}
