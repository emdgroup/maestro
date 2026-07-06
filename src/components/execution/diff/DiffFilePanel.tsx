import { Check, Minus, CheckCheck } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { FileTree } from "./FileTree";
import { useDiffState } from "./DiffStateContext";

export interface DiffFile {
  fileName: string;
  hunks: string[];
  status?: "A" | "M" | "D";
}

interface DiffFilePanelProps {
  mode?: "worktree" | "review" | "session";
  modifiedCount: number;
  untrackedCount: number;
  diffLoading: boolean;
  diffFiles: DiffFile[];
  filteredDiffFiles: DiffFile[];
  untrackedFiles: string[];
  stagedFiles: Set<string>;
  getFileCheckState: (fileName: string) => "checked" | "unchecked" | "indeterminate";
  onFileToggle: (fileName: string) => void;
  onFolderToggle: (fileNames: string[]) => void;
  onToggleUntrackedFile: (filePath: string) => void;
  hasAnyStaged: boolean;
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  onCommit: () => void;
  isCommitting: boolean;
  isStaging: boolean;
  onStageUntracked: () => Promise<void>;
  viewedFiles?: Set<string>;
  onToggleViewed?: (fileName: string) => void;
  scopeSelector?: React.ReactNode;
  onFileComment?: (fileName: string) => void;
}

