import { useMemo, useState } from "react";
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  Search,
  X,
  RefreshCw,
  Folder,
  FolderOpen,
  File,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/ui/context-menu";
import { useListDirContents, useListWorkspaceFiles } from "@/services/connection.service";
import { ToolbarButton } from "./ToolbarButton";
import type { ConnectionKey } from "@/types/bindings";

/** The entry a menu action applies to, resolved to everything the mutation and dialog need. */
export interface FileTreeTarget {
  name: string;
  absolutePath: string;
  isDir: boolean;
  parentAbsolutePath: string;
  /**
   * Names beside this entry, when the listing is cached. Empty when the directory has never been
   * expanded — the dialog then skips its collision check and the backend does it instead.
   */
  siblings: string[];
}

export type FileTreeAction =
  | { type: "new-file"; parentAbsolutePath: string; siblings: string[] }
  | { type: "new-folder"; parentAbsolutePath: string; siblings: string[] }
  | { type: "rename"; target: FileTreeTarget }
  | { type: "delete"; target: FileTreeTarget };

interface LazyFileTreeProps {
  root: string;
  connection: ConnectionKey;
  selectedFile: string | null;
  onSelectFile: (relativePath: string) => void;
  expandedFolders: Set<string>;
  onExpandedFoldersChange: (folders: Set<string>) => void;
  showHidden?: boolean;
  className?: string;
  /** Omit to render a browse-only tree with no rename or delete affordances. */
  onAction?: (action: FileTreeAction) => void;
  /** Omit to leave the panel's one row to the filter field alone. */
  onRefresh?: () => void;
  /**
   * Folder the create actions target. `null` means the workspace root. Highlighted in the tree,
   * because a create destination the user cannot see is one they cannot trust.
   */
  selectedFolder?: string | null;
  onSelectFolder?: (absolutePath: string) => void;
}

interface MenuState {
  target: FileTreeTarget;
  x: number;
  y: number;
}

