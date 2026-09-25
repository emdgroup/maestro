import { ChevronDown } from "lucide-react";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { AgentIcon } from "@/components/common/AgentIcon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DiscoveredAgent } from "@/types/bindings";

/** An agent the connection knows, or a stand-in for an id it no longer lists. */
export function agentFor(agents: DiscoveredAgent[], id: string): DiscoveredAgent {
  return agents.find((agent) => agent.id === id) ?? { id, name: id, icon: "" };
}

/**
 * Pick agents from a dropdown of checkboxes. `supported`, when given, disables the agents not in
 * it. `onSelectAll` adds an "All agents" item above the list; `actions` add closing items under
 * it, e.g. "Install".
 */
export function AgentsMenu({
  agents,
  selected,
  onToggle,
  supported,
  label,
  onSelectAll,
  actions,
  disabled,
  className,
}: {
  agents: DiscoveredAgent[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
  supported?: string[];
  label: string;
  onSelectAll?: () => void;
  actions?: { label: string; onSelect: () => void; disabled?: boolean }[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button variant="outline" size="sm" className={cn("h-7 gap-1 text-xs", className)} />
        }
      >
        {label}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-52">
        {onSelectAll && agents.length > 0 && (
          <>
            <DropdownMenuItem
              className="text-xs font-medium"
              closeOnClick={false}
              onClick={onSelectAll}
            >
              All agents
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {agents.length === 0 ? (
          // A plain paragraph: base-ui's group label throws outside a `Menu.Group`.
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No agents to choose from</p>
        ) : (
          agents.map((agent) => {
            const unsupported = supported !== undefined && !supported.includes(agent.id);
            return (
              <DropdownMenuCheckboxItem
                key={agent.id}
                className="text-xs"
                checked={selected.includes(agent.id)}
                onCheckedChange={(checked) => onToggle(agent.id, checked)}
                disabled={unsupported || disabled}
                closeOnClick={false}
              >
                <AgentIcon agent={agent} />
                <span className="truncate">{agent.name}</span>
                {unsupported && (
                  <span className="ml-auto text-[10px] text-muted-foreground">no skills</span>
                )}
              </DropdownMenuCheckboxItem>
            );
          })
        )}
        {actions && actions.length > 0 && <DropdownMenuSeparator />}
        {actions?.map((action) => (
          <DropdownMenuItem
            key={action.label}
            className="text-xs font-medium"
            disabled={action.disabled}
            onClick={action.onSelect}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Which agents have something, as overlapping icons, up to `max` and a `+N` beyond. Scales to any
 * number of agents where a chip per agent does not; the names are in the tooltip.
 */
export function AgentStack({
  agents,
  max = 5,
  empty = "No agents yet",
}: {
  agents: DiscoveredAgent[];
  max?: number;
  empty?: string;
}) {
  if (agents.length === 0)
    return <span className="text-[11px] text-muted-foreground">{empty}</span>;
  const shown = agents.slice(0, max);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={agents.map((agent) => agent.name).join(", ")}
            className="flex items-center gap-1.5"
          />
        }
      >
        <span className="flex -space-x-1">
          {shown.map((agent) => (
            <span
              key={agent.id}
              className="flex size-5 items-center justify-center rounded-full bg-muted ring-2 ring-card"
            >
              <AgentIcon agent={agent} />
            </span>
          ))}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {agents.length === 1 ? agents[0].name : `${agents.length} agents`}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {agents.map((agent) => agent.name).join(", ")}
      </TooltipContent>
    </Tooltip>
  );
}
