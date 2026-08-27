import type { DiffFileWithName } from "@/types/review";

export interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNode[];
  fileStatus?: "A" | "M" | "D";
  fileName?: string;
}

/**
 * Build a hierarchical file tree from a flat file list, directories before files and each level
 * sorted by name.
 *
 * Pure and separate from `FileTree.tsx` so that `treeFileOrder` — which the diff stack sorts by —
 * is guaranteed to walk the very same structure the sidebar renders, and can be tested without
 * mounting a component.
 */
export function buildFileTree(files: DiffFileWithName[]): FileTreeNode[] {
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

  return sortNode(rootChildren);
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

/** Collect all leaf file names under a node, recursively. */
export function getDescendantFiles(node: FileTreeNode): string[] {
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
 * File names in the order the tree renders them — a depth-first walk of `buildFileTree`.
 *
 * The diff stack sorts its cards by this so scrolling the stack and reading the tree agree on
 * what comes next. Deriving it from the same builder is what keeps them from drifting apart.
 */
export function treeFileOrder(files: DiffFileWithName[]): string[] {
  const order: string[] = [];
  const walk = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.isDir) walk(node.children ?? []);
      else if (node.fileName) order.push(node.fileName);
    }
  };
  walk(buildFileTree(files));
  return order;
}
