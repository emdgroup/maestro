import { useState } from "react";
import { Users } from "lucide-react";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";
import { AgentIcon } from "@/components/common/AgentIcon";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import type { DiscoveredAgent } from "@/types/bindings";

/**
 * Stands for every agent, those installed later included, in a skill's or MCP server's agent list.
 * `maestro_protocol::ALL_AGENTS`.
 */
export const ALL_AGENTS = "*";

/** An agent the connection knows, or a stand-in for an id it no longer lists. */
export function agentFor(agents: DiscoveredAgent[], id: string): DiscoveredAgent {
  return agents.find((agent) => agent.id === id) ?? { id, name: id, icon: "" };
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

/**
 * The agents a card's skill or server reaches: "All agents", or their icons. With `onClick` it is
 * the button that opens the agents dialog.
 */
export function AgentsSummary({
  agents,
  ids,
  empty,
  onClick,
  disabled,
}: {
  agents: DiscoveredAgent[];
  ids: string[];
  empty?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const summary = ids.includes(ALL_AGENTS) ? (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Users className="size-3.5" />
      All agents
    </span>
  ) : (
    <AgentStack agents={ids.map((id) => agentFor(agents, id))} empty={empty} />
  );
  if (!onClick) return summary;
  return (
    <button
      type="button"
      aria-label="Choose agents"
      disabled={disabled}
      onClick={onClick}
      className="-mx-1.5 -my-0.5 rounded-md px-1.5 py-0.5 hover:bg-muted disabled:opacity-50 [&_span]:hover:text-foreground"
    >
      {summary}
    </button>
  );
}

/** A segment of a joined `ToggleGroup`: dimmed until pressed. */
export const SEGMENT =
  "px-3 text-xs font-normal text-muted-foreground aria-pressed:font-medium aria-pressed:text-foreground";

/** A single choice out of a few, drawn as joined `SEGMENT`s. */
export function Segmented({
  label,
  value,
  options,
  onChange,
  size = "sm",
  className,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  size?: "sm" | "xs";
  className?: string;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(values) => {
        const next = values.find((option) => option !== value);
        if (next) onChange(next);
      }}
      variant="outline"
      spacing={0}
      className={className}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          size="sm"
          className={cn(SEGMENT, size === "xs" && "h-6 px-2 text-[11px]")}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * Which agents get a skill or MCP server. "Every agent" is `[ALL_AGENTS]`, which reaches the agents
 * installed later too; unticking one agent out of it leaves every other one ticked, by name.
 * `supported`, when given, disables the agents not in it.
 */
export function AgentsDialog({
  open,
  onOpenChange,
  name,
  agents,
  value,
  supported,
  confirmLabel,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  agents: DiscoveredAgent[];
  value: string[];
  supported?: string[];
  confirmLabel: string;
  pending?: boolean;
  onConfirm: (value: string[]) => void;
}) {
  const [picked, setPicked] = useState(value);
  // Reset on every opening, during render rather than from an effect.
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setPicked(value);
  }

  const all = picked.includes(ALL_AGENTS);
  const usable = (agent: DiscoveredAgent) =>
    supported === undefined || supported.includes(agent.id);
  const toggle = (id: string, on: boolean) =>
    setPicked(
      on
        ? [...picked, id]
        : (all ? agents.filter(usable).map((agent) => agent.id) : picked).filter(
            (kept) => kept !== id,
          ),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-4 p-5 sm:max-w-sm">
        <div className="space-y-1">
          <DialogTitle className="text-sm">Agents</DialogTitle>
          <DialogDescription className="text-xs">
            Which agents on this connection get <span className="font-mono">{name}</span>.
          </DialogDescription>
        </div>
        <div className="-mx-2 space-y-0.5">
          <label className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/60">
            <Checkbox
              checked={all}
              onCheckedChange={(checked) => setPicked(checked ? [ALL_AGENTS] : [])}
            />
            <span className="flex size-5 items-center justify-center">
              <Users className="size-4 text-muted-foreground" />
            </span>
            <span className="text-xs font-medium">Every agent</span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              including ones installed later
            </span>
          </label>
          <div className="mx-2 my-1 border-t border-border" />
          {agents.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No agents on this connection
            </p>
          )}
          {agents.map((agent) => (
            <label
              key={agent.id}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/60 has-disabled:opacity-45 has-disabled:hover:bg-transparent"
            >
              <Checkbox
                checked={usable(agent) && (all || picked.includes(agent.id))}
                disabled={!usable(agent)}
                onCheckedChange={(checked) => toggle(agent.id, checked === true)}
              />
              <span className="flex size-5 items-center justify-center rounded-full bg-muted">
                <AgentIcon agent={agent} />
              </span>
              <span className="truncate text-xs">{agent.name}</span>
              {!usable(agent) && (
                <span className="ml-auto text-[10px] text-muted-foreground">no skills</span>
              )}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="accent" disabled={pending} onClick={() => onConfirm(picked)}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
