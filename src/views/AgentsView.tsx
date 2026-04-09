import { useState, useEffect } from "react";
import { AgentMonitor, STATUS_FILTERS, STATUS_LABEL } from "@/components/execution/AgentMonitor";
import type { StatusFilter } from "@/components/execution/AgentMonitor";
import { usePendingAgentId, useNavigationActions } from "@/store/navigationStore";
import {
  useExecutionsWithTaskInfoQuery,
  useSpawnInteractiveExecutionMutation,
  useDeleteExecutionMutation,
} from "@/services/execution.service";
import { useWorktreesQuery } from "@/services/worktree.service";
import type { WorktreeWithStatus } from "@/types/bindings";
import { Input } from "@/ui/input";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui";
import { SearchIcon } from "lucide-react";

interface AgentsViewProps {
  projectId?: number;
  repoPath?: string;
}

/**
 * AgentsView - Page-level orchestrator for the agent monitoring screen.
 * Owns the execution data query and filter state, passes props down to AgentMonitor.
 * Handles deep-link selection via pendingAgentId from navigationStore.
 */
export const AgentsView: React.FC<AgentsViewProps> = ({ projectId, repoPath }) => {
  const { data: executions = [] } = useExecutionsWithTaskInfoQuery(projectId);
  const pendingAgentId = usePendingAgentId();
  const { clearPendingAgent } = useNavigationActions();
  const [selectedExecutionId, setSelectedExecutionId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");

  // Spawn Agent dialog state
  const [showSpawnDialog, setShowSpawnDialog] = useState(false);
  const [selectedWorktree, setSelectedWorktree] = useState<WorktreeWithStatus | null>(null);
  const [spawnLabel, setSpawnLabel] = useState("");

  const { data: worktrees = [] } = useWorktreesQuery(projectId, repoPath);
  const spawnMutation = useSpawnInteractiveExecutionMutation();
  const deleteMutation = useDeleteExecutionMutation();

  // Deep-link: pendingAgentId overrides selection on first mount (matches by task_id)
  useEffect(() => {
    if (pendingAgentId && executions.length > 0) {
      const match = executions.find((e) => String(e.task_id) === pendingAgentId);
      if (match) {
        setSelectedExecutionId(match.id);
        clearPendingAgent();
      }
    } else if (selectedExecutionId == null && executions.length > 0) {
      // Fallback: auto-select most recent Running execution
      const running = executions.find((e) => e.status === "running");
      if (running) setSelectedExecutionId(running.id);
    }
  }, [executions, pendingAgentId, clearPendingAgent, selectedExecutionId]);

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0">
        <div className="flex items-center gap-2">
          <InputGroup>
            <InputGroupInput
              type="text"
              placeholder="Search sessions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-48 text-sm"
            />
            <InputGroupAddon align="inline-start">
              <SearchIcon className="text-muted-foreground" />
            </InputGroupAddon>
          </InputGroup>
          <ToggleGroup variant="outline" size="sm" value={[statusFilter]}>
            {STATUS_FILTERS.map((f) => (
              <ToggleGroupItem
                key={f}
                value={f}
                pressed={statusFilter === f}
                onClick={() => setStatusFilter(f)}
                className="text-xs px-3"
              >
                {STATUS_LABEL[f] ?? f}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {/* Agent monitor */}
      <div className="flex-1 min-h-0">
        <AgentMonitor
          executions={executions}
          selectedExecutionId={selectedExecutionId}
          onSelect={setSelectedExecutionId}
          search={search}
          statusFilter={statusFilter}
          onSpawn={() => {
            setSelectedWorktree(worktrees[0] ?? null);
            setSpawnLabel("");
            setShowSpawnDialog(true);
          }}
          onDelete={(executionId) => {
            deleteMutation.mutate({ executionId });
            if (selectedExecutionId === executionId) setSelectedExecutionId(null);
          }}
          onReconnect={(execution) => {
            if (execution.branch_name && projectId != null && repoPath != null) {
              spawnMutation.mutate(
                {
                  projectId,
                  branchName: execution.branch_name,
                  repoPath,
                  label: null,
                  worktreeId: null,
                },
                {
                  onSuccess: (logId) => {
                    setSelectedExecutionId(logId);
                    deleteMutation.mutate({ executionId: execution.id });
                  },
                },
              );
            }
          }}
        />
      </div>

      {/* Spawn Agent dialog */}
      <Dialog open={showSpawnDialog} onOpenChange={setShowSpawnDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Spawn Interactive Agent</DialogTitle>
            <DialogDescription>
              Start an interactive agent session in a worktree. No task required — you drive the
              terminal.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="spawn-worktree">Worktree</Label>
              <Select
                value={selectedWorktree?.branch_name ?? ""}
                onValueChange={(v) => setSelectedWorktree(worktrees.find((wt) => wt.branch_name === v) ?? null)}
              >
                <SelectTrigger id="spawn-worktree">
                  <SelectValue placeholder="Select a worktree" />
                </SelectTrigger>
                <SelectContent>
                  {worktrees.map((wt) => (
                    <SelectItem key={wt.branch_name} value={wt.branch_name}>
                      <span className="font-mono">{wt.branch_name}</span>
                      {wt.path === repoPath && (
                        <span className="ml-2 text-xs text-muted-foreground">main</span>
                      )}
                      {wt.agent_status === "running" && (
                        <span className="ml-2 text-xs text-green-500">running</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="spawn-label">Label (optional)</Label>
              <Input
                id="spawn-label"
                placeholder="e.g. debugging, exploration"
                value={spawnLabel}
                onChange={(e) => setSpawnLabel(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSpawnDialog(false)}>
              Cancel
            </Button>
            <Button
              disabled={!selectedWorktree || spawnMutation.isPending}
              onClick={() => {
                spawnMutation.mutate(
                  {
                    projectId: projectId!,
                    branchName: selectedWorktree!.branch_name,
                    repoPath: repoPath!,
                    label: spawnLabel.trim() || null,
                    worktreeId: selectedWorktree!.id,
                  },
                  {
                    onSuccess: (logId) => {
                      setShowSpawnDialog(false);
                      setSelectedExecutionId(logId);
                    },
                  },
                );
              }}
            >
              {spawnMutation.isPending ? "Spawning..." : "Spawn"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
