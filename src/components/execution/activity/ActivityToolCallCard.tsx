import { useState, useEffect } from "react";
import { FileText, Terminal, Search, Box } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/ui/collapsible";
import type { ToolCallItem, ToolCallContent } from "./types";

const TOOL_ICONS: Record<string, React.ElementType> = {
  read_file: FileText,
  write_file: FileText,
  run_terminal: Terminal,
  search: Search,
  other: Box,
};

const STATUS_BADGE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  in_progress: "default",
  completed: "secondary",
  error: "destructive",
};

const STATUS_BADGE_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "Done",
  error: "Failed",
};

interface ActivityToolCallCardProps {
  toolCall: ToolCallItem;
}

export function ActivityToolCallCard({ toolCall }: ActivityToolCallCardProps) {
  const [open, setOpen] = useState(true);
  const Icon = TOOL_ICONS[toolCall.kind] ?? TOOL_ICONS.other;

  // Collapse after completion (open by default while running, collapses after completion)
  useEffect(() => {
    if (toolCall.status === "completed" || toolCall.status === "error") {
      setOpen(false);
    }
  }, [toolCall.status]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full px-3 py-2 rounded-md border border-border bg-card hover:bg-muted/50 transition-colors cursor-pointer text-left">
        <Icon className="w-4 h-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium truncate flex-1">{toolCall.title}</span>
        <Badge variant={STATUS_BADGE_VARIANT[toolCall.status] ?? "outline"} className="text-[10px] px-1.5 py-0">
          {STATUS_BADGE_LABEL[toolCall.status] ?? toolCall.status}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ml-6 p-2 border-l-2 border-border space-y-1">
          {toolCall.content.length === 0 && (
            <span className="text-xs text-muted-foreground italic">No content yet</span>
          )}
          {toolCall.content.map((c, i) => (
            <ToolCallContentBlock key={i} content={c} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCallContentBlock({ content }: { content: ToolCallContent }) {
  switch (content.type) {
    case "content":
      return (
        <pre className="text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
          {content.content.text}
        </pre>
      );
    case "diff":
      return (
        <div className="text-xs">
          <div className="font-mono text-muted-foreground mb-1">{content.path}</div>
          <pre className="bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
            {content.newText}
          </pre>
        </div>
      );
    case "terminal":
      return (
        <span className="text-xs text-muted-foreground italic">Terminal: {content.terminalId}</span>
      );
    default:
      return null;
  }
}
