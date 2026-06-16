import React, { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Check, Minus, CheckCheck } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@/lib/ui-utils";
import { DiffFileWithName } from "@/types/review";

interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNode[];
  fileStatus?: "A" | "M" | "D";
  fileName?: string;
}

interface FileTreeProps {
  files: DiffFileWithName[];
  selectedFile: string | null;
  onSelectFile: (fileName: string) => void;
  checkedFiles?: Map<string, "checked" | "unchecked" | "indeterminate">;
  onToggleFile?: (fileName: string) => void;
  onToggleFolder?: (fileNames: string[]) => void;
  viewedFiles?: Set<string>;
}

/**
 * Build a hierarchical file tree from flat file list
 */
function buildFileTree(files: DiffFileWithName[]): FileTreeNode[] {
  // Use a nested map structure: path → node, children tracked by reference
  const rootChildren: FileTreeNode[] = [];
  const nodeByPath: Record<string, FileTreeNode> = {};

  for (const file of files) {
    const parts = file.fileName.split("/");

    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join("/");
      if (nodeByPath[path]) continue;

      const isLast = i === parts.length - 1;
      const node: FileTreeNode = {
        name: parts[i],
        path,
        isDir: !isLast,
        children: isLast ? undefined : [],
        fileName: isLast ? file.fileName : undefined,
        fileStatus: isLast ? (file.status ?? "M") : undefined,
      };
      nodeByPath[path] = node;

      if (i === 0) {
        rootChildren.push(node);
      } else {
        const parentPath = parts.slice(0, i).join("/");
        nodeByPath[parentPath].children!.push(node);
      }
    }
  }

  function sortNode(nodes: FileTreeNode[]): FileTreeNode[] {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children) sortNode(node.children);
    }
    return nodes;
  }

  return sortNode(rootChildren);
}

/**
 * Collect all leaf file fileName values under a node (recursively).
 */
function getDescendantFiles(node: FileTreeNode): string[] {
  if (!node.isDir) {
    return node.fileName ? [node.fileName] : [];
  }
  const result: string[] = [];
  for (const child of node.children ?? []) {
    result.push(...getDescendantFiles(child));
  }
  return result;
}

/**
 * Compute tri-state check state for a folder node based on its descendants.
 */
function getFolderCheckState(
  node: FileTreeNode,
  checkedFiles: Map<string, "checked" | "unchecked" | "indeterminate">,
): "checked" | "unchecked" | "indeterminate" {
  const descendants = getDescendantFiles(node);
  if (descendants.length === 0) return "unchecked";
  const checkedCount = descendants.filter((f) => checkedFiles.get(f) === "checked").length;
  if (checkedCount === 0) return "unchecked";
  if (checkedCount === descendants.length) return "checked";
  return "indeterminate";
}

