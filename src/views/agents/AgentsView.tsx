import React, { useState, useRef, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useShortcuts } from "@/utils/hooks/useShortcuts";
import { cn } from "@/lib/utils.ts";
import { AgentMonitor } from "@/components/execution/agent-monitor/AgentMonitor";
import { SessionHistoryModal } from "@/components/execution/session-history/SessionHistoryModal";
import { SpawnSessionDialog } from "@/components/execution/spawn-session-dialog/SpawnSessionDialog";
import { usePendingAgentId, useNavigationActions } from "@/store/navigationStore";
import {
  useActiveSessionsQuery,
  useSpawnInteractiveExecutionMutation,
  useSpawnAcpSessionMutation,
  useAgentDiscoveryQuery,
  useCancelActiveSessionMutation,
} from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useSettings, useSaveSettings } from "@/services/settings.service";
import type { ActiveSessionInfo, ConnectionKey } from "@/types/bindings";
import { useBoardStore, useBoardActions } from "@/store/boardStore";
import { api } from "@/lib/tauri-utils";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { History, Menu, Plus, SearchIcon, Settings2 } from "lucide-react";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import type { ActivityVisibility } from "@/types/bindings";

interface AgentsViewProps {
  projectId?: number;
  repoPath?: string;
  connection: ConnectionKey;
}

function connKeyToId(connection: ConnectionKey): string {
  switch (connection.type) {
    case "local":
      return "local";
    case "ssh":
      return `ssh-${connection.id}`;
    case "wsl":
      return `wsl-${connection.id}`;
    case "docker":
      return `docker-${connection.id}`;
  }
}

function connIdMatches(connection: ConnectionKey, connId: string): boolean {
  return connKeyToId(connection) === connId;
}

