import { useState, useRef, useEffect, type SetStateAction } from "react";
import { Trash2, X } from "lucide-react";
import type { TaskStatus, TaskPriority } from "@/types/bindings";
import { Button } from "@/ui/button";
import { IssueTypeChip } from "@/components/kanban/shared/IssueTypeChip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { TooltipProvider } from "@/ui/tooltip";
import { Dialog, DialogContent, DialogTitle, DialogHeader } from "@/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import {
  useTasksQuery,
  useUpdateTask,
  useArchiveTaskMutation,
  useDeleteTaskMutation,
  useAddTaskAttachmentMutation,
} from "@/services/task.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { useSelectedProject, useIsGitRepo } from "@/store/projectStore";
import { useDefaultAgent } from "@/store/configStore";
import { useNavigationActions } from "@/store/navigationStore";
import { useIsTaskEditable } from "@/hooks/useIsTaskEditable";
import { useShortcuts } from "@/hooks/useShortcuts";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { EditableField } from "./EditableField";
import {
  useDraggableFileInput,
  appendToAttachmentsSection,
} from "@/components/kanban/shared/useFileInput";
import { DescriptionWithAttachments } from "@/components/kanban/shared/DescriptionWithAttachments";
import { BranchSection } from "@/components/kanban/shared/BranchSection";
import { TaskMetadataPills } from "@/components/kanban/shared/TaskMetadataPills";

const ALL_STATUSES: TaskStatus[] = ["Backlog", "Ready", "InProgress", "Review", "Done"];
const SELECTABLE_STATUSES = new Set<TaskStatus>(["Backlog", "Ready"]);

interface TaskDraft {
  title: string;
  description: string;
  priority: TaskPriority;
  agentId: string | null;
  isolatedWorktree: boolean;
  autoApprove: boolean;
  baseBranch: string;
  labels: string[];
}

interface TaskDetailModalProps {
  taskId: number | null;
}