export function DiffFilePanel({
  mode = "worktree",
  modifiedCount,
  untrackedCount,
  diffLoading,
  diffFiles,
  filteredDiffFiles,
  untrackedFiles,
  stagedFiles,
  getFileCheckState,
  onFileToggle,
  onFolderToggle,
  onToggleUntrackedFile,
  hasAnyStaged,
  commitMessage,
  onCommitMessageChange,
  onCommit,
  isCommitting,
  isStaging,
  onStageUntracked,
  viewedFiles,
  onToggleViewed,
  scopeSelector,
  onFileComment: _onFileComment,
}: DiffFilePanelProps) {
  const { viewMode, setViewMode, selectedFileIndex, setSelectedFileIndex, fileListMode } =
    useDiffState();
  const showWorktreeControls = mode === "worktree" && viewMode === "uncommitted";
  const showUntrackedControls =
    (mode === "worktree" || mode === "review") && viewMode === "untracked";
  const showTabs = (mode === "worktree" || mode === "review") && untrackedCount > 0;
  const showCheckboxes = mode === "worktree";

  return (
    <div className="w-64 shrink-0 flex flex-col border-r border-border">
      {/* Scope selector slot */}
      {scopeSelector && <div className="border-b border-border shrink-0">{scopeSelector}</div>}

      {/* Tabs: only in worktree mode */}
      {showTabs && (
        <div className="flex border-b border-border shrink-0">
          <Button
            variant="ghost"
            onClick={() => setViewMode("uncommitted")}
            className={cn(
              "flex-1 px-3 py-2 h-auto text-xs font-medium border-b-2 transition-colors",
              viewMode === "uncommitted"
                ? "border-accent text-foreground hover:bg-transparent"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/10",
            )}
          >
            Modified ({modifiedCount})
          </Button>
          <Button
            variant="ghost"
            onClick={() => setViewMode("untracked")}
            className={cn(
              "flex-1 px-3 py-2 h-auto text-xs font-medium border-b-2 transition-colors",
              viewMode === "untracked"
                ? "border-accent text-foreground hover:bg-transparent"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/10",
            )}
          >
            Untracked ({untrackedCount})
          </Button>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {showUntrackedControls ? (
          /* Untracked files view (worktree mode only) */
          diffLoading ? (
            <div className="text-xs text-muted-foreground py-8 text-center">Loading...</div>
          ) : untrackedFiles.length === 0 ? (
            <div className="text-xs text-muted-foreground py-8 text-center">No untracked files</div>
          ) : fileListMode === "tree" ? (
            <FileTree
              files={untrackedFiles.map((p) => ({
                fileName: p,
                hunks: [] as string[],
                status: "A" as const,
              }))}
              selectedFile={
                selectedFileIndex !== null ? (untrackedFiles[selectedFileIndex] ?? null) : null
              }
              onSelectFile={(fileName) => {
                const idx = untrackedFiles.indexOf(fileName);
                if (idx >= 0) setSelectedFileIndex(idx);
              }}
              checkedFiles={
                new Map(
                  untrackedFiles.map((p) => [
                    p,
                    stagedFiles.has(p) ? ("checked" as const) : ("unchecked" as const),
                  ]),
                )
              }
              onToggleFile={onToggleUntrackedFile}
              onToggleFolder={(fileNames) => {
                const allChecked = fileNames.every((f) => stagedFiles.has(f));
                fileNames.forEach((f) => {
                  if (allChecked) {
                    if (stagedFiles.has(f)) onToggleUntrackedFile(f);
                  } else {
                    if (!stagedFiles.has(f)) onToggleUntrackedFile(f);
                  }
                });
              }}
              viewedFiles={viewedFiles}
            />
          ) : (
            untrackedFiles.map((filePath, index) => {
              const basename = filePath.split("/").pop() ?? filePath;
              const isChecked = stagedFiles.has(filePath);
              return (
                <div
                  key={filePath}
                  onClick={() => setSelectedFileIndex(index)}
                  className={cn(
                    "px-2 py-2 cursor-pointer border-l-2 transition-colors",
                    index === selectedFileIndex
                      ? "border-ring selected-file-item"
                      : "border-transparent hover:bg-muted/10",
                  )}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {showCheckboxes && (
                      <CheckboxPrimitive.Root
                        checked={isChecked}
                        onCheckedChange={() => onToggleUntrackedFile(filePath)}
                        onClick={(e) => e.stopPropagation()}
                        className="border-border dark:bg-input/30 data-checked:bg-accent data-checked:text-foreground data-checked:border-foreground flex size-4 items-center justify-center rounded-sm border shadow-xs shrink-0 outline-none"
                        tabIndex={-1}
                      >
                        <CheckboxPrimitive.Indicator className="[&>svg]:size-3.5 grid place-content-center text-current">
                          <Check className="size-3.5" />
                        </CheckboxPrimitive.Indicator>
                      </CheckboxPrimitive.Root>
                    )}
                    <span className="text-xs font-medium shrink-0 text-muted-foreground">U</span>
                    <span className="text-xs font-mono truncate flex-1 min-w-0">{basename}</span>
                    {onToggleViewed && viewedFiles?.has(filePath) && (
                      <Button
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleViewed(filePath);
                        }}
                        className="shrink-0 text-success hover:text-foreground h-auto p-0"
                        title="Mark as unviewed"
                      >
                        <CheckCheck className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )
        ) : diffLoading ? (
          <div className="text-xs text-muted-foreground py-8 text-center">Loading...</div>
        ) : diffFiles.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center" />
        ) : fileListMode === "tree" ? (
          <FileTree
            files={filteredDiffFiles}
            selectedFile={
              selectedFileIndex !== null ? (diffFiles[selectedFileIndex]?.fileName ?? null) : null
            }
            onSelectFile={(fileName) => {
              const idx = filteredDiffFiles.findIndex((f) => f.fileName === fileName);
              setSelectedFileIndex(idx >= 0 ? idx : null);
            }}
            checkedFiles={
              showCheckboxes
                ? new Map(filteredDiffFiles.map((f) => [f.fileName, getFileCheckState(f.fileName)]))
                : undefined
            }
            onToggleFile={showCheckboxes ? onFileToggle : undefined}
            onToggleFolder={showCheckboxes ? onFolderToggle : undefined}
            viewedFiles={viewedFiles}
          />
        ) : (
          filteredDiffFiles.map((file) => {
            const realIndex = diffFiles.findIndex((f) => f.fileName === file.fileName);
            const basename = file.fileName.split("/").pop() ?? file.fileName;
            const status = file.status ?? "M";
            const statusColor =
              status === "A"
                ? "text-success"
                : status === "D"
                  ? "text-destructive"
                  : "text-muted-foreground";
            const checkState = getFileCheckState(file.fileName);
            return (
              <div
                key={file.fileName}
                onClick={() => setSelectedFileIndex(realIndex)}
                className={cn(
                  "px-2 py-2 cursor-pointer border-l-2 transition-colors",
                  realIndex === selectedFileIndex
                    ? "border-ring selected-file-item"
                    : "border-transparent hover:bg-muted/10",
                )}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  {showCheckboxes && (
                    <CheckboxPrimitive.Root
                      checked={checkState === "checked"}
                      indeterminate={checkState === "indeterminate"}
                      onCheckedChange={() => onFileToggle(file.fileName)}
                      onClick={(e) => e.stopPropagation()}
                      className="border-border dark:bg-input/30 data-checked:bg-accent data-checked:text-foreground data-checked:border-foreground flex size-4 items-center justify-center rounded-sm border shadow-xs shrink-0 outline-none"
                      tabIndex={-1}
                    >
                      <CheckboxPrimitive.Indicator className="[&>svg]:size-3.5 grid place-content-center text-current">
                        {checkState === "indeterminate" ? (
                          <Minus className="size-3.5" />
                        ) : (
                          <Check className="size-3.5" />
                        )}
                      </CheckboxPrimitive.Indicator>
                    </CheckboxPrimitive.Root>
                  )}
                  <span className={cn("text-xs font-medium shrink-0", statusColor)}>{status}</span>
                  <span className="text-xs font-mono truncate flex-1 min-w-0">{basename}</span>
                  {onToggleViewed && viewedFiles?.has(file.fileName) && (
                    <Button
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleViewed(file.fileName);
                      }}
                      className="shrink-0 text-success hover:text-foreground h-auto p-0"
                      title="Mark as unviewed"
                    >
                      <CheckCheck className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Bottom action area (worktree mode only) */}
      {showUntrackedControls
        ? stagedFiles.size > 0 && (
            <div className="border-t border-border p-2 shrink-0">
              <Button size="sm" className="w-full" disabled={isStaging} onClick={onStageUntracked}>
                {isStaging ? "Staging..." : "Stage Selected"}
              </Button>
            </div>
          )
        : showWorktreeControls &&
          hasAnyStaged && (
            <div className="border-t border-border p-2 shrink-0 flex flex-col gap-2">
              <Textarea
                placeholder="Commit message..."
                value={commitMessage}
                onChange={(e) => onCommitMessageChange(e.target.value)}
                className="text-xs min-h-15 resize-none"
                rows={3}
              />
              <Button
                size="sm"
                className="w-full"
                disabled={!commitMessage.trim() || isCommitting || isStaging}
                onClick={onCommit}
              >
                {isCommitting || isStaging ? "Committing..." : "Commit"}
              </Button>
            </div>
          )}
    </div>
  );
}
