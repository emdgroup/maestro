import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { Label } from "@/ui/label";
import { Button } from "@/ui/button";
import { Bot, Check, GitBranch, Loader2, LogOut } from "lucide-react";
import { WorkspaceModeSelect } from "@/components/common/workspace-mode/WorkspaceModeSelect";
import type {
  ConnectionKey,
  DiscoveredAgent,
  ProjectConfigRequest,
  WorkspaceMode,
} from "@/types/bindings";
import { useAgentAuthInfoQuery, useAcpLogoutMutation } from "@/services/acp-auth.service";
import { useIsGitRepo } from "@/store/projectStore";
import { cn } from "@/lib/utils";

interface ProjectDefaultsSectionProps {
  defaultAgent: string | null;
  defaultWorkspaceMode: WorkspaceMode;
  /** Persists immediately — this section has no Save button behind it. */
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
  defaultAgent,
  defaultWorkspaceMode,
  onChange,
  agents,
  agentsLoading,
  connection,
}: ProjectDefaultsSectionProps) {
  const isGitRepo = useIsGitRepo();

  return (
    <>
      {/* The list is per connection and the default it sets is per project. They were split
          apart for a while and it made both worse: picking a default meant crossing to another
          page to read the list it comes from. The sentence below carries the distinction
          instead. */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
            <Bot className="w-4 h-4 text-muted-foreground" />
            Agents &amp; sign-in
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Agents installed on this project&apos;s connection, and whether you are signed in to
            each. Click one to make it this project&apos;s default.
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

        <div className="space-y-1">
          <Label className="text-sm font-medium">Default Agent</Label>
          <p className="text-xs text-muted-foreground">
            {defaultAgent
              ? `${agents.find((a) => a.id === defaultAgent)?.name ?? defaultAgent} is used for new sessions and auto-assigned tasks`
              : "No default set — tasks use the session's own agent"}
          </p>
        </div>
      </div>

      {/* A non-git project cannot have worktrees at all, so the choice does not exist there. */}
      {isGitRepo && (
        <div className="bg-card border border-border rounded-lg p-4 space-y-4">
          <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-muted-foreground" />
            Workspace
          </h3>

          <div className="space-y-2">
            <div className="min-w-0">
              <Label htmlFor="default-workspace" className="text-sm font-medium text-foreground">
                Default workspace
              </Label>
              <div className="text-xs text-muted-foreground">
                Where new tasks and new sessions start out. Reusing an existing workspace is not
                offered here — a default cannot name one — but it is still available per task and
                per session.
              </div>
            </div>
            <WorkspaceModeSelect
              id="default-workspace"
              value={defaultWorkspaceMode}
              onChange={(mode) => onChange({ default_workspace_mode: mode })}
              allowReuse={false}
            />
          </div>
        </div>
      )}
    </>
  );
}
