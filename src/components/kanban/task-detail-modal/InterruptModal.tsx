import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { useInterruptTaskMutation, useCancelTaskMutation } from "@/services/task.service";
import { useActiveSessionsQuery } from "@/services/execution.service";
import { useSelectedProject } from "@/store/projectStore";
import { api } from "@/lib/tauri-utils";

interface InterruptModalProps {
  open: boolean;
  onClose: () => void;
  taskId: number;
}

export function InterruptModal({ open, onClose, taskId }: InterruptModalProps) {
  const interruptTask = useInterruptTaskMutation();
  const cancelTask = useCancelTaskMutation();
  const selectedProject = useSelectedProject();
  const { data: sessions = [] } = useActiveSessionsQuery(selectedProject?.id);

  function handleResume() {
    const session = sessions.find((s) => s.task_id === taskId);
    if (session) {
      void api.sendAcpPrompt(session.session_key, "resume");
    }
    onClose();
  }

  function handleRework() {
    interruptTask.mutate(taskId, { onSuccess: onClose });
  }

  function handleCancel() {
    cancelTask.mutate(taskId, { onSuccess: onClose });
  }

  const isPending = interruptTask.isPending || cancelTask.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Interrupt the working agent?</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleResume} disabled={isPending}>
            Resume Work
          </Button>
          <Button variant="secondary" onClick={handleRework} disabled={isPending}>
            Rework
          </Button>
          <Button variant="destructive" onClick={handleCancel} disabled={isPending}>
            Cancel Task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
