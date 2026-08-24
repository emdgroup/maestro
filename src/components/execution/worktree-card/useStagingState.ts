import { useState, type Dispatch, type SetStateAction } from "react";
import type { WorktreeWithStatus } from "@/types/bindings";
import type { DiffFileWithName } from "@/types/review";

function buildDefaultShelveName(worktree: WorktreeWithStatus): string {
  return `wip-${worktree.branch_name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-")}-${new Date().toISOString().split("T")[0]}`;
}

export interface StagingState {
  stagedFiles: Set<string>;
  setStagedFiles: Dispatch<SetStateAction<Set<string>>>;
  stagedHunks: Map<string, Set<number>>;
  setStagedHunks: Dispatch<SetStateAction<Map<string, Set<number>>>>;
  commitMessage: string;
  setCommitMessage: Dispatch<SetStateAction<string>>;
  shelveName: string;
  setShelveName: Dispatch<SetStateAction<string>>;
  selectedFileIndex: number | null;
  setSelectedFileIndex: Dispatch<SetStateAction<number | null>>;
  fileSearch: string;
  setFileSearch: Dispatch<SetStateAction<string>>;
}

export function useStagingState(
  worktreePath: string | null | undefined,
  worktree: WorktreeWithStatus | null,
  diffFiles: DiffFileWithName[],
): StagingState {
  const [stagedFiles, setStagedFiles] = useState<Set<string>>(new Set());
  const [stagedHunks, setStagedHunks] = useState<Map<string, Set<number>>>(new Map());
  const [commitMessage, setCommitMessage] = useState("");
  const [shelveName, setShelveName] = useState(() =>
    worktree ? buildDefaultShelveName(worktree) : "",
  );
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null);
  const [fileSearch, setFileSearch] = useState("");

  // Switching worktrees resets the staging selection. Tracked in state rather than a
  // ref so the comparison stays a pure render-phase read — React re-renders with the
  // new state before committing, so this is still a single visible frame.
  const [prevWorktreePath, setPrevWorktreePath] = useState(worktreePath);

  function resetSelectionState() {
    setStagedFiles(new Set());
    setStagedHunks(new Map());
    setSelectedFileIndex(null);
    setCommitMessage("");
  }

  if (prevWorktreePath !== worktreePath) {
    setPrevWorktreePath(worktreePath);
    resetSelectionState();
    setFileSearch("");
    if (worktree) {
      setShelveName(buildDefaultShelveName(worktree));
    }
  }

  const effectiveSelectedFileIndex =
    selectedFileIndex === null && diffFiles.length > 0 ? 0 : selectedFileIndex;

  return {
    stagedFiles,
    setStagedFiles,
    stagedHunks,
    setStagedHunks,
    commitMessage,
    setCommitMessage,
    shelveName,
    setShelveName,
    selectedFileIndex: effectiveSelectedFileIndex,
    setSelectedFileIndex,
    fileSearch,
    setFileSearch,
  };
}
