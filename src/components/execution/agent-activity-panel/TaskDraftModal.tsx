import { toast } from "sonner";
import { CreateTaskModal } from "@/components/kanban/create-task-modal/CreateTaskModal";
import { useNavigationStore } from "@/store/navigationStore";
import type { TaskDraft } from "../activity/task-draft";

/** A task drafted from something the agent wrote, and a toast that opens it once created. */
export function TaskDraftModal({
  draft,
  projectId,
  onClose,
}: {
  draft: TaskDraft | null;
  projectId: number;
  onClose: () => void;
}) {
  return (
    <CreateTaskModal
      isOpen={!!draft}
      onClose={onClose}
      projectId={projectId}
      initial={draft ?? undefined}
      onCreated={(task) => {
        toast.success(`Task created: ${task.title}`, {
          action: {
            label: "Open",
            onClick: () => {
              useNavigationStore.getState().setActiveTab("kanban");
              useNavigationStore.getState().setActiveTaskId(task.id);
            },
          },
        });
      }}
    />
  );
}
