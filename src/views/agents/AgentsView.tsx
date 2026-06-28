import { useState, useRef, useEffect } from "react";
import { useShortcuts } from "@/utils/hooks/useShortcuts";
import { cn } from "@/lib/ui-utils";
import { AgentMonitor } from "@/components/execution/agent-monitor/AgentMonitor";
import { SessionHistoryPanel } from "@/components/execution/session-history/SessionHistoryPanel";
import { SpawnSessionDialog } from "@/components/execution/spawn-session-dialog/SpawnSessionDialog";
import { usePendingAgentId, useNavigationActions } from "@/store/navigationStore";
import {
  useActiveSessionsQuery,
  useSpawnInteractiveExecutionMutation,
  useAgentDiscoveryQuery,
  useCancelActiveSessionMutation,
} from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useSettings, useSaveSettings } from "@/services/settings.service";
import type { ActiveSessionInfo, ConnectionKey } from "@/types/bindings";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { History, Plus, SearchIcon, Settings2 } from "lucide-react";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import type { ActivityVisibility } from "@/types/bindings";

interface AgentsViewProps {
  projectId?: number;
  repoPath?: string;
  connection: ConnectionKey;
}

export const AgentsView: React.FC<AgentsViewProps> = ({ projectId, repoPath, connection }) => {
  const { data: sessions = [] } = useActiveSessionsQuery(projectId);
  const pendingAgentId = usePendingAgentId();
  const { clearPendingAgent } = useNavigationActions();
  const [selectedSessionKey, setSelectedSessionKey] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showSpawnDialog, setShowSpawnDialog] = useState(false);
  const [lastSpawnedKey, setLastSpawnedKey] = useState<number | null>(null);

  const { data: settings } = useSettings();
  const saveSettings = useSaveSettings({ successToast: false });

  const thinkingVisibility = settings?.thinking_visibility ?? "auto";
  const toolCallVisibility = settings?.tool_call_visibility ?? "auto";
  const isCompact = settings?.agent_stream_width === "compact";

  function handleThinkingVisibilityChange(value: ActivityVisibility | null) {
    if (!settings || !value) return;
    saveSettings.mutate({
      ...settings,
      thinking_visibility: value,
      updated_at: new Date().toISOString(),
    });
  }

  function handleToolCallVisibilityChange(value: ActivityVisibility | null) {
    if (!settings || !value) return;
    saveSettings.mutate({
      ...settings,
      tool_call_visibility: value,
      updated_at: new Date().toISOString(),
    });
  }

  function handleCompactToggle(checked: boolean) {
    if (!settings) return;
    saveSettings.mutate({
      ...settings,
      agent_stream_width: checked ? "compact" : "full",
      updated_at: new Date().toISOString(),
    });
  }

  const { data: worktrees = [] } = useWorktreesQuery(projectId, repoPath);
  const { data: discovery } = useAgentDiscoveryQuery(connection);

  useShortcuts("agents", {
    "agents-new": () => setShowSpawnDialog(true),
    "focus-search": () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
    "agents-history": () => {
      if ((discovery?.agents?.length ?? 0) > 0) setShowHistory((v) => !v);
    },
    "agents-close": () => {
      const session = sessions.find((s) => s.session_key === selectedSessionKey);
      if (session) handleCloseSession(session);
    },
  });
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const cancelMutation = useCancelActiveSessionMutation();

  const visibleAgents = discovery?.agents ?? [];
  const agentIcons: Record<string, string> = Object.fromEntries(
    visibleAgents.filter((a) => a.icon).map((a) => [a.id, a.icon]),
  );
  const agentNames: Record<string, string> = Object.fromEntries(
    visibleAgents.map((a) => [a.id, a.name]),
  );
  const lastAcpAgentId =
    [...sessions].reverse().find((s) => s.execution_mode === "acp")?.agent_id ?? null;

  useEffect(() => {
    if (pendingAgentId && sessions.length > 0) {
      const match = sessions.find((s) => String(s.task_id) === pendingAgentId);
      if (match) {
        setSelectedSessionKey(match.session_key);
        clearPendingAgent();
      }
    } else if (selectedSessionKey == null && sessions.length > 0) {
      setSelectedSessionKey(sessions[0].session_key);
    }
  }, [sessions, pendingAgentId, clearPendingAgent, selectedSessionKey]);

  function handleCloseSession(session: ActiveSessionInfo) {
    cancelMutation.mutate(
      { sessionKey: session.session_key, executionMode: session.execution_mode },
      {
        onSuccess: () => {
          if (selectedSessionKey === session.session_key) setSelectedSessionKey(null);
        },
      },
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <ShortcutHint shortcutId="focus-search">
            <InputGroup>
              <InputGroupInput
                ref={searchInputRef}
                type="text"
                placeholder="Search sessions..."
                value={search}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                className="h-8 w-48 text-sm"
              />
              <InputGroupAddon align="inline-start">
                <SearchIcon className="text-muted-foreground" />
              </InputGroupAddon>
            </InputGroup>
          </ShortcutHint>
        </div>
        <div className="flex items-center gap-2">
          {(discovery?.agents?.length ?? 0) > 0 && (
            <ShortcutHint shortcutId="agents-history">
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-8 text-xs", showHistory && "bg-muted text-foreground")}
                onClick={() => setShowHistory((v) => !v)}
              >
                <History className="size-3.5 mr-1" />
                History
              </Button>
            </ShortcutHint>
          )}
          <Popover>
            <PopoverTrigger
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Display settings"
            >
              <Settings2 className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 gap-3">
              <p className="text-xs font-semibold text-foreground">Display Settings</p>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted-foreground">Thinking blocks</label>
                <Select value={thinkingVisibility} onValueChange={handleThinkingVisibilityChange}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue>
                      {
                        {
                          auto: "Auto",
                          show: "Show expanded",
                          collapse: "Collapsed",
                          hide: "Hidden",
                        }[thinkingVisibility]
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="show">Show expanded</SelectItem>
                    <SelectItem value="collapse">Collapsed</SelectItem>
                    <SelectItem value="hide">Hidden</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted-foreground">Tool calls</label>
                <Select value={toolCallVisibility} onValueChange={handleToolCallVisibilityChange}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue>
                      {
                        {
                          auto: "Auto",
                          show: "Show expanded",
                          collapse: "Collapsed",
                          hide: "Hidden",
                        }[toolCallVisibility]
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="show">Show expanded</SelectItem>
                    <SelectItem value="collapse">Collapsed</SelectItem>
                    <SelectItem value="hide">Hidden</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs text-muted-foreground">Compact stream</label>
                <Switch
                  checked={isCompact}
                  onCheckedChange={handleCompactToggle}
                  className="data-unchecked:bg-muted data-unchecked:border-border/50"
                />
              </div>
            </PopoverContent>
          </Popover>
          <ShortcutHint shortcutId="agents-new">
            <Button
              variant="accent"
              size="sm"
              className="h-8 text-xs bg-clip-border"
              onClick={() => setShowSpawnDialog(true)}
            >
              <Plus className="size-3.5 mr-1" />
              New Session
            </Button>
          </ShortcutHint>
        </div>
      </div>

      {/* Agent monitor */}
      <div className="flex-1 min-h-0 relative">
        <AgentMonitor
          sessions={sessions}
          selectedSessionKey={selectedSessionKey}
          onSelect={setSelectedSessionKey}
          newSessionKey={lastSpawnedKey}
          search={search}
          agentIcons={agentIcons}
          agentNames={agentNames}
          onClose={handleCloseSession}
          projectId={projectId}
          onOpenTerminal={(session) => {
            if (projectId == null || repoPath == null) return;
            const worktree = worktrees.find((wt) => wt.branch_name === session.branch_name);
            if (!worktree) return;
            spawnMutation.mutate(
              {
                projectId,
                branchName: worktree.branch_name,
                repoPath,
                sessionName: null,
                worktreeId: worktree.id,
              },
              { onSuccess: (key) => setSelectedSessionKey(key) },
            );
          }}
        />
        {showHistory && visibleAgents.length > 0 && (
          <SessionHistoryPanel
            agents={visibleAgents}
            defaultAgentId={lastAcpAgentId ?? visibleAgents[0]?.id ?? null}
            repoPath={repoPath ?? ""}
            connection={connection}
            projectId={projectId ?? 0}
            worktrees={worktrees}
            onClose={() => setShowHistory(false)}
            onSessionLoaded={(key) => {
              setSelectedSessionKey(key);
              setShowHistory(false);
            }}
          />
        )}
      </div>

      <SpawnSessionDialog
        open={showSpawnDialog}
        onOpenChange={setShowSpawnDialog}
        projectId={projectId ?? 0}
        repoPath={repoPath ?? ""}
        connection={connection}
        worktrees={worktrees}
        onSuccess={(key) => {
          setSelectedSessionKey(key);
          setLastSpawnedKey(key);
        }}
      />
    </div>
  );
};
