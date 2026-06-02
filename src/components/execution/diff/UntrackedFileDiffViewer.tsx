import { useMemo } from "react";
import { DiffModeEnum } from "@git-diff-view/react";
import { parseDiffString, computeFileStats } from "@/lib/diff-utils";
import { DiffViewer } from "./DiffViewer";
import { useUntrackedFileContentQuery } from "@/services/worktree.service";

interface UntrackedFileDiffViewerProps {
  projectId: number | null;
  worktreePath: string | null;
  filePath: string | null;
}

export function UntrackedFileDiffViewer({
  projectId,
  worktreePath,
  filePath,
}: UntrackedFileDiffViewerProps) {
  const { data, isLoading } = useUntrackedFileContentQuery(projectId, worktreePath, filePath);

  const diffFile = useMemo(() => {
    if (!data) return null;
    return parseDiffString(data)[0] ?? null;
  }, [data]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {diffFile && (
        <div className="px-3 py-2 border-b border-border bg-muted/20 shrink-0 flex items-center gap-2 text-xs">
          <span className="font-mono text-foreground truncate flex-1">{diffFile.fileName}</span>
          <span className="font-medium shrink-0 text-success">A</span>
          <span className="text-success shrink-0">
            +{computeFileStats(diffFile.hunks).insertions}
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        <DiffViewer diffFile={diffFile} loading={isLoading} diffViewMode={DiffModeEnum.Unified} />
      </div>
    </div>
  );
}