const DirectoryNode: React.FC<{
  node: FileTreeNode;
  selectedFile: string | null;
  onSelectFile: (fileName: string) => void;
  level: number;
  checkedFiles?: Map<string, "checked" | "unchecked" | "indeterminate">;
  onToggleFile?: (fileName: string) => void;
  onToggleFolder?: (fileNames: string[]) => void;
  viewedFiles?: Set<string>;
}> = ({
  node,
  selectedFile,
  onSelectFile,
  level,
  checkedFiles,
  onToggleFile,
  onToggleFolder,
  viewedFiles,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const folderCheckState =
    checkedFiles && onToggleFolder ? getFolderCheckState(node, checkedFiles) : null;

  return (
    <div>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1 w-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/10 transition-colors"
        style={{ paddingLeft: `${level * 12 + 8}px` }}
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {/* Folder tri-state checkbox — only when checkedFiles + onToggleFolder provided */}
        {folderCheckState !== null && checkedFiles && onToggleFolder && (
          <CheckboxPrimitive.Root
            checked={folderCheckState === "checked"}
            indeterminate={folderCheckState === "indeterminate"}
            onCheckedChange={() => onToggleFolder(getDescendantFiles(node))}
            onClick={(e) => e.stopPropagation()}
            className="border-border dark:bg-input/30 data-checked:bg-accent data-checked:text-foreground data-checked:border-foreground flex size-3.5 items-center justify-center rounded-[4px] border shadow-xs shrink-0 outline-none"
            tabIndex={-1}
          >
            <CheckboxPrimitive.Indicator className="[&>svg]:size-3 grid place-content-center text-current">
              {folderCheckState === "indeterminate" ? (
                <Minus className="size-3" />
              ) : (
                <Check className="size-3" />
              )}
            </CheckboxPrimitive.Indicator>
          </CheckboxPrimitive.Root>
        )}
        <span className="font-mono truncate">{node.name}</span>
        {viewedFiles &&
          (() => {
            const descendants = getDescendantFiles(node);
            const allViewed =
              descendants.length > 0 && descendants.every((f) => viewedFiles.has(f));
            return allViewed ? (
              <CheckCheck className="size-3.5 shrink-0 text-success ml-auto" />
            ) : null;
          })()}
      </button>
      {isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileNode
              key={child.path}
              node={child}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              level={level + 1}
              checkedFiles={checkedFiles}
              onToggleFile={onToggleFile}
              onToggleFolder={onToggleFolder}
              viewedFiles={viewedFiles}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const FileNode: React.FC<{
  node: FileTreeNode;
  selectedFile: string | null;
  onSelectFile: (fileName: string) => void;
  level: number;
  checkedFiles?: Map<string, "checked" | "unchecked" | "indeterminate">;
  onToggleFile?: (fileName: string) => void;
  onToggleFolder?: (fileNames: string[]) => void;
  viewedFiles?: Set<string>;
}> = ({
  node,
  selectedFile,
  onSelectFile,
  level,
  checkedFiles,
  onToggleFile,
  onToggleFolder,
  viewedFiles,
}) => {
  if (node.isDir) {
    return (
      <DirectoryNode
        node={node}
        selectedFile={selectedFile}
        onSelectFile={onSelectFile}
        level={level}
        checkedFiles={checkedFiles}
        onToggleFile={onToggleFile}
        onToggleFolder={onToggleFolder}
        viewedFiles={viewedFiles}
      />
    );
  }

  const isSelected = node.fileName === selectedFile;
  const status = node.fileStatus ?? "M";
  const statusColor =
    status === "A" ? "text-success" : status === "D" ? "text-destructive" : "text-muted-foreground";
  const checkState = node.fileName
    ? (checkedFiles?.get(node.fileName) ?? "unchecked")
    : "unchecked";

  return (
    <div
      onClick={() => node.fileName && onSelectFile(node.fileName)}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1.5 cursor-pointer border-l-2 transition-colors text-xs",
        isSelected ? "border-ring selected-file-item" : "border-transparent hover:bg-muted/10",
      )}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
    >
      {checkedFiles && onToggleFile && node.fileName && (
        <CheckboxPrimitive.Root
          checked={checkState === "checked"}
          indeterminate={checkState === "indeterminate"}
          onCheckedChange={() => onToggleFile(node.fileName!)}
          onClick={(e) => e.stopPropagation()}
          className="border-border dark:bg-input/30 data-checked:bg-accent data-checked:text-foreground data-checked:border-foreground flex size-4 items-center justify-center rounded-[4px] border shadow-xs shrink-0 outline-none"
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
      <span className={cn("font-medium shrink-0", statusColor)}>{status}</span>
      <span className="font-mono truncate">{node.name}</span>
      {viewedFiles?.has(node.fileName!) && (
        <CheckCheck className="size-3.5 shrink-0 text-success ml-auto" />
      )}
    </div>
  );
};

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  selectedFile,
  onSelectFile,
  checkedFiles,
  onToggleFile,
  onToggleFolder,
  viewedFiles,
}) => {
  const tree = useMemo(() => buildFileTree(files), [files]);

  if (files.length === 0) {
    return null;
  }

  return (
    <div className="py-1">
      {tree.map((node) => (
        <FileNode
          key={node.path}
          node={node}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          level={0}
          checkedFiles={checkedFiles}
          onToggleFile={onToggleFile}
          onToggleFolder={onToggleFolder}
          viewedFiles={viewedFiles}
        />
      ))}
    </div>
  );
};
