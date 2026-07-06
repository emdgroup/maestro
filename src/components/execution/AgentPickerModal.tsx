import { useState } from "react";
import { useKanban } from "@/contexts/KanbanContext";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useProjectSettings, useUpdateProjectSettings } from "@/services/project.service";
import { useUpdateTask } from "@/services/task.service";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { cn } from "@/lib/utils.ts";
import type { Task } from "@/types/bindings";

interface AgentPickerModalProps {
  open: boolean;
  task: Task;
  proceed: (agentId: string) => void;
  onClose: () => void;
}

export function AgentPickerModal({ open, task, proceed, onClose }: AgentPickerModalProps) {
  const { projectId, connection } = useKanban();
  const { data: discovery } = useAgentDiscoveryQuery(connection);
  const { data: projectSettings } = useProjectSettings(projectId ?? undefined);
  const updateSettings = useUpdateProjectSettings();
  const updateTask = useUpdateTask();
  const [selected, setSelected] = useState<string | null>(null);
  const [saveAsDefault, setSaveAsDefault] = useState(true);

  const agents = discovery?.agents ?? [];

  function handleApply() {
    if (!selected) return;
    updateTask.mutate({ taskId: task.id, updates: { agent_id: selected } });
    if (saveAsDefault && projectId) {
      updateSettings.mutate({
        projectId,
        config: {
          default_agent: selected,
          reopen_sessions: projectSettings?.reopen_sessions ?? null,
          startup_tab: projectSettings?.startup_tab ?? null,
        },
      });
    }
    proceed(selected);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="w-80">
        <DialogHeader>
          <DialogTitle>Choose an agent</DialogTitle>
          <DialogDescription>
            No default agent set. Pick one to run "{task.title}".
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => setSelected(agent.id)}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors",
                selected === agent.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-muted",
              )}
            >
              <div className="size-7 rounded-full overflow-hidden shrink-0 flex items-center justify-center bg-muted">
                {hasBrandIcon(agent.id) ? (
                  <BrandIcon slug={agent.id} className="size-5" />
                ) : (
                  <span className="text-[10px] font-bold uppercase">{agent.name[0]}</span>
                )}
              </div>
              <span className="text-xs font-medium">{agent.name}</span>
            </button>
          ))}
          {agents.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">No agents discovered</p>
          )}
        </div>

        <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-foreground">
          <Checkbox
            checked={saveAsDefault}
            onCheckedChange={(checked) => setSaveAsDefault(checked === true)}
          />
          Set as default for this project
        </label>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={!selected}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
