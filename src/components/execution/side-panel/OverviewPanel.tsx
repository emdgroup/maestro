import { ChevronRight, Bot, SquarePlay, FileDiff, ScrollText, Paperclip } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import type { TabKind } from "./useSidePanelTabs";
import type { ToolCallItem } from "@/components/execution/activity/types";

interface OverviewPanelProps {
  subagentItems: ToolCallItem[];
  canvasCount: number;
  changedFilesCount: number;
  hasPlan: boolean;
  artifactFilesCount: number;
  onNavigate: (kind: TabKind) => void;
}

export function OverviewPanel({
  subagentItems,
  canvasCount,
  changedFilesCount,
  hasPlan,
  artifactFilesCount,
  onNavigate,
}: OverviewPanelProps) {
  const cards = [
    {
      kind: "subagents" as TabKind,
      label: "Subagents",
      icon: Bot,
      detail:
        subagentItems.length === 0
          ? "None"
          : `${subagentItems.filter((s) => s.status === "completed").length} / ${subagentItems.length} done`,
      available: subagentItems.length > 0,
    },
    {
      kind: "canvas" as TabKind,
      label: "Canvas",
      icon: SquarePlay,
      detail: canvasCount === 0 ? "None" : `${canvasCount} surface${canvasCount !== 1 ? "s" : ""}`,
      available: canvasCount > 0,
    },
    {
      kind: "review" as TabKind,
      label: "Changed files",
      icon: FileDiff,
      detail:
        changedFilesCount === 0
          ? "No changes"
          : `${changedFilesCount} file${changedFilesCount !== 1 ? "s" : ""}`,
      available: changedFilesCount > 0,
    },
    {
      kind: "plan" as TabKind,
      label: "Plan",
      icon: ScrollText,
      detail: hasPlan ? "Review pending" : "None",
      available: hasPlan,
    },
    {
      kind: "artifacts" as TabKind,
      label: "Artifacts",
      icon: Paperclip,
      detail:
        artifactFilesCount === 0
          ? "None"
          : `${artifactFilesCount} file${artifactFilesCount !== 1 ? "s" : ""}`,
      available: artifactFilesCount > 0,
    },
  ];

  return (
    <div className="absolute inset-0 overflow-y-auto custom-scrollbar p-3">
      <div className="flex flex-col gap-1.5">
        {cards.map(({ kind, label, icon: Icon, detail, available }) => (
          <button
            key={kind}
            type="button"
            onClick={() => available && onNavigate(kind)}
            disabled={!available}
            className={cn(
              "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left transition-colors border",
              available
                ? "border-border/50 hover:bg-muted/40 hover:border-border cursor-pointer"
                : "border-border/20 opacity-40 cursor-default",
            )}
          >
            <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 bg-muted/50">
              <Icon className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground">{label}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{detail}</div>
            </div>
            {available && (
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