export function LazyFileTree({
  root,
  connection,
  selectedFile,
  onSelectFile,
  expandedFolders,
  onExpandedFoldersChange,
  showHidden = false,
  className,
  onAction,
  onRefresh,
  selectedFolder = null,
  onSelectFolder,
}: LazyFileTreeProps) {
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const { data: allFiles } = useListWorkspaceFiles(connection, root, showHidden);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const anchor = useMemo(() => {
    if (!menu) return undefined;
    const { x, y } = menu;
    return { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) };
  }, [menu]);

  // `AppContextMenu` listens for `contextmenu` on the document and suppresses the webview's own
  // menu everywhere. It classifies a plain tree row as "none" and shows nothing, so opening this
  // menu from the row's own handler does not collide with it. Anchoring a single menu to the
  // cursor, rather than wrapping every row in a trigger, is the same shape that component uses.
  const openMenu = onAction
    ? (event: React.MouseEvent, target: FileTreeTarget) => {
        event.preventDefault();
        // Right-clicking a folder points the header's create buttons at it too, so the highlight
        // never disagrees with what a create is about to do.
        if (target.isDir) onSelectFolder?.(target.absolutePath);
        setMenu({ target, x: event.clientX, y: event.clientY });
      }
    : undefined;

  return (
    <div className={cn("flex flex-col min-h-0 bg-card", className)}>
      {/* One row, following the review's file panel: a filter field sitting on the panel rather
          than a full-width bordered strip, which read as a second header under the real one. The
          create and visibility actions this row used to carry are in the tab's header now, beside
          the toggle that reveals this panel. */}
      <div className="flex items-center gap-1 px-2 py-2 shrink-0">
        <div className="flex-1 min-w-0 flex items-center gap-1.5 h-7 px-2 rounded-md border border-border bg-background focus-within:border-ring transition-colors">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files..."
            className="flex-1 min-w-0 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
          />
          {filter && (
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={() => setFilter("")}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="size-3" />
              </TooltipTrigger>
              <TooltipContent>Clear filter</TooltipContent>
            </Tooltip>
          )}
        </div>
        {onRefresh && (
          <ToolbarButton label="Refresh files" size="icon-xs" onClick={onRefresh}>
            <RefreshCw className="size-3" />
          </ToolbarButton>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {normalizedFilter ? (
          <FilterResults
            root={root}
            matches={(allFiles ?? []).filter((p) => p.toLowerCase().includes(normalizedFilter))}
            filter={filter.trim()}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            onOpenMenu={openMenu}
          />
        ) : (
          <DirContents
            absolutePath={root}
            relativePrefix=""
            depth={0}
            connection={connection}
            expandedFolders={expandedFolders}
            onExpandedFoldersChange={onExpandedFoldersChange}
            showHidden={showHidden}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            onOpenMenu={openMenu}
            selectedFolder={selectedFolder}
            onSelectFolder={onSelectFolder}
          />
        )}
      </div>

      {onAction && (
        <MenuPrimitive.Root
          open={menu !== null}
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <ContextMenuContent anchor={anchor}>
            {menu?.target.isDir && (
              <>
                <ContextMenuItem
                  onClick={() => {
                    onAction({
                      type: "new-file",
                      parentAbsolutePath: menu.target.absolutePath,
                      // Only an expanded folder has its children cached; an unexpanded one
                      // reports none and the backend is what refuses a collision.
                      siblings: [],
                    });
                    setMenu(null);
                  }}
                >
                  <FilePlus className="w-3.5 h-3.5" />
                  New file
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => {
                    onAction({
                      type: "new-folder",
                      parentAbsolutePath: menu.target.absolutePath,
                      siblings: [],
                    });
                    setMenu(null);
                  }}
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                  New folder
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            <ContextMenuItem
              onClick={() => {
                if (menu) onAction({ type: "rename", target: menu.target });
                setMenu(null);
              }}
            >
              <Pencil className="w-3.5 h-3.5" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onClick={() => {
                if (menu) onAction({ type: "delete", target: menu.target });
                setMenu(null);
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </MenuPrimitive.Root>
      )}
    </div>
  );
}

/** Where every row in this tree starts, matching `FileTree` in the Changes tab exactly. */
function indentFor(level: number): string {
  return `${level * 12 + 8}px`;
}

/** A row that says something about the tree rather than being part of it. */
function TreeNotice({ level = 0, children }: { level?: number; children: React.ReactNode }) {
  return (
    <div
      className="px-2 py-1.5 text-xs italic text-muted-foreground"
      style={{ paddingLeft: indentFor(level) }}
    >
      {children}
    </div>
  );
}

/**
 * The flat result of the filter field: paths, not a tree.
 *
 * There is no directory listing behind it, so the rows carry the whole relative path as their
 * tooltip and a rename or delete from here leaves the collision check to the backend.
 */
function FilterResults({
  root,
  matches,
  filter,
  selectedFile,
  onSelectFile,
  onOpenMenu,
}: {
  root: string;
  matches: string[];
  filter: string;
  selectedFile: string | null;
  onSelectFile: (relativePath: string) => void;
  onOpenMenu?: (event: React.MouseEvent, target: FileTreeTarget) => void;
}) {
  if (matches.length === 0) {
    return <TreeNotice>No files match “{filter}”</TreeNotice>;
  }

  return (
    <>
      {matches.map((relativePath) => {
        const name = relativePath.split("/").pop() ?? relativePath;
        const isSelected = relativePath === selectedFile;
        return (
          <Tooltip key={relativePath}>
            <TooltipTrigger
              type="button"
              onClick={() => onSelectFile(relativePath)}
              onContextMenu={(e) =>
                onOpenMenu?.(e, {
                  name,
                  absolutePath: `${root}/${relativePath}`,
                  isDir: false,
                  parentAbsolutePath: `${root}/${relativePath}`.replace(/\/[^/]+$/, ""),
                  siblings: [],
                })
              }
              className={cn(
                "w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-left border-l-2 transition-colors",
                isSelected
                  ? "border-ring selected-file-item text-foreground"
                  : "border-transparent text-foreground/80 file-tree-item hover:text-foreground",
              )}
              style={{ paddingLeft: indentFor(0) }}
            >
              <File className="size-3 shrink-0 text-muted-foreground" />
              <span className="font-mono truncate">{name}</span>
            </TooltipTrigger>
            <TooltipContent>{relativePath}</TooltipContent>
          </Tooltip>
        );
      })}
    </>
  );
}

interface DirContentsProps {
  absolutePath: string;
  relativePrefix: string;
  depth: number;
  connection: ConnectionKey;
  expandedFolders: Set<string>;
  onExpandedFoldersChange: (folders: Set<string>) => void;
  showHidden: boolean;
  selectedFile: string | null;
  onSelectFile: (relativePath: string) => void;
  onOpenMenu?: (event: React.MouseEvent, target: FileTreeTarget) => void;
  selectedFolder?: string | null;
  onSelectFolder?: (absolutePath: string) => void;
}

function DirContents({
  absolutePath,
  relativePrefix,
  depth,
  connection,
  expandedFolders,
  onExpandedFoldersChange,
  showHidden,
  selectedFile,
  onSelectFile,
  onOpenMenu,
  selectedFolder,
  onSelectFolder,
}: DirContentsProps) {
  const { data: entries, isLoading } = useListDirContents(connection, absolutePath, showHidden);
  const siblings = (entries ?? []).map((e) => e.name);

  if (isLoading) {
    return (
      <div className="flex items-center py-1.5" style={{ paddingLeft: indentFor(depth) }}>
        <Loader2 className="size-3 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // A directory with nothing in it used to render as nothing at all, so expanding it looked like
  // the click had missed. This row only ever appears under an expanded folder — the recursion that
  // reaches it is inside the `isExpanded` branch — so it never describes contents you cannot see.
  if (!entries?.length) {
    return (
      <TreeNotice level={depth}>
        {depth === 0 ? "Nothing in this workspace" : "Empty folder"}
      </TreeNotice>
    );
  }

  return (
    <>
      {entries.map((entry) => {
        const childAbsolute = `${absolutePath}/${entry.name}`;
        const childRelative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

        if (entry.is_dir) {
          const isExpanded = expandedFolders.has(childAbsolute);
          const isFolderSelected = selectedFolder === childAbsolute;
          return (
            <div key={entry.name}>
              <button
                type="button"
                onClick={() => {
                  const next = new Set(expandedFolders);
                  if (isExpanded) next.delete(childAbsolute);
                  else next.add(childAbsolute);
                  onExpandedFoldersChange(next);
                  // Expanding and selecting are the same gesture: the folder you just opened is
                  // the one you mean when you then press "New file".
                  onSelectFolder?.(childAbsolute);
                }}
                onContextMenu={(e) =>
                  onOpenMenu?.(e, {
                    name: entry.name,
                    absolutePath: childAbsolute,
                    isDir: true,
                    parentAbsolutePath: absolutePath,
                    siblings,
                  })
                }
                className={cn(
                  // The create target is a tint, not a rule down the side: `border-ring` is
                  // reserved for the file being viewed, and two rows wearing it at once gave no
                  // way to tell which highlight meant what.
                  "w-full flex items-center gap-1 px-2 py-1 text-xs text-left border-l-2 border-transparent transition-colors file-tree-item",
                  isFolderSelected
                    ? "text-foreground bg-muted/40"
                    : "text-muted-foreground hover:text-foreground",
                )}
                style={{ paddingLeft: indentFor(depth) }}
              >
                {isExpanded ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                {isExpanded ? (
                  <FolderOpen className="size-3 shrink-0" />
                ) : (
                  <Folder className="size-3 shrink-0" />
                )}
                <span className="font-mono truncate">{entry.name}</span>
              </button>
              {isExpanded && (
                <DirContents
                  absolutePath={childAbsolute}
                  relativePrefix={childRelative}
                  depth={depth + 1}
                  connection={connection}
                  expandedFolders={expandedFolders}
                  onExpandedFoldersChange={onExpandedFoldersChange}
                  showHidden={showHidden}
                  selectedFile={selectedFile}
                  onSelectFile={onSelectFile}
                  onOpenMenu={onOpenMenu}
                  selectedFolder={selectedFolder}
                  onSelectFolder={onSelectFolder}
                />
              )}
            </div>
          );
        }

        const isSelected = childRelative === selectedFile;
        return (
          <button
            key={entry.name}
            type="button"
            onClick={() => onSelectFile(childRelative)}
            onContextMenu={(e) =>
              onOpenMenu?.(e, {
                name: entry.name,
                absolutePath: childAbsolute,
                isDir: false,
                parentAbsolutePath: absolutePath,
                siblings,
              })
            }
            className={cn(
              "w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-left border-l-2 transition-colors",
              isSelected
                ? "border-ring selected-file-item text-foreground"
                : "border-transparent text-foreground/80 file-tree-item hover:text-foreground",
            )}
            style={{ paddingLeft: indentFor(depth) }}
          >
            <File className="size-3 shrink-0 text-muted-foreground" />
            <span className="font-mono truncate">{entry.name}</span>
          </button>
        );
      })}
    </>
  );
}
