import { useController } from "react-hook-form";
import type { Control } from "react-hook-form";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { Label } from "@/ui/label";
import { Switch } from "@/ui/switch";
import { Button } from "@/ui/button";
import { Bot, RotateCcw, LogIn, LogOut, CheckCircle, Loader2 } from "lucide-react";
import type { ConnectionKey, DiscoveredAgent } from "@/types/bindings";
import { useAgentAuthInfoQuery, useAcpLogoutMutation } from "@/services/acp-auth.service";
import { AgentAuthModal } from "@/components/common/AgentAuthModal";
import { useState } from "react";

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
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);

  const hasAuth = authInfo && authInfo.authMethods.length > 0;

  return (
    <>
      <div className="flex items-center gap-2 py-2 px-3 rounded-lg border border-border bg-muted/20 hover:bg-muted/40 transition-colors">
        <div className="shrink-0">
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
        </div>

        <span className="flex-1 text-sm font-medium truncate">{agent.name}</span>

        {isDefault ? (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
            Default
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] px-2 text-muted-foreground hover:text-foreground"
            onClick={onSetDefault}
          >
            Set default
          </Button>
        )}

        {hasAuth && !authInfo.authenticated && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] px-2 text-warning hover:text-warning hover:bg-warning/10"
            onClick={() => setIsAuthModalOpen(true)}
          >
            <LogIn className="w-3 h-3" />
            Login
          </Button>
        )}

        {hasAuth && authInfo.authenticated && (
          <div className="flex items-center gap-1">
            <span className="flex items-center gap-1 text-[10px] text-success">
              <CheckCircle className="w-3 h-3" />
              Logged in
            </span>
            {authInfo.supportsLogout && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] px-2 text-muted-foreground"
                disabled={logout.isPending}
                onClick={() => logout.mutate({ agentId: agent.id, connection })}
              >
                {logout.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <LogOut className="w-3 h-3" />
                )}
                Logout
              </Button>
            )}
          </div>
        )}
      </div>

      {hasAuth && (
        <AgentAuthModal
          agentId={agent.id}
          agentName={agent.name}
          connection={connection}
          open={isAuthModalOpen}
          onAuthSuccess={() => setIsAuthModalOpen(false)}
          onClose={() => setIsAuthModalOpen(false)}
        />
      )}
    </>
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
