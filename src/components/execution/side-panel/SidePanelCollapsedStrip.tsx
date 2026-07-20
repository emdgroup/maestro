import {
  LayoutDashboard,
  Bot,
  SquarePlay,
  FileDiff,
  ScrollText,
  Paperclip,
  FileText,
  Terminal,
  ChevronLeft,
  Maximize2,
  Plus,
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

interface SidePanelCollapsedStripProps {
  tabs: SidePanelTab[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  onCollapsedChange: (c: boolean) => void;
  onMaximizedChange?: (v: boolean) => void;
  addTabContent: (side: "bottom" | "left") => React.ReactNode;
}

export function SidePanelCollapsedStrip({
  tabs,
  activeTabId,
  onTabChange,
  onCollapsedChange,
  onMaximizedChange,
  addTabContent,
}: SidePanelCollapsedStripProps) {
  return (
    <div className="flex flex-col items-center py-2 gap-1">
      <Tooltip>
        <TooltipTrigger
          type="button"
          onClick={() => onCollapsedChange(false)}
          className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </TooltipTrigger>
        <TooltipContent>Expand panel</TooltipContent>
      </Tooltip>
      <div className="w-5 h-px bg-border my-1" />
      {tabs.map(({ id, kind, label }) => {
        const Icon = KIND_ICON[kind];
        return (
          <Tooltip key={id}>
            <TooltipTrigger
              type="button"
              onClick={() => {
                onTabChange(id);
                onCollapsedChange(false);
              }}
              className={cn(
                "p-2 rounded-md transition-colors",
                activeTabId === id
                  ? "text-foreground bg-muted/60"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
            >
              <Icon className="w-4 h-4" />
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
      <div className="w-5 h-px bg-border my-1" />
      <Popover>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors" />
            }
          >
            <Plus className="w-4 h-4" />
          </TooltipTrigger>
          <TooltipContent>Add tab</TooltipContent>
        </Tooltip>
        {addTabContent("left")}
      </Popover>
      {onMaximizedChange && (
        <Tooltip>
          <TooltipTrigger
            type="button"
            onClick={() => {
              onMaximizedChange(true);
              onCollapsedChange(false);
            }}
            className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <Maximize2 className="w-4 h-4" />
          </TooltipTrigger>
          <TooltipContent>Maximize panel</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
