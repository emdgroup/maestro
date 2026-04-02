import React, { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Check, Minus } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "@/lib";
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

const DirectoryNode: React.FC<{
  node: FileTreeNode;
  selectedFile: string | null;
  onSelectFile: (fileName: string) => void;
  level: number;
  checkedFiles?: Map<string, "checked" | "unchecked" | "indeterminate">;
  onToggleFile?: (fileName: string) => void;
}> = ({ node, selectedFile, onSelectFile, level, checkedFiles, onToggleFile }) => {
  const [isExpanded, setIsExpanded] = useState(true);

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
        <span className="font-mono truncate">{node.name}</span>
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
}> = ({ node, selectedFile, onSelectFile, level, checkedFiles, onToggleFile }) => {
  if (node.isDir) {
    return (
      <DirectoryNode
        node={node}
        selectedFile={selectedFile}
        onSelectFile={onSelectFile}
        level={level}
        checkedFiles={checkedFiles}
        onToggleFile={onToggleFile}
      />
    );
  }

  const isSelected = node.fileName === selectedFile;
  const status = node.fileStatus ?? "M";
  const statusColor =
    status === "A" ? "text-success" : status === "D" ? "text-destructive" : "text-muted-foreground";
  const checkState = node.fileName ? (checkedFiles?.get(node.fileName) ?? "unchecked") : "unchecked";

  return (
    <div
      onClick={() => node.fileName && onSelectFile(node.fileName)}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1.5 cursor-pointer border-l-2 transition-colors text-xs",
        isSelected ? "border-ring bg-muted/20" : "border-transparent hover:bg-muted/10",
      )}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
    >
      {checkedFiles && onToggleFile && node.fileName && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onToggleFile(node.fileName!);
          }}
          className="shrink-0"
        >
          <CheckboxPrimitive.Root
            checked={checkState === "checked"}
            indeterminate={checkState === "indeterminate"}
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
        </span>
      )}
      <span className={cn("font-medium shrink-0", statusColor)}>{status}</span>
      <span className="font-mono truncate">{node.name}</span>
    </div>
  );
};

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  selectedFile,
  onSelectFile,
  checkedFiles,
  onToggleFile,
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
        />
      ))}
    </div>
  );
};
