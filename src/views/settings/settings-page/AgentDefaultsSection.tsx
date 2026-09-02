import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { Label } from "@/ui/label";
import { Button } from "@/ui/button";
import { Bot, Check, Loader2, LogOut } from "lucide-react";
import type { ConnectionKey, DiscoveredAgent, ProjectConfigRequest } from "@/types/bindings";
import { useAgentAuthInfoQuery, useAcpLogoutMutation } from "@/services/acp-auth.service";
import { cn } from "@/lib/utils";

interface AgentDefaultsSectionProps {
  defaultAgent: string | null;
  /** Persists immediately, this section has no Save button behind it. */
  onChange: (patch: Partial<ProjectConfigRequest>) => void;
  agents: DiscoveredAgent[];
  agentsLoading: boolean;
  connection: ConnectionKey;
}

interface AgentAuthRowProps {
  agent: DiscoveredAgent;
  isDefault: boolean;
  onSetDefault: () => void;
  connection: ConnectionKey;
}

function AgentAuthRow({ agent, isDefault, onSetDefault, connection }: AgentAuthRowProps) {
  const { data: authInfo } = useAgentAuthInfoQuery(agent.id, connection);
  const logout = useAcpLogoutMutation();

  const isAuthenticated = authInfo?.authenticated ?? false;
  const supportsLogout = authInfo?.supportsLogout ?? false;

  return (
    <div
      className={cn(
        "group flex items-center gap-2 py-2 px-3 rounded-lg border transition-colors",
        // The same accent treatment `AgentProfilesSection`'s default profile card uses, so the two
        // cards on this page mark "this is the one in force" the same way.
        isDefault
          ? "cursor-default border-accent/60 bg-accent/5"
          : "cursor-pointer border-border bg-muted/20 hover:bg-muted/40 hover:border-accent/20",
      )}
      onClick={() => {
        if (!isDefault) onSetDefault();
      }}
    >
      <div className="relative shrink-0">
        {hasBrandIcon(agent.id) ? (
          <BrandIcon slug={agent.id} className="w-5 h-5" />
        ) : agent.icon ? (
          <img
            src={agent.icon}
            className="w-5 h-5 rounded-sm dark:filter-[invert(1)]"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
            alt={agent.name}
          />
        ) : (
          <Bot className="w-5 h-5 text-muted-foreground" />
        )}
        {isAuthenticated && (
          <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-success border-2 border-card" />
        )}
      </div>

      <span className="flex-1 text-sm font-medium truncate">{agent.name}</span>

      {!isDefault && (
        <span className="text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          Click to set as default
        </span>
      )}

      {isAuthenticated && supportsLogout && (
        <Button
          variant="outline"
          size="sm"
          className="opacity-0 group-hover:opacity-100 h-6 text-[11px] px-2 text-destructive border-destructive/40 hover:bg-destructive/10 hover:border-destructive/70 hover:text-destructive transition-opacity"
          disabled={logout.isPending}
          onClick={(e) => {
            e.stopPropagation();
            logout.mutate({ agentId: agent.id, connection });
          }}
        >
          {logout.isPending ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <LogOut className="w-3 h-3" />
          )}
          Logout
        </Button>
      )}

      {isDefault && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
    </div>
  );
}

/**
 * The agents installed on this project's connection, and which one is its default.
 *
 * The list is per connection and the default it sets is per project. They were split apart for a
 * while and it made both worse: picking a default meant crossing to another page to read the list
 * it comes from. The sentence below carries the distinction instead.
 */
export function AgentDefaultsSection({
  defaultAgent,
  onChange,
  agents,
  agentsLoading,
  connection,
}: AgentDefaultsSectionProps) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
          <Bot className="w-4 h-4 text-muted-foreground" />
          Agents &amp; sign-in
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Agents installed on this project&apos;s connection, and whether you are signed in to each.
          Click one to make it this project&apos;s default.
        </p>
      </div>

      {agentsLoading ? (
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      ) : agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agents found. Install an agent (e.g. Claude Code, Goose) and restart.
        </p>
      ) : (
        <div className="space-y-1.5">
          {agents.map((agent) => (
            <AgentAuthRow
              key={agent.id}
              agent={agent}
              isDefault={defaultAgent === agent.id}
              onSetDefault={() => onChange({ default_agent: agent.id })}
              connection={connection}
            />
          ))}
        </div>
      )}

      {/* Says what the default actually decides, which is more than its name suggests: it is the
          agent every stage falls back to when no profile names one, so on a project with no
          profiles at all it is the agent that runs everything. The empty case used to claim tasks
          would "use the session's own agent" — they have none, and could not start. */}
      <div className="space-y-1">
        <Label className="text-sm font-medium">Default Agent</Label>
        <p className="text-xs text-muted-foreground">
          {defaultAgent
            ? `${agents.find((a) => a.id === defaultAgent)?.name ?? defaultAgent} runs new sessions, and any task stage with no profile of its own.`
            : "No agent is installed on this project's connection, so no task can start here."}
        </p>
      </div>
    </div>
  );
}
