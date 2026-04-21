import { useState, useEffect } from "react";
import { useAgentRegistryQuery, useSpawnAcpSessionMutation } from "@/services/execution.service";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/ui/command";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import type { WorktreeWithStatus, AgentInfo } from "@/types/bindings";

interface AgentSelectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktrees: WorktreeWithStatus[];
  repoPath?: string;
  onSpawned: (logId: number) => void;
}

export function AgentSelectorDialog({
  open,
  onOpenChange,
  worktrees,
  repoPath,
  onSpawned,
}: AgentSelectorDialogProps) {
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [selectedWorktree, setSelectedWorktree] = useState<WorktreeWithStatus | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [searchValue, setSearchValue] = useState("");

  const { data: registry, isLoading } = useAgentRegistryQuery(open);
  const spawnMutation = useSpawnAcpSessionMutation();

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedAgent(null);
      setSessionName("");
      setSelectedWorktree(worktrees[0] ?? null);
      setSearchValue("");
    }
  }, [open, worktrees]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Spawn ACP Agent</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {registry?.stale && (
            <div className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1">
              Showing cached agents — registry unavailable
            </div>
          )}

          {/* Step 1: Agent search */}
          <Command shouldFilter={true}>
            <CommandInput
              placeholder="Search agents..."
              value={searchValue}
              onValueChange={setSearchValue}
            />
            <CommandList>
              <CommandEmpty>{isLoading ? "Loading agents..." : "No agents found."}</CommandEmpty>
              <CommandGroup>
                {(registry?.agents ?? []).map((agent) => (
                  <CommandItem
                    key={agent.id}
                    value={agent.name}
                    onSelect={() => {
                      setSelectedAgent(agent);
                      setSearchValue("");
                    }}
                    data-checked={selectedAgent?.id === agent.id}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium text-sm">{agent.name}</span>
                      {agent.description && (
                        <span className="text-xs text-muted-foreground line-clamp-1">
                          {agent.description}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>

          {/* Step 2: Worktree + session name (visible after agent selection) */}
          {selectedAgent && (
            <div className="space-y-3 border-t border-border pt-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Agent:</span>
                <Badge variant="outline">{selectedAgent.name}</Badge>
                <span className="text-xs text-muted-foreground">v{selectedAgent.version}</span>
              </div>
              <div className="space-y-2">
                <Label htmlFor="acp-worktree">Worktree</Label>
                <Select
                  value={selectedWorktree?.branch_name ?? ""}
                  onValueChange={(v) =>
                    setSelectedWorktree(
                      worktrees.find((wt) => wt.branch_name === v) ?? null,
                    )
                  }
                >
                  <SelectTrigger id="acp-worktree">
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
                <Label htmlFor="acp-session-name">Session name (optional)</Label>
                <Input
                  id="acp-session-name"
                  placeholder="e.g. implement auth, fix bug"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!selectedAgent || !selectedWorktree || spawnMutation.isPending}
            onClick={() => {
              if (!selectedAgent || !selectedWorktree) return;
              spawnMutation.mutate(
                {
                  agentId: selectedAgent.id,
                  cwd: selectedWorktree.path,
                  sessionName: sessionName.trim() || null,
                },
                {
                  onSuccess: (logId) => {
                    onOpenChange(false);
                    onSpawned(logId);
                  },
                },
              );
            }}
          >
            {spawnMutation.isPending ? "Spawning..." : "Spawn Agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
