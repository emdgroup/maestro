import { useState, useRef, useEffect, type SetStateAction } from "react";
import { Ban, Trash2, X } from "lucide-react";
import type {
  Task,
  TaskStatus,
  TaskPriority,
  WorkspaceMode,
  WorktreeWithStatus,
} from "@/types/bindings";
import { Button } from "@/ui/button";
import { IssueTypeChip } from "@/components/kanban/shared/IssueTypeChip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
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
  useCancelTaskMutation,
  useDeleteTaskMutation,
  useAddTaskAttachmentMutation,
} from "@/services/task.service";
import { useSelectedProject, useIsGitRepo } from "@/store/projectStore";
import { useNavigationActions } from "@/store/navigationStore";
import { useIsTaskEditable } from "@/hooks/useIsTaskEditable";
import { useTaskHold } from "@/hooks/useTaskHold";
import { useShortcuts } from "@/hooks/useShortcuts";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { EditableField } from "./EditableField";
import {
  useDraggableFileInput,
  appendToAttachmentsSection,
} from "@/components/kanban/shared/useFileInput";
import { DescriptionWithAttachments } from "@/components/kanban/shared/DescriptionWithAttachments";
import { WorkspaceSelector } from "@/components/common/workspace-mode/WorkspaceSelector";
import { TaskMetadataPills } from "@/components/kanban/shared/TaskMetadataPills";
import { useWorktreesQuery } from "@/services/worktree.service";
import { OutcomeThread } from "./OutcomeThread";

// Cancelled has no board column, but a cancelled task can still be opened from the archive, and a
// picker showing nothing at all for it reads as a bug.
const ALL_STATUSES: TaskStatus[] = [
  "Planning",
  "Queue",
  "InProgress",
  "Review",
  "Done",
  "Cancelled",
];

/// Everywhere the user may send a task by hand.
///
/// Only the two columns a task sits in before it runs. Everything past that point is reached by
/// an action rather than by re-filing: InProgress by Execute, Review by an agent finishing,
/// Done by Approve, Cancelled by its own button. Offering them here let the picker assert things
/// no action had made true — most visibly, re-selecting Review on a task already in Review
/// applies `ManualMove`, which parks it and strips the phase and ball off a live review.
///
/// This does still let a cancelled task be re-filed to Planning, which is how restoring from the
/// archive works.
const SELECTABLE_STATUSES = new Set<TaskStatus>(["Planning", "Queue"]);

/// Done is terminal: view the outcome and archive it, nothing else. A task an agent is currently
/// working in is locked for the same reason the card cannot be dragged — re-filing applies
/// `ManualMove`, which parks the task and orphans the session still running against it.
const STATUS_IS_LOCKED = (task: Task) =>
  task.status === "Done" || task.phase_status === "Running" || task.phase_status === "Blocked";

interface TaskDraft {
  title: string;
  description: string;
  priority: TaskPriority;
  workspaceMode: WorkspaceMode;
  workspaceWorktreeId: number | null;
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

  const { data: tasks } = useTasksQuery(projectId);
  const task = (tasks ?? []).find((t) => t.id === taskId) ?? null;
  const { data: worktrees } = useWorktreesQuery(projectId ?? undefined, selectedProject?.path);

  const updateTask = useUpdateTask();
  const archiveTask = useArchiveTaskMutation();
  const cancelTask = useCancelTaskMutation();
  const deleteTask = useDeleteTaskMutation();
  const addAttachment = useAddTaskAttachmentMutation();
  const addAttachmentRef = useRef(addAttachment);
  addAttachmentRef.current = addAttachment;

  const { setActiveTaskId } = useNavigationActions();

  const isEditable = useIsTaskEditable(taskId);

  // Held while the modal is open, so auto-mode cannot start the task the user is halfway through
  // rewriting — the agent would be given a prompt the user had already moved on from.
  useTaskHold(taskId, taskId !== null);

  const [draft, setDraft] = useState<TaskDraft>({
    title: "",
    description: "",
    priority: "None",
    workspaceMode: "NewWorktree",
    workspaceWorktreeId: null,
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
        workspaceMode: task.workspace_mode,
        workspaceWorktreeId: task.workspace_worktree_id ?? null,
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

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
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
    // Re-picking the status a task is already in still applies `ManualMove`, which parks it —
    // clearing phase, phase_status and ball. On anything with live pipeline state that silently
    // throws it away, so a no-op selection has to stay a no-op.
    if (newStatus === task.status) return;
    // No agent check here any more. Which agent runs is decided per role by the project's profiles
    // at spawn time, so a task carries none to check — and a guard reading `task.agent_id` would
    // now refuse every move to Queue rather than the ones it was written for.
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
          // A non-git project offers no workspace choice, so it can only be the project directory.
          workspace_mode: isGitRepo ? draft.workspaceMode : "RepositoryDirectory",
          workspace_worktree_id: draft.workspaceWorktreeId ?? undefined,
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
              <Select
                value={task.status}
                onValueChange={handleStatusChange}
                disabled={STATUS_IS_LOCKED(task)}
              >
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

              {/* Workspace */}
              {isGitRepo && (
                <div className="shrink-0">
                  <WorkspaceSelector
                    mode={draft.workspaceMode}
                    onModeChange={(m) => markDirtySetDraft((d) => ({ ...d, workspaceMode: m }))}
                    baseBranch={draft.baseBranch}
                    onBaseBranchChange={(b) => markDirtySetDraft((d) => ({ ...d, baseBranch: b }))}
                    worktrees={worktrees ?? []}
                    repoPath={selectedProject?.path ?? ""}
                    selectedWorktreeId={draft.workspaceWorktreeId}
                    onSelectedWorktreeChange={(wt: WorktreeWithStatus | null) =>
                      markDirtySetDraft((d) => ({ ...d, workspaceWorktreeId: wt?.id ?? null }))
                    }
                    claimsOwnership
                    ownerTaskId={task.id}
                    readOnly={!isEditable}
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
                />
              </div>

              {/* The only record a Done or archived task has: once the session closes, its
                  transcript is gone and this is what remains. */}
              <OutcomeThread taskId={task.id} />
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

              {/* The way off the board that keeps the record. Delete destroys the task and is
                  hidden once it is Done; without this a task that should never have been started
                  had no exit at all from Review or Done. */}
              {task.status !== "Cancelled" && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={cancelTask.isPending}
                    onClick={() => setCancelOpen(true)}
                  >
                    <Ban className="size-4" />
                    Cancel task
                  </Button>
                  <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Cancel this task?</AlertDialogTitle>
                        <AlertDialogDescription>
                          It leaves the board and moves to the archive. Nothing on disk is touched —
                          any worktree and branch stay where they are.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel onClick={() => setCancelOpen(false)}>
                          Keep task
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => {
                            setCancelOpen(false);
                            cancelTask.mutate(task.id, {
                              onSuccess: () => setActiveTaskId(null),
                            });
                          }}
                        >
                          Cancel task
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
  );
};
