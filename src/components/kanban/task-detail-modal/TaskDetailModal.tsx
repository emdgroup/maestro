import { useState, useRef, useEffect, type SetStateAction } from "react";
import { Ban, Repeat, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { LoopTab } from "@/components/kanban/loop/LoopTab";
import { LoopSidePanel } from "@/components/kanban/loop/LoopSidePanel";
import { LoopChangesTab, LoopNotesTab } from "@/components/kanban/loop/LoopWorkTabs";
import { LoopActions } from "@/components/kanban/loop/LoopActions";
import {
  LoopDetailsSection,
  type LoopDetailsHandle,
} from "@/components/kanban/loop/LoopDetailsSection";
import { CreateTaskModal } from "@/components/kanban/create-task-modal/CreateTaskModal";
import { useNavigate } from "@/store/navigationStore";
import type {
  BranchMode,
  Task,
  TaskStatus,
  TaskPriority,
  WorkspaceMode,
  WorktreeWithStatus,
} from "@/types/bindings";
import { MAESTRO_BRANCH_PREFIX, taskBranchName } from "@/lib/generateSessionName";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";
import { IssueTypeChip } from "@/components/kanban/shared/IssueTypeChip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Dialog, DialogContent, DialogTitle, DialogHeader } from "@/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/ui/tabs";
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
  useTaskCommentsQuery,
} from "@/services/task.service";
import { useSelectedProject, useIsGitRepo } from "@/store/projectStore";
import { useNavigationActions } from "@/store/navigationStore";
import { useIsTaskEditable } from "@/hooks/useIsTaskEditable";
import { useTaskHold } from "@/hooks/useTaskHold";
import { useShortcuts } from "@/hooks/useShortcuts";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { EditableField } from "./EditableField";
import { useDraggableFileInput } from "@/components/kanban/shared/useFileInput";
import { DescriptionWithAttachments } from "@/components/kanban/shared/DescriptionWithAttachments";
import { AttachmentSection } from "./AttachmentSection";
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

/**
 * Everywhere the user may send a task by hand.
 *
 * Only the two columns a task sits in before it runs. Everything past that point is reached by
 * an action rather than by re-filing: InProgress by Execute, Review by an agent finishing,
 * Done by Approve, Cancelled by its own button. Offering them here let the picker assert things
 * no action had made true — most visibly, re-selecting Review on a task already in Review
 * applies `ManualMove`, which parks it and strips the phase and ball off a live review.
 *
 * This does still let a cancelled task be re-filed to Planning, which is how restoring from the
 * archive works.
 */
const SELECTABLE_STATUSES = new Set<TaskStatus>(["Planning", "Queue"]);

/**
 * Done is terminal: view the outcome and archive it, nothing else. A task an agent is currently
 * working in is locked for the same reason the card cannot be dragged — re-filing applies
 * `ManualMove`, which parks the task and orphans the session still running against it.
 */
const STATUS_IS_LOCKED = (task: Task) =>
  task.status === "Done" || task.phase_status === "Running" || task.phase_status === "Blocked";

interface TaskDraft {
  title: string;
  description: string;
  priority: TaskPriority;
  workspaceMode: WorkspaceMode;
  workspaceWorktreeId: number | null;
  baseBranch: string;
  branchMode: BranchMode;
  /** The part after `maestro/`. Empty keeps the name generated from the task at spawn. */
  branchSuffix: string;
  labels: string[];
}