export const TaskDetailModal = ({ taskId }: TaskDetailModalProps) => {
  const selectedProject = useSelectedProject();
  const isGitRepo = useIsGitRepo();
  const projectId = selectedProject?.id ?? null;
  const defaultAgent = useDefaultAgent();

  const { data: tasks } = useTasksQuery(projectId);
  const task = (tasks ?? []).find((t) => t.id === taskId) ?? null;

  const updateTask = useUpdateTask();
  const archiveTask = useArchiveTaskMutation();
  const deleteTask = useDeleteTaskMutation();
  const addAttachment = useAddTaskAttachmentMutation();
  const addAttachmentRef = useRef(addAttachment);
  addAttachmentRef.current = addAttachment;

  const connection = selectedProject
    ? connectionKeyFromProject(selectedProject)
    : { type: "local" as const };
  const { data: discovery } = useAgentDiscoveryQuery(connection);
  const agents = discovery?.agents ?? [];

  const { setActiveTaskId } = useNavigationActions();

  const isEditable = useIsTaskEditable(taskId);

  const [draft, setDraft] = useState<TaskDraft>({
    title: "",
    description: "",
    priority: "None",
    agentId: null,
    isolatedWorktree: true,
    autoApprove: false,
    baseBranch: "",
    labels: [],
  });

  const isDirty = useRef(false);

  // Reset dirty flag whenever a different task is opened.
  useEffect(() => {
    isDirty.current = false;
  }, [taskId]);

  // Sync draft from server when task data changes, but not while the user is editing.
  useEffect(() => {
    if (task && !isDirty.current) {
      setDraft({
        title: task.title,
        description: task.description ?? "",
        priority: task.priority,
        agentId: task.agent_id ?? null,
        isolatedWorktree: task.isolated_worktree,
        autoApprove: task.auto_approve,
        baseBranch: task.base_branch ?? "",
        labels: task.labels ?? [],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  function markDirtySetDraft(updater: SetStateAction<TaskDraft>) {
    isDirty.current = true;
    setDraft(updater);
  }

  const { pickFiles, isDragging } = useDraggableFileInput(
    isEditable ?? false,
    (filename, filePath) => {
      addAttachmentRef.current.mutate({ taskId: task!.id, filename, filePath });
      markDirtySetDraft((d) => ({
        ...d,
        description: appendToAttachmentsSection(d.description, filename),
      }));
    },
  );

  const [agentError, setAgentError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  function handleRequestClose() {
    if (isEditable && isDirty.current) {
      setDiscardOpen(true);
      return;
    }
    setActiveTaskId(null);
  }

  useShortcuts("taskDetail", {
    "task-back": () => {
      if (!task) return;
      if (document.querySelector('[role="alertdialog"]')) return;
      handleRequestClose();
    },
    "task-delete": () => {
      if (task !== null && task.status !== "Done") setDeleteOpen(true);
    },
    "task-save": () => {
      if (isEditable && task) handleSave();
    },
  });

  function handleStatusChange(newStatus: string | null) {
    if (!newStatus || !task) return;
    if (newStatus === "Ready" && !task.agent_id && !defaultAgent) {
      setAgentError("Assign an agent to this task, or set a project default in Settings.");
      return;
    }
    setAgentError(null);
    updateTask.mutate({ taskId: task.id, updates: { status: newStatus as TaskStatus } });
  }

  function handleSave() {
    if (!task || draft.title.trim().length < 3) return;
    updateTask.mutate(
      {
        taskId: task.id,
        updates: {
          title: draft.title.trim(),
          description: draft.description || null,
          priority: draft.priority,
          agent_id: draft.agentId,
          isolated_worktree: draft.isolatedWorktree,
          auto_approve: draft.autoApprove,
          base_branch: draft.baseBranch || undefined,
          labels: draft.labels,
        },
      },
      {
        onSuccess: () => {
          isDirty.current = false;
          setActiveTaskId(null);
        },
      },
    );
  }

  const isPendingDeleteOrArchive = deleteTask.isPending || archiveTask.isPending;

  return (
    <TooltipProvider>
      <Dialog
        open={taskId !== null}
        onOpenChange={(open) => {
          if (!open) handleRequestClose();
        }}
        disablePointerDismissal={isEditable ?? false}
      >
        <DialogContent
          showCloseButton={false}
          className="sm:w-fit sm:min-w-160 sm:max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden"
        >
          {task === null ? (
            <div className="flex flex-col items-center justify-center gap-4 py-16">
              <p className="text-muted-foreground">Task not found</p>
              <Button variant="outline" onClick={() => setActiveTaskId(null)}>
                Close
              </Button>
            </div>
          ) : (
            <>
              {/* Header */}
              <DialogHeader className="flex-row items-center gap-3 px-6 pt-3 shrink-0">
                <DialogTitle className="text-xs font-semibold tracking-widest uppercase text-foreground">
                  {isEditable ? "EDIT TASK" : "TASK DETAIL"}
                </DialogTitle>
                <div className="flex-1" />
                <Select value={task.status} onValueChange={handleStatusChange}>
                  <SelectTrigger size="sm" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_STATUSES.filter((s) => isGitRepo || s !== "Review").map((s) => (
                      <SelectItem key={s} value={s} disabled={!SELECTABLE_STATUSES.has(s)}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ShortcutHint shortcutId="task-back">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={handleRequestClose}
                  >
                    <X className="size-4" />
                    <span className="sr-only">Close</span>
                  </Button>
                </ShortcutHint>
              </DialogHeader>

              {/* Body */}
              <div className="flex-1 flex flex-col min-h-0 px-6 py-4 gap-4">
                <div className="shrink-0">
                  <EditableField
                    value={draft.title}
                    onSave={(v) => markDirtySetDraft((d) => ({ ...d, title: v }))}
                    isEditable={isEditable ?? false}
                    placeholder="Add a title..."
                    className="text-xl font-semibold"
                  />
                </div>

                {/* Description + attachment */}
                <DescriptionWithAttachments
                  value={draft.description}
                  onSave={(v) => markDirtySetDraft((d) => ({ ...d, description: v }))}
                  isEditable={isEditable ?? false}
                  isDragging={isDragging}
                  onPickFiles={pickFiles}
                  placeholder="Add a description..."
                />

                {/* Labels */}
                {draft.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1 shrink-0">
                    {draft.labels.map((label) => (
                      <IssueTypeChip
                        key={label}
                        type={label}
                        onRemove={
                          isEditable
                            ? () =>
                                markDirtySetDraft((d) => ({
                                  ...d,
                                  labels: d.labels.filter((l) => l !== label),
                                }))
                            : undefined
                        }
                      />
                    ))}
                  </div>
                )}

                {/* Branch */}
                {isGitRepo && (
                  <div className="shrink-0">
                    <BranchSection
                      value={draft.baseBranch}
                      onChange={
                        isEditable
                          ? (b) => markDirtySetDraft((d) => ({ ...d, baseBranch: b }))
                          : undefined
                      }
                    />
                  </div>
                )}

                {/* Metadata pills */}
                <div className="shrink-0 space-y-3 pt-2 border-t border-border">
                  <TaskMetadataPills
                    priority={draft.priority}
                    onPriorityChange={
                      isEditable
                        ? (p) => markDirtySetDraft((d) => ({ ...d, priority: p }))
                        : undefined
                    }
                    agentId={draft.agentId}
                    agents={agents}
                    onAgentChange={
                      isEditable
                        ? (id) => markDirtySetDraft((d) => ({ ...d, agentId: id }))
                        : undefined
                    }
                    isolatedWorktree={draft.isolatedWorktree}
                    onIsolatedWorktreeChange={
                      isEditable
                        ? (v) => markDirtySetDraft((d) => ({ ...d, isolatedWorktree: v }))
                        : undefined
                    }
                    autoApprove={draft.autoApprove}
                    onAutoApproveChange={
                      isEditable
                        ? (v) => markDirtySetDraft((d) => ({ ...d, autoApprove: v }))
                        : undefined
                    }
                    isGitRepo={isGitRepo ?? false}
                  />

                  {agentError && <p className="text-xs text-destructive">{agentError}</p>}
                </div>
              </div>

              {/* Footer */}
              <div className="border-t border-border px-6 py-3 flex items-center gap-2 shrink-0">
                {/* Left: delete */}
                {task.status !== "Done" && (
                  <>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={isPendingDeleteOrArchive}
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 className="size-4" />
                      Delete task
                    </Button>
                    <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this task?</AlertDialogTitle>
                          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel onClick={() => setDeleteOpen(false)}>
                            Keep Task
                          </AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() => {
                              setDeleteOpen(false);
                              deleteTask.mutate(task.id, {
                                onSuccess: () => setActiveTaskId(null),
                              });
                            }}
                          >
                            Delete Task
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </>
                )}

                <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Discard changes?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Your unsaved changes will be lost.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel onClick={() => setDiscardOpen(false)}>
                        Keep editing
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          setDiscardOpen(false);
                          setActiveTaskId(null);
                        }}
                      >
                        Discard
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <div className="flex-1" />

                {isEditable && (
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={updateTask.isPending || draft.title.trim().length < 3}
                  >
                    {updateTask.isPending ? "Saving..." : "Save"}
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};
