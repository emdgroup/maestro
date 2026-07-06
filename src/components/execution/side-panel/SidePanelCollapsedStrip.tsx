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
      <button
        type="button"
        onClick={() => onCollapsedChange(false)}
        className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        title="Expand panel"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <div className="w-5 h-px bg-border my-1" />
      {tabs.map(({ id, kind, label }) => {
        const Icon = KIND_ICON[kind];
        return (
          <button
            key={id}
            type="button"
            title={label}
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
          </button>
        );
      })}
      <div className="w-5 h-px bg-border my-1" />
      <Popover>
        <PopoverTrigger
          className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          title="Add tab"
        >
          <Plus className="w-4 h-4" />
        </PopoverTrigger>
        {addTabContent("left")}
      </Popover>
      {onMaximizedChange && (
        <button
          type="button"
          title="Maximize panel"
          onClick={() => {
            onMaximizedChange(true);
            onCollapsedChange(false);
          }}
          className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
