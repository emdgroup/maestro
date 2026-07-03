import { SubagentCard } from "@/components/execution/activity/SubagentCard";
import type { ToolCallItem } from "@/components/execution/activity/types";

interface SubagentsPanelProps {
  items: ToolCallItem[];
  toolCallMap: Map<string, ToolCallItem>;
}

export function SubagentsPanel({ items, toolCallMap }: SubagentsPanelProps) {
  if (items.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No subagents yet</p>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 overflow-y-auto custom-scrollbar p-3">
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <SubagentCard key={item.toolCallId} item={item} toolCallMap={toolCallMap} />
        ))}
      </div>
    </div>
  );
}