type Tab = "loop" | "details" | "changes" | "notes" | "outcome";

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

  // Same query key `OutcomeThread` uses, so the count on the tab costs no extra call.
  const { data: comments = [] } = useTaskCommentsQuery(projectId, taskId ?? undefined);

  const [tab, setTab] = useState<Tab>("details");
  const isLoop = task?.run_mode === "Loop";

  // A different task opens onto its first tab, whatever tab the last one was left on: a loop's is
  // the loop itself.
  useEffect(() => {
    setTab(isLoop ? "loop" : "details");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const loopDetails = useRef<LoopDetailsHandle>(null);
  const [loopDirty, setLoopDirty] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const navigate = useNavigate();

  const { setActiveTaskId } = useNavigationActions();

  const isEditable = useIsTaskEditable(taskId);

  // Held while the modal is open, so auto-mode cannot start the task the user is halfway through
  // rewriting — the agent would be given a prompt the user had already moved on from.
  useTaskHold(projectId, taskId, taskId !== null);

  const [draft, setDraft] = useState<TaskDraft>({
    title: "",
    description: "",
    priority: "None",
    workspaceMode: "NewWorktree",
    workspaceWorktreeId: null,
    baseBranch: "",
    branchMode: "Create",
    branchSuffix: "",
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
        branchMode: task.workspace_branch_mode,
        // Stored with the prefix, edited without it.
        branchSuffix: task.workspace_branch?.replace(MAESTRO_BRANCH_PREFIX, "") ?? "",
        labels: task.labels ?? [],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  function markDirtySetDraft(updater: SetStateAction<TaskDraft>) {
    isDirty.current = true;
    setDraft(updater);
  }

  // No description line any more: the attachment list below is the record, and a line the user
  // could delete without detaching anything only made the description look like the registry.
  const { pickFiles, isDragging } = useDraggableFileInput(
    isEditable ?? false,
    (filename, filePath) =>
      addAttachmentRef.current.mutate({
        projectId: task!.project_id,
        taskId: task!.id,
        filename,
        filePath,
      }),
  );

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  function handleRequestClose() {
    if ((isEditable && isDirty.current) || loopDirty) {
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
      if ((isEditable || loopDirty) && task) void handleSave();
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
    updateTask.mutate({
      projectId: task.project_id,
      taskId: task.id,
      updates: { status: newStatus as TaskStatus },
    });
  }

  async function handleSave() {
    if (!task || draft.title.trim().length < 3) return;
    try {
      await loopDetails.current?.save();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!isEditable) {
      setActiveTaskId(null);
      return;
    }
    updateTask.mutate(
      {
        projectId: task.project_id,
        taskId: task.id,
        updates: {
          title: draft.title.trim(),
          description: draft.description || null,
          priority: draft.priority,
          // A non-git project offers no workspace choice, so it can only be the project directory.
          workspace_mode: isGitRepo ? draft.workspaceMode : "RepositoryDirectory",
          workspace_worktree_id: draft.workspaceWorktreeId ?? undefined,
          workspace_branch_mode: draft.branchMode,
          workspace_branch: draft.branchSuffix.trim()
            ? `${MAESTRO_BRANCH_PREFIX}${draft.branchSuffix.trim()}`
            : undefined,
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
        // Fixed rather than sized to content: with the body in tabs, `w-fit`/`max-h` resized and
        // re-centred the whole dialog on every tab click, because the two panels do not measure
        // the same. The description is `flex-1`, so the fixed height is spent on it.
        className="sm:w-320 sm:max-w-[90vw] h-[85vh] flex flex-col p-0 gap-0 overflow-hidden"
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
              {isLoop && (
                <span className="flex items-center gap-1 rounded bg-accent/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                  <Repeat className="size-3" />
                  Loop
                </span>
              )}
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
            <div className="flex flex-1 min-h-0">
              <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as Tab)}
                className="flex-1 min-w-0 min-h-0 px-6 py-4 gap-4"
              >
                <TabsList variant="line" className="shrink-0">
                  {isLoop && <TabsTrigger value="loop">Loop</TabsTrigger>}
                  <TabsTrigger value="details">Details</TabsTrigger>
                  {isLoop && <TabsTrigger value="changes">Changes</TabsTrigger>}
                  {isLoop && <TabsTrigger value="notes">Agent notes</TabsTrigger>}
                  <TabsTrigger value="outcome">
                    Outcome{comments.length > 0 ? ` (${comments.length})` : ""}
                  </TabsTrigger>
                </TabsList>

                {isLoop && (
                  <TabsContent value="loop" className="min-h-0 overflow-y-auto pr-1">
                    <LoopTab
                      task={task}
                      onEditChecks={() => setTab("details")}
                      onJoin={() => {
                        setActiveTaskId(null);
                        navigate({ agentId: String(task.id) });
                      }}
                    />
                  </TabsContent>
                )}
                {isLoop && (
                  <TabsContent value="changes" className="min-h-0 overflow-y-auto pr-1">
                    <LoopChangesTab task={task} />
                  </TabsContent>
                )}
                {isLoop && (
                  <TabsContent value="notes" className="min-h-0 overflow-y-auto pr-1">
                    <LoopNotesTab task={task} />
                  </TabsContent>
                )}

                {/* `keepMounted`, on both panels, because the editors here commit on blur: an
                  unmounted panel never blurs, so a tab click mid-edit would drop what was typed. */}
                <TabsContent
                  value="details"
                  keepMounted
                  className={cn("flex flex-col min-h-0 gap-4", isLoop && "overflow-y-auto pr-1")}
                >
                  {/* A Planning pipeline task can still become a loop: nothing has run yet. */}
                  {!isLoop && task.status === "Planning" && task.phase == null && (
                    <div className="flex shrink-0 items-start gap-3 rounded-md border border-border bg-accent/8 p-3 text-xs">
                      <Repeat className="mt-0.5 size-4 shrink-0 text-accent" />
                      <div className="flex-1 space-y-1">
                        <div className="font-medium">Run as a loop instead</div>
                        <div className="text-muted-foreground">
                          The agent iterates in fresh sessions until checks you define, and it
                          cannot see, pass.
                        </div>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => setConvertOpen(true)}>
                        <Repeat className="size-3" />
                        Make it a loop
                      </Button>
                    </div>
                  )}
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
                    placeholder="Add a description..."
                  />

                  {/* Attachments */}
                  {projectId !== null && (
                    <div className="shrink-0">
                      <AttachmentSection
                        taskId={task.id}
                        projectId={projectId}
                        isEditable={isEditable ?? false}
                        onPickFiles={pickFiles}
                        isDragging={isDragging}
                      />
                    </div>
                  )}

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
                        onBaseBranchChange={(b) =>
                          markDirtySetDraft((d) => ({ ...d, baseBranch: b }))
                        }
                        branchMode={draft.branchMode}
                        onBranchModeChange={(m) =>
                          markDirtySetDraft((d) => ({ ...d, branchMode: m }))
                        }
                        branchSuffix={draft.branchSuffix}
                        onBranchSuffixChange={(s) =>
                          markDirtySetDraft((d) => ({ ...d, branchSuffix: s }))
                        }
                        generatedBranchSuffix={taskBranchName(task.id, task.title).replace(
                          MAESTRO_BRANCH_PREFIX,
                          "",
                        )}
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
                  {isLoop && (
                    <LoopDetailsSection
                      ref={loopDetails}
                      task={task}
                      onDirtyChange={setLoopDirty}
                    />
                  )}
                </TabsContent>

                {/* The only record a Done or archived task has: once the session closes, its
                  transcript is gone and this is what remains. */}
                <TabsContent value="outcome" keepMounted className="flex flex-col min-h-0">
                  <OutcomeThread projectId={task.project_id} taskId={task.id} />
                </TabsContent>
              </Tabs>
              {isLoop && (tab === "loop" || tab === "changes") && (
                <LoopSidePanel
                  task={task}
                  onJoin={() => {
                    setActiveTaskId(null);
                    navigate({ agentId: String(task.id) });
                  }}
                />
              )}
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
                            deleteTask.mutate(
                              { projectId: task.project_id, taskId: task.id },
                              {
                                onSuccess: () => setActiveTaskId(null),
                              },
                            );
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
                          It leaves the board and moves to the archive. Nothing on disk is touched:
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
                            cancelTask.mutate(
                              { projectId: task.project_id, taskId: task.id },
                              {
                                onSuccess: () => setActiveTaskId(null),
                              },
                            );
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

              {isLoop && (
                <LoopActions
                  task={task}
                  onEditChecks={() => setTab("details")}
                  onJoin={() => {
                    setActiveTaskId(null);
                    navigate({ agentId: String(task.id) });
                  }}
                />
              )}

              {(isEditable || loopDirty) && (
                <Button
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={updateTask.isPending || draft.title.trim().length < 3}
                >
                  {updateTask.isPending ? "Saving..." : "Save"}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
      {task && !isLoop && projectId !== null && (
        <CreateTaskModal
          isOpen={convertOpen}
          onClose={() => setConvertOpen(false)}
          projectId={projectId}
          convert={task}
        />
      )}
    </Dialog>
  );
};
