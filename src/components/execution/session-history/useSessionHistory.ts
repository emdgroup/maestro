import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import type { ConnectionKey, DiscoveredAgent, WorktreeWithStatus } from "@/types/bindings";
import { toPosixPath } from "@/lib/path-utils";
import type { SpawnSeed } from "@/components/execution/spawn-session-dialog/SpawnSessionDialog";
import {
  useSessionListQuery,
  useRenameAcpSessionMutation,
  useDeleteAcpSessionMutation,
} from "@/services/execution.service";

export type Preset = "all" | "today" | "yesterday" | "7d" | "30d" | "custom";

export interface PendingResume {
  acpSessionId: string;
  seed: SpawnSeed;
}

function samePath(a: string, b: string) {
  const normalize = (p: string) => toPosixPath(p).replace(/\/+$/, "");
  return normalize(a) === normalize(b);
}

/**
 * Where the resume dialog starts, given the folder the session was recorded as having run in.
 *
 * `folder` is relative to the project root: `""` is the root itself, `null`/`undefined` means
 * nothing was recorded. The project directory for the root, the worktree it names if that still
 * exists, and a new worktree for everything else, since there is nothing left to reuse.
 */
export function resumeWorkspace(
  folder: string | null | undefined,
  repoPath: string,
  worktrees: WorktreeWithStatus[],
): Pick<SpawnSeed, "workspaceMode" | "worktree"> {
  if (folder === "") return { workspaceMode: "RepositoryDirectory" };
  const wt =
    folder == null ? undefined : worktrees.find((w) => samePath(w.path, `${repoPath}/${folder}`));
  return wt ? { workspaceMode: "ReuseWorkspace", worktree: wt } : { workspaceMode: "NewWorktree" };
}

interface Props {
  open: boolean;
  agents: DiscoveredAgent[];
  defaultAgentId: string | null;
  repoPath: string;
  connection: ConnectionKey;
  projectId: number;
  worktrees: WorktreeWithStatus[];
}

export function useSessionHistory({
  open,
  agents,
  defaultAgentId,
  repoPath,
  connection,
  projectId,
  worktrees,
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
  const [pendingResume, setPendingResume] = useState<PendingResume | null>(null);
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

  function toggleTick(acpSessionId: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(acpSessionId)) next.delete(acpSessionId);
      else next.add(acpSessionId);
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
    for (const acpSessionId of ids) {
      deleteMutation.mutate({ agentId, acpSessionId, cwd: repoPath, connection });
    }
    setTicked(new Set());
  }

  function handleRowClick(acpSessionId: string, title: string | null) {
    if (ticked.size > 0) {
      toggleTick(acpSessionId);
      return;
    }
    const folder = sessions.find((s) => s.session_id === acpSessionId)?.folder;
    setPendingResume({
      acpSessionId,
      seed: { ...resumeWorkspace(folder, repoPath, worktrees), sessionName: title ?? "" },
    });
  }

  const startRename = useCallback(
    (acpSessionId: string, currentTitle: string | null, e: React.MouseEvent) => {
      e.stopPropagation();
      setRenamingId(acpSessionId);
      setRenameValue(currentTitle ?? "");
      setTimeout(() => renameInputRef.current?.select(), 0);
    },
    [],
  );

  const commitRename = useCallback(
    (acpSessionId: string) => {
      const trimmed = renameValue.trim();
      if (trimmed && agentId) {
        renameMutation.mutate({
          projectId,
          agentId,
          acpSessionId: acpSessionId,
          displayName: trimmed,
        });
      }
      setRenamingId(null);
    },
    [renameValue, agentId, projectId, renameMutation],
  );

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
    pendingResume,
    setPendingResume,
    handleRowClick,
    startRename,
    commitRename,
    supportsSessionDelete,
    allSelected,
    someSelected,
    selectAll,
    deleteTicked,
    deleteMutation,
  };
}
