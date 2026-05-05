import { useState, useEffect, type Dispatch, type SetStateAction } from "react";
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
  viewMode: "uncommitted" | "untracked",
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

  // When the selected worktree changes, reset all staging state and navigation
  // so we don't briefly show the previous worktree's file header.
  useEffect(() => {
    setSelectedFileIndex(null);
    setFileSearch("");
    setStagedFiles(new Set());
    setStagedHunks(new Map());
    setCommitMessage("");
  }, [worktreePath]);

  // Clear staging state when switching between uncommitted/untracked modes
  useEffect(() => {
    setStagedFiles(new Set());
    setStagedHunks(new Map());
    setSelectedFileIndex(null);
    setCommitMessage("");
  }, [viewMode]);

  // Update auto-generated shelve name when worktree changes
  useEffect(() => {
    if (worktree) {
      setShelveName(buildDefaultShelveName(worktree));
    }
  }, [worktree]);

  // Auto-select the first file once diff data loads for the current worktree.
  // Only fires when selectedFileIndex is null (i.e. we haven't picked one yet),
  // so a background refetch does not bounce the user back to file 0 mid-navigation.
  useEffect(() => {
    if (diffFiles.length > 0) {
      setSelectedFileIndex((prev) => (prev === null ? 0 : prev));
    }
  }, [diffFiles]);

  return {
    stagedFiles,
    setStagedFiles,
    stagedHunks,
    setStagedHunks,
    commitMessage,
    setCommitMessage,
    shelveName,
    setShelveName,
    selectedFileIndex,
    setSelectedFileIndex,
    fileSearch,
    setFileSearch,
  };
}
