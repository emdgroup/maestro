import { useEffect, useMemo, useRef, useState } from "react";
import { useDraggable } from "@dnd-kit/react";
import { Feedback } from "@dnd-kit/dom";
import { Columns2, Copy, ExternalLink, File, X } from "lucide-react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/path-utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/ui/context-menu";
import type { TabDragData } from "./file-tabs";

interface FileTabBarProps {
  side: number;
  tabs: string[];
  active: string | null;
  /** The side the tree opens files on, which is what the active tab's accent marks. */
  focused: boolean;
  dirty: ReadonlySet<string>;
  /** Where a tab being dragged over this row would land, for the insertion mark. */
  dropIndex: number | null;
  /** Whether a tab can go to the other side from here — see `canSplit`. */
  canMove: boolean;
  /** There are two sides, so moving goes to "the other side" rather than opens one. */
  split: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  /** Closes the tabs `close` picks, leaving unsaved ones open. */
  onCloseMany: (close: (path: string, index: number) => boolean) => void;
  onMove: (path: string) => void;
  onOpenExternally: (path: string) => void;
  fullPathOf: (path: string) => string;
}

/**
 * One side's row of open files. A tab is dragged to reorder it or to move it across; the panel
 * owns where it lands, this only says which tab is moving and draws the mark it is given.
 */
export function FileTabBar({
  side,
  tabs,
  active,
  focused,
  dirty,
  dropIndex,
  canMove,
  split,
  onActivate,
  onClose,
  onCloseMany,
  onMove,
  onOpenExternally,
  fullPathOf,
}: FileTabBarProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const anchor = useMemo(() => {
    if (!menu) return undefined;
    const { x, y } = menu;
    return { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) };
  }, [menu]);

  useEffect(() => {
    if (!active) return;
    rowRef.current
      ?.querySelector(`[data-file-tab="${CSS.escape(active)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const menuIndex = menu ? tabs.indexOf(menu.path) : -1;
  const act = (run: (path: string) => void) => () => {
    if (menu) run(menu.path);
    setMenu(null);
  };

  return (
    <div
      ref={rowRef}
      data-tab-row={side}
      className="flex items-center gap-0.5 flex-1 min-w-0 h-full overflow-x-auto scrollbar-none"
    >
      {tabs.map((path, index) => (
        <FileTab
          key={path}
          side={side}
          path={path}
          isActive={path === active}
          focused={focused}
          isDirty={dirty.has(path)}
          dropMark={
            dropIndex === index
              ? "before"
              : dropIndex === tabs.length && index === tabs.length - 1
                ? "after"
                : null
          }
          onActivate={() => onActivate(path)}
          onClose={() => onClose(path)}
          onOpenMenu={(e) => {
            e.preventDefault();
            setMenu({ path, x: e.clientX, y: e.clientY });
          }}
        />
      ))}

      <MenuPrimitive.Root
        open={menu !== null}
        onOpenChange={(open) => {
          if (!open) setMenu(null);
        }}
      >
        <ContextMenuContent anchor={anchor}>
          <ContextMenuItem onClick={act(onClose)}>
            <X className="size-3.5" />
            Close
            <ContextMenuShortcut>Ctrl+W</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={tabs.length < 2}
            onClick={act((path) => onCloseMany((p) => p !== path))}
          >
            Close others
          </ContextMenuItem>
          <ContextMenuItem
            disabled={menuIndex === tabs.length - 1}
            onClick={act(() => onCloseMany((_p, i) => i > menuIndex))}
          >
            Close to the right
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!canMove} onClick={act(onMove)}>
            <Columns2 className="size-3.5" />
            {split ? "Move to the other side" : "Move to the side"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={act((path) => {
              void navigator.clipboard.writeText(fullPathOf(path));
              toast.success("Path copied");
            })}
          >
            <Copy className="size-3.5" />
            Copy path
          </ContextMenuItem>
          <ContextMenuItem onClick={act(onOpenExternally)}>
            <ExternalLink className="size-3.5" />
            Open in default application
          </ContextMenuItem>
        </ContextMenuContent>
      </MenuPrimitive.Root>
    </div>
  );
}

// The original stays in the row, dimmed, while a copy follows the pointer: the row keeps its shape,
// so the insertion mark is measured against tabs that are not moving.
const TAB_FEEDBACK = [Feedback.configure({ feedback: "clone" })];

function FileTab({
  side,
  path,
  isActive,
  focused,
  isDirty,
  dropMark,
  onActivate,
  onClose,
  onOpenMenu,
}: {
  side: number;
  path: string;
  isActive: boolean;
  focused: boolean;
  isDirty: boolean;
  dropMark: "before" | "after" | null;
  onActivate: () => void;
  onClose: () => void;
  onOpenMenu: (e: React.MouseEvent) => void;
}) {
  const { ref, isDragging } = useDraggable<TabDragData>({
    id: path,
    type: "file-tab",
    data: { side, path },
    plugins: TAB_FEEDBACK,
  });
  const name = basename(path);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            ref={ref}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            data-file-tab={path}
            onClick={onActivate}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate();
              }
            }}
            // A middle click closes, as it does on every other tab strip.
            onAuxClick={(e) => {
              if (e.button === 1) onClose();
            }}
            onContextMenu={onOpenMenu}
            className={cn(
              "group/tab relative flex items-center gap-1.5 h-7 pl-2.5 pr-1 shrink-0 rounded-[9px] border border-transparent text-xs whitespace-nowrap cursor-default select-none transition-colors",
              isActive
                ? focused
                  ? "text-foreground bg-accent/13 border-accent/40"
                  : "text-foreground bg-foreground/8"
                : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
              isDragging && "opacity-40",
              dropMark === "before" && "shadow-[-3px_0_0_-1px_var(--accent)]",
              dropMark === "after" && "shadow-[3px_0_0_-1px_var(--accent)]",
            )}
          />
        }
      >
        <File className="size-3 shrink-0 text-accent/70" />
        <span className="font-mono">{name}</span>
        <button
          type="button"
          tabIndex={-1}
          aria-label={isDirty ? `Close ${name}, which has unsaved changes` : `Close ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "size-4.5 inline-flex items-center justify-center rounded-[5px] text-muted-foreground hover:text-foreground hover:bg-foreground/12",
            isActive || isDirty ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
          )}
        >
          {/* An unsaved tab wears a dot where its X goes, and shows the X on hover. */}
          {isDirty && <span className="size-[7px] rounded-full bg-accent group-hover/tab:hidden" />}
          <X className={cn("size-3", isDirty && "hidden group-hover/tab:block")} />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-md break-all">{path}</TooltipContent>
    </Tooltip>
  );
}
