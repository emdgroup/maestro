import { GitBranch, Shield, ShieldOff } from "lucide-react";
import type { TaskPriority } from "@/types/bindings";
import { PriorityPicker } from "./PriorityPicker";
import { AgentPicker } from "./AgentPicker";
import type { Agent } from "./AgentPicker";
import { TogglePill } from "./TogglePill";

interface TaskMetadataPillsProps {
  priority: TaskPriority;
  onPriorityChange?: (p: TaskPriority) => void;
  agentId: string | null;
  agents: Agent[];
  onAgentChange?: (id: string | null) => void;
  isolatedWorktree: boolean;
  onIsolatedWorktreeChange?: (v: boolean) => void;
  autoApprove: boolean;
  onAutoApproveChange?: (v: boolean) => void;
  isGitRepo: boolean;
}

export function TaskMetadataPills({
  priority,
  onPriorityChange,
  agentId,
  agents,
  onAgentChange,
  isolatedWorktree,
  onIsolatedWorktreeChange,
  autoApprove,
  onAutoApproveChange,
  isGitRepo,
}: TaskMetadataPillsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <PriorityPicker value={priority} onChange={onPriorityChange} />
      <AgentPicker agentId={agentId} agents={agents} onChange={onAgentChange} />
      {isGitRepo && (
        <TogglePill
          value={isolatedWorktree}
          onChange={onIsolatedWorktreeChange}
          label="Worktree"
          icon={<GitBranch className="size-3 shrink-0" />}
        />
      )}
      <TogglePill
        value={autoApprove}
        onChange={onAutoApproveChange}
        label="Auto-approve"
        icon={<Shield className="size-3 shrink-0" />}
        activeIcon={<ShieldOff className="size-3 shrink-0" />}
      />
    </div>
  );
}
