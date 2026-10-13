/** One file of a unified diff, with its line counts. */
export interface DiffFile {
  path: string;
  added: number;
  removed: number;
}

/** The files a `git diff` names, in order, with the lines each adds and removes. */
export function diffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2], added: 0, removed: 0 };
      files.push(current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.added += 1;
    } else if (current && line.startsWith("-") && !line.startsWith("---")) {
      current.removed += 1;
    }
  }
  return files;
}
