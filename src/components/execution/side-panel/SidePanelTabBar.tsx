import { motion } from "framer-motion";
import {
  LayoutDashboard,
  Bot,
  SquarePlay,
  FileDiff,
  ScrollText,
  Paperclip,
  FileText,
  Terminal,
  ChevronRight,
  Maximize2,
  Minimize2,
  Plus,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Popover, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import type { SidePanelTab, TabKind } from "./useSidePanelTabs";

const KIND_ICON: Record<TabKind, React.ElementType> = {
  overview: LayoutDashboard,
  plan: ScrollText,
  subagents: Bot,
  canvas: SquarePlay,
  review: FileDiff,
  artifacts: Paperclip,
  files: FileText,
  terminal: Terminal,
};

interface SidePanelTabBarProps {
  tabs: SidePanelTab[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  onTabClose: (id: string) => void;
  onCollapsedChange: (c: boolean) => void;
  onMaximizedChange?: (v: boolean) => void;
  maximized: boolean;
  addTabContent: (side: "bottom" | "left") => React.ReactNode;
}

export function SidePanelTabBar({
  tabs,
  activeTabId,
  onTabChange,
  onTabClose,
  onCollapsedChange,
  onMaximizedChange,
  maximized,
  addTabContent,
}: SidePanelTabBarProps) {
  return (
    <div className="flex items-center border-b border-border shrink-0 bg-card px-2 py-1.5 gap-2">
      {!maximized && (
        <Tooltip>
          <TooltipTrigger
            type="button"
            onClick={() => onCollapsedChange(true)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
          >
            <ChevronRight className="w-4 h-4" />
          </TooltipTrigger>
          <TooltipContent>Collapse panel</TooltipContent>
        </Tooltip>
      )}
      <div className="flex items-center bg-muted rounded-lg p-0.75 gap-1 flex-1 overflow-x-auto scrollbar-none min-w-0">
        {tabs.map(({ id, kind, label, closeable }) => {
          const Icon = KIND_ICON[kind];
          const isActive = activeTabId === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              className={cn(
                "relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors shrink-0 z-10",
                isActive
                  ? "text-accent hover:bg-transparent"
                  : "text-muted-foreground hover:bg-background/50",
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="side-panel-tab-pill"
                  className="absolute inset-0 rounded-md bg-background shadow-sm"
                  transition={{ type: "spring", stiffness: 400, damping: 35 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5" />
                {label}
              </span>
              {closeable && (
                <span
                  role="button"
                  tabIndex={-1}
                  onKeyDown={(e) => e.key === "Enter" && onTabClose(id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(id);
                  }}
                  className={cn(
                    "relative z-10 ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded hover:bg-muted transition-colors",
                    isActive ? "opacity-50 hover:opacity-100" : "opacity-20 hover:opacity-60",
                  )}
                >
                  <X className="w-2.5 h-2.5" />
                </span>
              )}
            </button>
          );
        })}
        <Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors shrink-0" />
              }
            >
              <Plus className="w-3.5 h-3.5" />
            </TooltipTrigger>
            <TooltipContent>Add tab</TooltipContent>
          </Tooltip>
          {addTabContent("bottom")}
        </Popover>
      </div>
      {onMaximizedChange && (
        <Tooltip>
          <TooltipTrigger
            type="button"
            onClick={() => onMaximizedChange(!maximized)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
          >
            {maximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </TooltipTrigger>
          <TooltipContent>{maximized ? "Restore panel" : "Maximize panel"}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
