import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { X, Pencil, Check } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import {
  useSessionListQuery,
  useLoadAcpSessionMutation,
  useRenameAcpSessionMutation,
} from "@/services/execution.service";
import type { DiscoveredAgent, WorktreeWithStatus } from "@/types/bindings";

interface SessionHistoryPanelProps {
  agents: DiscoveredAgent[];
  defaultAgentId: string | null;
  repoPath: string;
  connectionId: number | null;
  projectId: number;
  worktrees: WorktreeWithStatus[];
  onClose: () => void;
  onSessionLoaded: (sessionKey: number) => void;
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dateGroup(dateStr: string | null): string {
  if (!dateStr) return "Older";
  const diffDays = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 7) return "This Week";
  return "Older";
}

const GROUP_ORDER = ["Today", "Yesterday", "This Week", "Older"];

interface PendingRestore {
  sessionId: string;
  title: string | null;
}

export function SessionHistoryPanel({
  agents,
  defaultAgentId,
  repoPath,
  connectionId,
  projectId,
  worktrees,
  onClose,
  onSessionLoaded,
}: SessionHistoryPanelProps) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    defaultAgentId ?? agents[0]?.id ?? null,
  );
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string>(repoPath);
  const [worktreeFilter, setWorktreeFilter] = useState("");

  const { data: sessions = [], isLoading, isError } = useSessionListQuery(
    selectedAgentId,
    repoPath,
    connectionId,
    projectId,
  );
  const loadMutation = useLoadAcpSessionMutation();
  const renameMutation = useRenameAcpSessionMutation();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (pendingRestore) return;
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, pendingRestore]);

  const startRename = useCallback(
    (sessionId: string, currentTitle: string | null, e: React.MouseEvent) => {
      e.stopPropagation();
      setRenamingId(sessionId);
      setRenameValue(currentTitle ?? "");
      setTimeout(() => renameInputRef.current?.select(), 0);
    },
    [],
  );

  const commitRename = useCallback(
    (sessionId: string) => {
      const trimmed = renameValue.trim();
      if (trimmed && selectedAgentId) {
        renameMutation.mutate({
          projectId,
          agentId: selectedAgentId,
          acpSessionId: sessionId,
          displayName: trimmed,
        });
      }
      setRenamingId(null);
    },
    [renameValue, selectedAgentId, projectId, renameMutation],
  );

  const handleSessionClick = useCallback(
    (sessionId: string, title: string | null) => {
      if (!selectedAgentId) return;
      if (worktrees.length <= 1) {
        const mainBranch = worktrees[0]?.branch_name ?? null;
        loadMutation.mutate(
          {
            agentId: selectedAgentId,
            sessionId,
            cwd: repoPath,
            connectionId,
            sessionName: title,
            projectId,
            worktreeBranch: mainBranch,
          },
          {
            onSuccess: (sessionKey) => {
              onSessionLoaded(sessionKey);
              onClose();
            },
          },
        );
      } else {
        setSelectedWorktreePath(repoPath);
        setWorktreeFilter("");
        setPendingRestore({ sessionId, title });
      }
    },
    [selectedAgentId, worktrees, repoPath, connectionId, projectId, loadMutation, onSessionLoaded, onClose],
  );

  const commitRestore = useCallback(() => {
    if (!pendingRestore || !selectedAgentId) return;
    const selectedWt = worktrees.find((wt) => wt.path === selectedWorktreePath);
    loadMutation.mutate(
      {
        agentId: selectedAgentId,
        sessionId: pendingRestore.sessionId,
        cwd: selectedWorktreePath,
        connectionId,
        sessionName: pendingRestore.title,
        projectId,
        worktreeBranch: selectedWt?.branch_name ?? null,
      },
      {
        onSuccess: (sessionKey) => {
          setPendingRestore(null);
          onSessionLoaded(sessionKey);
          onClose();
        },
      },
    );
  }, [pendingRestore, selectedAgentId, selectedWorktreePath, worktrees, connectionId, projectId, loadMutation, onSessionLoaded, onClose]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) => (s.title ?? s.session_id).toLowerCase().includes(q),
    );
  }, [sessions, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const s of filtered) {
      const g = dateGroup(s.updated_at);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [filtered]);

  const filteredWorktrees = useMemo(() => {
    const q = worktreeFilter.trim().toLowerCase();
    if (!q) return worktrees;
    return worktrees.filter(
      (wt) =>
        wt.branch_name.toLowerCase().includes(q) || wt.path.toLowerCase().includes(q),
    );
  }, [worktrees, worktreeFilter]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  return (
    <div className="absolute top-2 right-2 bottom-2 z-30 flex flex-col w-[300px] rounded-lg border border-border bg-card shadow-[0_8px_32px_rgba(0,0,0,0.4),-2px_0_16px_rgba(0,0,0,0.2)] overflow-hidden">
      {/* header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-border shrink-0">
        <span className="text-xs font-semibold">Session History</span>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose}>
          <X className="w-3 h-3" />
        </Button>
      </div>

      {/* agent filter */}
      {agents.length > 0 && (
        <div className="px-2 py-2 border-b border-border shrink-0">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1.5 px-1">
            Agent
          </p>
          <div className="flex gap-1 flex-wrap">
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                className={cn(
                  "h-6 px-2 rounded text-[10px] font-medium flex items-center gap-1.5 border transition-colors",
                  selectedAgentId === agent.id
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-border/80",
                )}
              >
                {agent.icon && (
                  <img
                    src={agent.icon}
                    className="w-3 h-3 rounded-sm shrink-0 dark:[filter:invert(1)]"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                )}
                {agent.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* search */}
      <div className="px-2 py-2 border-b border-border shrink-0">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${selectedAgent?.name ?? ""} sessions...`}
          className="w-full h-7 bg-muted/30 border border-border rounded px-2.5 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-ring"
        />
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {isLoading && (
          <div className="text-xs text-muted-foreground py-8 text-center">Loading...</div>
        )}
        {isError && (
          <div className="text-xs text-destructive py-8 text-center">Failed to load history</div>
        )}
        {!isLoading && !isError && filtered.length === 0 && (
          <div className="text-xs text-muted-foreground py-8 text-center">
            {search ? "No results" : "No past sessions"}
          </div>
        )}
        {grouped.map(([group, entries]) => (
          <div key={group}>
            <div className="px-3 pt-2.5 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50 sticky top-0 bg-card">
              {group}
            </div>
            {entries.map((entry) => (
              <div key={entry.session_id} className="px-1.5">
                {renamingId === entry.session_id ? (
                  <div className="flex items-center gap-1.5 px-2 py-2 rounded-md">
                    <input
                      ref={renameInputRef}
                      className="flex-1 text-xs bg-transparent border-b border-ring outline-none"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(entry.session_id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={() => commitRename(entry.session_id)}
                      autoFocus
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0 shrink-0"
                      onClick={() => commitRename(entry.session_id)}
                    >
                      <Check className="w-2.5 h-2.5" />
                    </Button>
                  </div>
                ) : (
                  <button
                    disabled={loadMutation.isPending}
                    onClick={() => handleSessionClick(entry.session_id, entry.title)}
                    className={cn(
                      "group w-full text-left px-2 py-2 rounded-md border border-transparent",
                      "hover:bg-muted/20 hover:border-border/50 transition-all",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2 min-w-0">
                      <span className="text-xs font-medium text-foreground truncate flex-1">
                        {entry.title ?? entry.session_id}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        {entry.updated_at && (
                          <span className="text-[10px] text-muted-foreground/60">
                            {relativeTime(entry.updated_at)}
                          </span>
                        )}
                        <button
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted/40 transition-opacity"
                          onClick={(e) => startRename(entry.session_id, entry.title, e)}
                          title="Rename"
                        >
                          <Pencil className="w-2.5 h-2.5 text-muted-foreground" />
                        </button>
                      </div>
                    </div>
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Worktree picker dialog */}
      {pendingRestore && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm"
          onClick={() => setPendingRestore(null)}
        >
          <div
            className="mx-3 w-full rounded-lg border border-border bg-card shadow-lg overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 pt-3 pb-2 border-b border-border">
              <p className="text-xs font-semibold">Choose Worktree</p>
              {pendingRestore.title && (
                <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                  {pendingRestore.title}
                </p>
              )}
            </div>

            {worktrees.length > 5 && (
              <div className="px-2 py-1.5 border-b border-border">
                <input
                  type="text"
                  value={worktreeFilter}
                  onChange={(e) => setWorktreeFilter(e.target.value)}
                  placeholder="Filter worktrees..."
                  className="w-full h-6 bg-muted/30 border border-border rounded px-2 text-xs text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-ring"
                  autoFocus
                />
              </div>
            )}

            <div className="overflow-y-auto custom-scrollbar" style={{ maxHeight: 240 }}>
              {filteredWorktrees.map((wt) => {
                const isMain = wt.path === repoPath;
                const isSelected = selectedWorktreePath === wt.path;
                return (
                  <button
                    key={wt.path}
                    onClick={() => setSelectedWorktreePath(wt.path)}
                    className={cn(
                      "w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors",
                      isSelected ? "bg-primary/10" : "hover:bg-muted/20",
                    )}
                  >
                    <span
                      className={cn(
                        "w-3 h-3 rounded-full border-2 shrink-0",
                        isSelected
                          ? "border-primary bg-primary"
                          : "border-muted-foreground/40 bg-transparent",
                      )}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="text-xs font-medium truncate block">{wt.branch_name}</span>
                      <span className="text-[10px] text-muted-foreground/60 truncate block font-mono">
                        {wt.path}
                      </span>
                    </span>
                    {isMain && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold shrink-0">
                        default
                      </span>
                    )}
                  </button>
                );
              })}
              {filteredWorktrees.length === 0 && (
                <div className="text-xs text-muted-foreground py-4 text-center">No worktrees match</div>
              )}
            </div>

            <div className="px-3 py-2 border-t border-border flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setPendingRestore(null)}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                className="h-7 text-xs"
                disabled={loadMutation.isPending}
                onClick={commitRestore}
              >
                Restore
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
