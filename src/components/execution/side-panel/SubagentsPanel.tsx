import { SubagentCard } from "@/components/execution/activity/SubagentCard";
import type { ToolCallItem } from "@/components/execution/activity/types";
import { Empty, EmptyDescription } from "@/ui/empty";
import { ScrollArea } from "@/ui/scroll-area";

interface SubagentsPanelProps {
  items: ToolCallItem[];
  toolCallMap: Map<string, ToolCallItem>;
}

export function SubagentsPanel({ items, toolCallMap }: SubagentsPanelProps) {
  if (items.length === 0) {
    return (
      <Empty className="absolute inset-0 rounded-none p-4">
        <EmptyDescription>No subagents yet</EmptyDescription>
      </Empty>
    );
  }

  return (
    <ScrollArea className="absolute inset-0">
      <div className="p-3 flex flex-col gap-2">
        {items.map((item) => (
          <SubagentCard key={item.toolCallId} item={item} toolCallMap={toolCallMap} />
        ))}
      </div>
    </ScrollArea>
  );
}
