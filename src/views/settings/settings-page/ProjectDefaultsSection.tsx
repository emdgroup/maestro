import { useController } from "react-hook-form";
import type { Control } from "react-hook-form";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { Label } from "@/ui/label";
import { Switch } from "@/ui/switch";
import { Button } from "@/ui/button";
import { Bot, RotateCcw, LogOut, Loader2, Check } from "lucide-react";
import type { ConnectionKey, DiscoveredAgent } from "@/types/bindings";
import { useAgentAuthInfoQuery, useAcpLogoutMutation } from "@/services/acp-auth.service";
import { cn } from "@/lib/utils";

export interface ProjectSettingsFormData {
  default_agent: string;
  reopen_sessions: boolean;
  startup_tab: string;
}

interface ProjectDefaultsSectionProps {
  control: Control<ProjectSettingsFormData>;
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
        "group flex items-center gap-2 py-2 px-3 rounded-lg border border-border bg-muted/20 transition-colors",
        isDefault ? "cursor-default" : "cursor-pointer hover:bg-muted/40 hover:border-primary/20",
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

      {isDefault && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
    </div>
  );
}

export function ProjectDefaultsSection({
  control,
  agents,
  agentsLoading,
  connection,
}: ProjectDefaultsSectionProps) {
  const { field: defaultAgentField } = useController({ control, name: "default_agent" });
  const { field: reopenSessionsField } = useController({ control, name: "reopen_sessions" });

  return (
    <>
      <div className="bg-card border border-border rounded-lg p-4 space-y-4">
        <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
          <Bot className="w-4 h-4 text-muted-foreground" />
          Available Agents
        </h3>

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
                isDefault={defaultAgentField.value === agent.id}
                onSetDefault={() => defaultAgentField.onChange(agent.id)}
                connection={connection}
              />
            ))}
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-sm font-medium">Default Agent</Label>
          <p className="text-xs text-muted-foreground">
            {defaultAgentField.value
              ? `${agents.find((a) => a.id === defaultAgentField.value)?.name ?? defaultAgentField.value} is used for new sessions and auto-assigned tasks`
              : "No default set — tasks use the session's own agent"}
          </p>
        </div>
      </div>

      {/* Startup Behavior Card */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-4">
        <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
          <RotateCcw className="w-4 h-4 text-muted-foreground" />
          Startup
        </h3>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">Reopen Previous Sessions</Label>
            <p className="text-xs text-muted-foreground">
              Automatically restore agent sessions from your last session
            </p>
          </div>
          <Switch
            checked={reopenSessionsField.value}
            onCheckedChange={reopenSessionsField.onChange}
            className="data-unchecked:bg-muted data-unchecked:border-border/50"
          />
        </div>
      </div>
    </>
  );
}