export const AgentsView: React.FC<AgentsViewProps> = ({ projectId, repoPath, connection }) => {
  const { data: sessions = [] } = useActiveSessionsQuery(projectId);
  const pendingAgentId = usePendingAgentId();
  const { clearPendingAgent } = useNavigationActions();
  const [selectedSessionKey, setSelectedSessionKey] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const visibleSessions = sessions.filter((s) => s.session_name !== "__embedded__");

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
      const session = visibleSessions.find((s) => s.session_key === selectedSessionKey);
      if (session) handleCloseSession(session);
    },
  });
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const cancelMutation = useCancelActiveSessionMutation();

  const queryClient = useQueryClient();
  const authRequiredTasks = useBoardStore((s) => s.authRequiredTasks);
  const pendingSessionRetry = useBoardStore((s) => s.pendingSessionRetry);
  const {
    clearAuthRequired,
    setAuthTerminalIdle,
    setPendingAuthRetry,
    setPendingSessionRetry,
    clearPendingSessionRetry,
  } = useBoardActions();
  const authRequiredTasksRef = useRef(authRequiredTasks);
  authRequiredTasksRef.current = authRequiredTasks;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const spawnAcpMutation = useSpawnAcpSessionMutation();

  useEffect(() => {
    const connId = connKeyToId(connection);
    const unlisten = listen<{ exit_code: number | null }>(
      `acp://auth-pty-exit/${connId}`,
      (event) => {
        const tasks = authRequiredTasksRef.current;
        const found = Object.entries(tasks).find(
          ([, e]) => e.terminalState === "running" && connIdMatches(e.connection, connId),
        );
        if (!found) return;
        const taskId = Number(found[0]);
        if (event.payload.exit_code === 0) {
          const lastPrompt = authRequiredTasksRef.current[taskId]?.lastPrompt;
          clearAuthRequired(taskId);
          const isManualSession = sessionsRef.current.some(
            (s) => s.session_key === taskId && !s.task_id,
          );
          if (isManualSession) {
            setPendingSessionRetry({ sessionKey: taskId, lastPrompt: lastPrompt ?? null });
          } else {
            setPendingAuthRetry(taskId);
          }
        } else {
          setAuthTerminalIdle(taskId);
        }
      },
    ).catch(console.error);
    return () => {
      unlisten.then((fn) => fn?.());
    };
  }, [
    connection,
    clearAuthRequired,
    setAuthTerminalIdle,
    setPendingAuthRetry,
    setPendingSessionRetry,
  ]);

  useEffect(() => {
    const connId = connKeyToId(connection);
    const unlisten = listen<{ agentId: string }>(`acp://auth-state-changed/${connId}`, (event) => {
      void queryClient.invalidateQueries({
        queryKey: ["agentAuthInfo", event.payload.agentId, connection],
      });
    }).catch(console.error);
    return () => {
      unlisten.then((fn) => fn?.());
    };
  }, [connection, queryClient]);

  useEffect(() => {
    if (!pendingSessionRetry || !projectId) return;
    const { sessionKey, lastPrompt } = pendingSessionRetry;
    clearPendingSessionRetry();
    void (async () => {
      const session = sessionsRef.current.find((s) => s.session_key === sessionKey);
      if (!session) return;
      const meta = await api.getAcpSessionMeta(sessionKey).catch(() => null);
      if (!meta) return;
      await api.discardFailedSpawn(sessionKey).catch(() => {});
      const result = await spawnAcpMutation.mutateAsync({
        agentId: session.agent_id ?? "",
        cwd: meta.cwd,
        sessionName: session.session_name ?? null,
        projectId: meta.project_id ?? projectId,
        connection,
        worktreeBranch: session.branch_name ?? null,
      });
      setSelectedSessionKey(result.log_id);
      if (lastPrompt != null) {
        const logId = result.log_id;
        void (async () => {
          const unlisten = await listen<null>(`acp://spawn-ok/${logId}`, async () => {
            unlisten();
            try {
              if (Array.isArray(lastPrompt)) {
                await api.sendAcpPromptStructured(logId, lastPrompt);
              } else {
                await api.sendAcpPrompt(logId, lastPrompt as string);
              }
            } catch (e) {
              console.error("[auth-retry] sendAcpPrompt failed:", e);
            }
          });
        })().catch(console.error);
      }
    })().catch(console.error);
  }, [pendingSessionRetry, projectId, connection, clearPendingSessionRetry, spawnAcpMutation]);

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
    if (pendingAgentId && visibleSessions.length > 0) {
      const match = visibleSessions.find((s) => String(s.task_id) === pendingAgentId);
      if (match) {
        setSelectedSessionKey(match.session_key);
        clearPendingAgent();
      }
    } else if (selectedSessionKey == null && visibleSessions.length > 0) {
      setSelectedSessionKey(visibleSessions[0].session_key);
    }
  }, [visibleSessions, pendingAgentId, clearPendingAgent, selectedSessionKey]);

  const spawnShell = useCallback(
    async (
      branchName: string | null,
      taskId: number | null,
      embedded = false,
    ): Promise<number | null> => {
      if (projectId == null || repoPath == null) return null;
      let resolvedBranch = branchName;
      if (resolvedBranch == null && taskId != null) {
        resolvedBranch = worktrees.find((wt) => wt.task_id === taskId)?.branch_name ?? null;
      }
      return spawnMutation.mutateAsync({
        projectId,
        branchName: resolvedBranch,
        repoPath,
        sessionName: embedded ? "__embedded__" : null,
      });
    },
    [projectId, repoPath, worktrees, spawnMutation],
  );

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
      <div className="h-12 bg-card flex items-center justify-between pl-2.5 pr-4 gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              type="button"
              onClick={() => setSidebarCollapsed((v) => !v)}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                sidebarCollapsed
                  ? "bg-muted/60 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
            >
              <Menu className="w-4 h-4" />
            </TooltipTrigger>
            <TooltipContent>
              {sidebarCollapsed ? "Expand session list" : "Collapse session list"}
            </TooltipContent>
          </Tooltip>
          <ShortcutHint shortcutId="focus-search">
            <InputGroup className="bg-border!">
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
        </div>
        <div className="flex items-center gap-2">
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
          sessions={visibleSessions}
          selectedSessionKey={selectedSessionKey}
          onSelect={setSelectedSessionKey}
          newSessionKey={lastSpawnedKey}
          search={search}
          agentIcons={agentIcons}
          agentNames={agentNames}
          onClose={handleCloseSession}
          projectId={projectId}
          sidebarCollapsed={sidebarCollapsed}
          onSidebarCollapsedChange={setSidebarCollapsed}
          onSpawnShell={spawnShell}
          connection={connection}
        />
        <SessionHistoryModal
          open={showHistory && visibleAgents.length > 0}
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
