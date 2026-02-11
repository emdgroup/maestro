import React, { useState, useMemo } from "react";
import { DiffFileWithName } from "../types/review";

interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNode[];
  fileStatus?: "added" | "modified" | "deleted";
  fileName?: string;
}

interface FileTreeProps {
  files: DiffFileWithName[];
  selectedFile: string | null;
  onSelectFile: (fileName: string) => void;
}

/**
 * Build a hierarchical file tree from flat file list
 */
function buildFileTree(files: DiffFileWithName[]): FileTreeNode[] {
  const root: Record<string, FileTreeNode> = {};

  for (const file of files) {
    const parts = file.fileName.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");

      if (!current[part]) {
        current[part] = {
          name: part,
          path,
          isDir: !isLast,
          children: isLast ? undefined : [],
          fileName: isLast ? file.fileName : undefined,
        };
      }

      if (!isLast) {
        if (!current[part].children) {
          current[part].children = [];
        }
        current = current[part].children!.reduce(
          (acc, node) => {
            acc[node.name] = node;
            return acc;
          },
          {} as Record<string, FileTreeNode>
        );
      } else {
        // This is a file node, infer status from hunks
        current[part].fileName = file.fileName;
        // Simple heuristic: check first hunk line for add/remove
        if (file.hunks && file.hunks.length > 0) {
          const firstHunk = file.hunks.find((h) => h.startsWith("@@"));
          if (firstHunk) {
            // For simplicity, mark as modified (full conflict detection deferred)
            current[part].fileStatus = "modified";
          }
        }
      }
    }
  }

  // Convert to array and sort
  const sortedTree = Object.values(root).sort((a, b) => {
    // Directories first
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  // Recursively sort children
  function sortChildren(node: FileTreeNode) {
    if (node.children) {
      node.children.sort((a, b) => {
        if (a.isDir !== b.isDir) {
          return a.isDir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortChildren);
    }
  }

  sortedTree.forEach(sortChildren);
  return sortedTree;
}

/**
 * Get file extension for icon/styling
 */
function getFileType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return ext || "file";
}

/**
 * Collapsible directory component
 */
const DirectoryNode: React.FC<{
  node: FileTreeNode;
  selectedFile: string | null;
  onSelectFile: (fileName: string) => void;
  level: number;
}> = ({ node, selectedFile, onSelectFile, level }) => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="file-tree-node">
      <div
        className="file-tree-node-content"
        style={{ paddingLeft: `${level * 12}px` }}
      >
        <button
          className="file-tree-toggle"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "▼" : "▶"}
        </button>
        <span className="file-tree-icon">📁</span>
        <span className="file-tree-name">{node.name}</span>
      </div>
      {isExpanded && node.children && (
        <div className="file-tree-children">
          {node.children.map((child) => (
            <FileNode
              key={child.path}
              node={child}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * File or directory node component
 */
const FileNode: React.FC<{
  node: FileTreeNode;
  selectedFile: string | null;
  onSelectFile: (fileName: string) => void;
  level: number;
}> = ({ node, selectedFile, onSelectFile, level }) => {
  if (node.isDir) {
    return (
      <DirectoryNode
        node={node}
        selectedFile={selectedFile}
        onSelectFile={onSelectFile}
        level={level}
      />
    );
  }

  const isSelected = node.fileName === selectedFile;
  const fileType = getFileType(node.fileName || "");

  return (
    <div className="file-tree-node">
      <button
        className={`file-tree-file-button ${isSelected ? "selected" : ""}`}
        style={{ paddingLeft: `${level * 12 + 24}px` }}
        onClick={() => {
          if (node.fileName) {
            onSelectFile(node.fileName);
          }
        }}
      >
        <span className="file-tree-icon">
          {fileType === "ts" || fileType === "tsx"
            ? "Λ"
            : fileType === "js" || fileType === "jsx"
              ? "◎"
              : fileType === "rs"
                ? "🦀"
                : fileType === "py"
                  ? "🐍"
                  : fileType === "json"
                    ? "{ }"
                    : fileType === "css"
                      ? "🎨"
                      : "📄"}
        </span>
        <span className="file-tree-name">{node.name}</span>
        {node.fileStatus && (
          <span className={`file-tree-status file-tree-status-${node.fileStatus}`}>
            {node.fileStatus === "added" && "●"}
            {node.fileStatus === "modified" && "●"}
            {node.fileStatus === "deleted" && "✕"}
          </span>
        )}
      </button>
    </div>
  );
};

/**
 * FileTree component for collapsible file navigation
 */
export const FileTree: React.FC<FileTreeProps> = ({
  files,
  selectedFile,
  onSelectFile,
}) => {
  const tree = useMemo(() => buildFileTree(files), [files]);

  if (files.length === 0) {
    return (
      <div className="file-tree-container">
        <div className="file-tree-empty">No files to display</div>
      </div>
    );
  }

  return (
    <div className="file-tree-container">
      <div className="file-tree-header">Files Changed ({files.length})</div>
      <div className="file-tree-list">
        {tree.map((node) => (
          <FileNode
            key={node.path}
            node={node}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            level={0}
          />
        ))}
      </div>
    </div>
  );
};
