import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import type { ConnectionKey, DiscoveredAgent, WorktreeWithStatus } from "@/types/bindings";
import {
  useSessionListQuery,
  useLoadAcpSessionMutation,
  useRenameAcpSessionMutation,
  useDeleteAcpSessionMutation,
} from "@/services/execution.service";

export type Preset = "all" | "today" | "yesterday" | "7d" | "30d" | "custom";

export interface PendingRestore {
  sessionId: string;
  title: string | null;
}

interface Props {
  open: boolean;
  agents: DiscoveredAgent[];
  defaultAgentId: string | null;
  repoPath: string;
  connection: ConnectionKey;
  projectId: number;
  worktrees: WorktreeWithStatus[];
  onClose: () => void;
  onSessionLoaded: (sessionKey: number) => void;
}

export function useSessionHistory({
  open,
  agents,
  defaultAgentId,
  repoPath,
  connection,
  projectId,
  worktrees,
  onClose,
  onSessionLoaded,
}: Props) {
  const [agentId, setAgentId] = useState<string | null>(defaultAgentId ?? agents[0]?.id ?? null);
  const [preset, setPreset] = useState<Preset>("all");
  const [customRange, setCustomRange] = useState<DateRange>({ from: undefined });
  const [stagingRange, setStagingRange] = useState<DateRange>({ from: undefined });
  const [query, setQuery] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState(repoPath);
  const [worktreeFilter, setWorktreeFilter] = useState("");
  const [calendarOpen, setCalendarOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setAgentId(defaultAgentId ?? agents[0]?.id ?? null);
      setPreset("all");
      setQuery("");
      setTicked(new Set());
    }
    // only fires on open toggle; defaultAgentId/agents are intentionally excluded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const {
    data: sessionListResult,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useSessionListQuery(agentId, repoPath, connection, projectId, open);
  const sessions = useMemo(() => sessionListResult?.sessions ?? [], [sessionListResult]);
  const supportsSessionDelete = sessionListResult?.supports_session_delete ?? false;
  const loadMutation = useLoadAcpSessionMutation();
  const renameMutation = useRenameAcpSessionMutation();
  const deleteMutation = useDeleteAcpSessionMutation();

  function changePreset(p: Preset) {
    setPreset(p);
    setTicked(new Set());
  }

  const filtered = useMemo(() => {
    let result = sessions;
    const now = new Date();
    if (preset !== "all") {
      result = result.filter((s) => {
        if (!s.updated_at) return false;
        const d = new Date(s.updated_at);
        if (preset === "today") return d.toDateString() === now.toDateString();
        if (preset === "yesterday") {
          const yesterday = new Date(now);
          yesterday.setDate(now.getDate() - 1);
          return d.toDateString() === yesterday.toDateString();
        }
        if (preset === "7d") {
          const cutoff = new Date(now);
          cutoff.setDate(now.getDate() - 7);
          return d >= cutoff;
        }
        if (preset === "30d") {
          const cutoff = new Date(now);
          cutoff.setDate(now.getDate() - 30);
          return d >= cutoff;
        }
        if (preset === "custom") {
          if (customRange.from && d < customRange.from) return false;
          if (customRange.to) {
            const end = new Date(customRange.to);
            end.setHours(23, 59, 59, 999);
            if (d > end) return false;
          }
          return true;
        }
        return true;
      });
    }
    const q = query.trim().toLowerCase();
    if (q) result = result.filter((s) => (s.title ?? s.session_id).toLowerCase().includes(q));
    return result;
  }, [sessions, preset, customRange, query]);

  const summaryLabel = useMemo(() => {
    const count = filtered.length;
    if (preset === "all") return `All sessions · ${count} sessions`;
    if (preset === "today") return `Today · ${count} sessions`;
    if (preset === "yesterday") return `Yesterday · ${count} sessions`;
    if (preset === "7d") return `Last 7 days · ${count} sessions`;
    if (preset === "30d") return `Last 30 days · ${count} sessions`;
    if (preset === "custom") {
      const from = customRange.from ? format(customRange.from, "MMM d") : "any";
      const to = customRange.to ? format(customRange.to, "MMM d") : "any";
      return `${from} – ${to} · ${count} sessions`;
    }
    return `${count} sessions`;
  }, [filtered.length, preset, customRange]);

  function toggleTick(sessionId: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  const allSelected = filtered.length > 0 && filtered.every((e) => ticked.has(e.session_id));
  const someSelected = ticked.size > 0 && !allSelected;

  function selectAll() {
    if (allSelected) {
      setTicked(new Set());
    } else {
      setTicked(new Set(filtered.map((e) => e.session_id)));
    }
  }

  function deleteTicked() {
    if (!agentId) return;
    const ids = [...ticked];
    for (const sessionId of ids) {
      deleteMutation.mutate({ agentId, sessionId, cwd: repoPath, connection });
    }
    setTicked(new Set());
  }

  const openSession = useCallback(
    (sessionId: string, title: string | null) => {
      if (!agentId) return;
      if (worktrees.length <= 1) {
        loadMutation.mutate(
          {
            agentId,
            sessionId,
            cwd: repoPath,
            connection,
            sessionName: title,
            projectId,
            worktreeBranch: worktrees[0]?.branch_name ?? null,
          },
          {
            onSuccess: (key) => {
              onSessionLoaded(key);
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
    [agentId, worktrees, repoPath, connection, projectId, loadMutation, onSessionLoaded, onClose],
  );

  function handleRowClick(sessionId: string, title: string | null) {
    if (ticked.size > 0) {
      toggleTick(sessionId);
      return;
    }
    openSession(sessionId, title);
  }

  function openTicked() {
    if (!agentId) return;
    const ids = [...ticked];
    let completed = 0;
    let lastKey: number | null = null;
    for (const sessionId of ids) {
      const entry = sessions.find((s) => s.session_id === sessionId);
      loadMutation.mutate(
        {
          agentId,
          sessionId,
          cwd: repoPath,
          connection,
          sessionName: entry?.title ?? null,
          projectId,
          worktreeBranch: worktrees[0]?.branch_name ?? null,
        },
        {
          onSuccess: (key) => {
            lastKey = key;
            completed++;
            if (completed === ids.length) {
              onSessionLoaded(lastKey!);
              onClose();
            }
          },
        },
      );
    }
  }

  const commitRestore = useCallback(() => {
    if (!pendingRestore || !agentId) return;
    const wt = worktrees.find((w) => w.path === selectedWorktreePath);
    loadMutation.mutate(
      {
        agentId,
        sessionId: pendingRestore.sessionId,
        cwd: selectedWorktreePath,
        connection,
        sessionName: pendingRestore.title,
        projectId,
        worktreeBranch: wt?.branch_name ?? null,
      },
      {
        onSuccess: (key) => {
          setPendingRestore(null);
          onSessionLoaded(key);
          onClose();
        },
      },
    );
  }, [
    pendingRestore,
    agentId,
    selectedWorktreePath,
    worktrees,
    connection,
    projectId,
    loadMutation,
    onSessionLoaded,
    onClose,
  ]);

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
      if (trimmed && agentId) {
        renameMutation.mutate({
          projectId,
          agentId,
          acpSessionId: sessionId,
          displayName: trimmed,
        });
      }
      setRenamingId(null);
    },
    [renameValue, agentId, projectId, renameMutation],
  );

  const filteredWorktrees = useMemo(() => {
    const q = worktreeFilter.trim().toLowerCase();
    if (!q) return worktrees;
    return worktrees.filter(
      (wt) => wt.branch_name.toLowerCase().includes(q) || wt.path.toLowerCase().includes(q),
    );
  }, [worktrees, worktreeFilter]);

  return {
    agentId,
    setAgentId,
    preset,
    changePreset,
    customRange,
    setCustomRange,
    stagingRange,
    setStagingRange,
    calendarOpen,
    setCalendarOpen,
    query,
    setQuery,
    ticked,
    toggleTick,
    setTicked,
    filtered,
    summaryLabel,
    sessions,
    isLoading,
    isError,
    isFetching,
    refetch,
    renamingId,
    setRenamingId,
    renameValue,
    setRenameValue,
    renameInputRef,
    pendingRestore,
    setPendingRestore,
    selectedWorktreePath,
    setSelectedWorktreePath,
    worktreeFilter,
    setWorktreeFilter,
    filteredWorktrees,
    handleRowClick,
    openTicked,
    commitRestore,
    startRename,
    commitRename,
    loadMutation,
    supportsSessionDelete,
    allSelected,
    someSelected,
    selectAll,
    deleteTicked,
    deleteMutation,
  };
}
