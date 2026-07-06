import { Bot, BotOff, Check } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { PILL, POPOVER_ITEM } from "./TogglePill";

export interface Agent {
  id: string;
  name: string;
  icon?: string | null;
}

interface AgentPickerProps {
  agentId: string | null;
  agents: Agent[];
  onChange?: (id: string | null) => void;
}

function AgentIcon({ agent }: { agent: Agent }) {
  if (hasBrandIcon(agent.id)) return <BrandIcon slug={agent.id} className="size-3 shrink-0" />;
  if (agent.icon)
    return <img src={agent.icon} className="size-3 shrink-0 dark:[filter:invert(1)]" alt="" />;
  return <Bot className="size-3 shrink-0 text-muted-foreground" />;
}

export function AgentPicker({ agentId, agents, onChange }: AgentPickerProps) {
  const selected = agents.find((a) => a.id === agentId) ?? null;
  const label = selected ? selected.name : "No agent";

  if (!onChange) {
    return (
      <span className={cn(PILL, "border-border text-muted-foreground cursor-default max-w-44")}>
        {selected ? <AgentIcon agent={selected} /> : <BotOff className="size-3 shrink-0" />}
        <span className="truncate">{label}</span>
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          PILL,
          "border-border bg-transparent text-muted-foreground hover:bg-muted max-w-44",
        )}
      >
        {selected ? <AgentIcon agent={selected} /> : <BotOff className="size-3 shrink-0" />}
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-1" align="start">
        <button type="button" className={POPOVER_ITEM} onClick={() => onChange(null)}>
          <BotOff className="size-3 text-muted-foreground shrink-0" />
          <span className="flex-1 text-left">No agent</span>
          {!agentId && <Check className="size-3 ml-auto shrink-0" />}
        </button>
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={POPOVER_ITEM}
            onClick={() => onChange(agent.id)}
          >
            <AgentIcon agent={agent} />
            <span className="truncate flex-1 text-left">{agent.name}</span>
            {agentId === agent.id && <Check className="size-3 shrink-0" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
