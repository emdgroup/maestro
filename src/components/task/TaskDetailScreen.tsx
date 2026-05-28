import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Sparkles, Pause, Zap, Trash2, Archive, X, Paperclip, Upload } from "lucide-react";
import type { TaskStatus, TaskAttachment } from "@/types/bindings";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/ui/dialog";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  useTasksQuery,
  useUpdateTask,
  useInterruptTaskMutation,
  useCancelTaskMutation,
  useArchiveTaskMutation,
  useDeleteTaskMutation,
  useAddTaskAttachmentMutation,
  useRemoveTaskAttachmentMutation,
  useTaskAttachmentsQuery,
} from "@/services/task.service";
import { useActiveSessionsQuery } from "@/services/execution.service";
import { api } from "@/lib/tauri-utils";
import { useSelectedProject } from "@/store/projectStore";
import { useNavigationActions, useNavigate } from "@/store/navigationStore";
import { PAGE_TRANSITION_DURATION, PAGE_TRANSITION_EASING } from "@/utils/constants/animations";

// ---------------------------------------------------------------------------
// EditableField — seamless contenteditable with hover/focus ring
// ---------------------------------------------------------------------------

interface EditableFieldProps {
  value: string;
  onSave: (v: string) => void;
  isEditable: boolean;
  placeholder?: string;
  className?: string;
}

function EditableField({
  value,
  onSave,
  isEditable,
  placeholder = "",
  className,
}: EditableFieldProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isEditingRef = useRef(false);

  useEffect(() => {
    if (ref.current && !isEditingRef.current) {
      ref.current.innerText = value;
    }
  }, [value]);

  return (
    <div
      ref={ref}
      contentEditable={isEditable}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onFocus={() => {
        isEditingRef.current = true;
      }}
      onBlur={() => {
        isEditingRef.current = false;
        const text = ref.current?.innerText.trim() ?? "";
        if (text !== value) onSave(text);
      }}
      className={cn(
        "outline-none rounded px-1 min-h-[1.5em]",
        isEditable && "hover:ring-1 hover:ring-border focus:ring-1 focus:ring-ring cursor-text",
        !isEditable && "cursor-default",
        "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground",
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// InterruptModal — three-choice interrupt dialog
// ---------------------------------------------------------------------------

interface InterruptModalProps {
  open: boolean;
  onClose: () => void;
  taskId: number;
}

function InterruptModal({ open, onClose, taskId }: InterruptModalProps) {
  const interruptTask = useInterruptTaskMutation();
  const cancelTask = useCancelTaskMutation();
  const { data: sessions = [] } = useActiveSessionsQuery();

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

// ---------------------------------------------------------------------------
// Attachment helpers
// ---------------------------------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// DeleteConfirmButton — AlertDialog for delete confirmation
// ---------------------------------------------------------------------------

interface DeleteConfirmButtonProps {
  isPending: boolean;
  onConfirm: () => void;
}

function DeleteConfirmButton({ isPending, onConfirm }: DeleteConfirmButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-destructive hover:text-destructive"
        disabled={isPending}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-4" />
      </Button>
      <AlertDialog open={open} onOpenChange={(isOpen) => setOpen(isOpen)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setOpen(false)}>Keep Task</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Delete Task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Status constants
// ---------------------------------------------------------------------------

const ALL_STATUSES: TaskStatus[] = ["Backlog", "Ready", "InProgress", "Review", "Done"];
const SELECTABLE_STATUSES = new Set<TaskStatus>(["Backlog", "Ready"]);

// ---------------------------------------------------------------------------
// TaskDetailScreen — main component
// ---------------------------------------------------------------------------

interface TaskDetailScreenProps {
  taskId: number;
}

export const TaskDetailScreen: React.FC<TaskDetailScreenProps> = ({ taskId }) => {
  const selectedProject = useSelectedProject();
  const projectId = selectedProject?.id ?? null;

  const { data: tasks } = useTasksQuery(projectId);
  const task = (tasks ?? []).find((t) => t.id === taskId) ?? null;

  const { data: attachments = [] } = useTaskAttachmentsQuery(taskId);

  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTaskMutation();
  const archiveTask = useArchiveTaskMutation();
  const addAttachment = useAddTaskAttachmentMutation();
  const removeAttachment = useRemoveTaskAttachmentMutation();

  const { setActiveTaskId } = useNavigationActions();
  const navigate = useNavigate();

  const [isInterruptOpen, setIsInterruptOpen] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  if (task === null) {
    return (
      <div className="absolute inset-0 bg-background flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Task not found</p>
        <Button variant="outline" onClick={() => setActiveTaskId(null)}>
          Back to board
        </Button>
      </div>
    );
  }

  const isEditable = task.status === "Backlog";
  const showInterrupt = task.status === "InProgress";
  const showExecution = task.status === "InProgress" || task.status === "Review";
  const isPendingDeleteOrArchive = deleteTask.isPending || archiveTask.isPending;

  function handleTitleSave(newTitle: string) {
    if (!newTitle) return;
    updateTask.mutate({ taskId: task!.id, updates: { title: newTitle } });
  }

  function handleDescriptionSave(newDesc: string) {
    updateTask.mutate({ taskId: task!.id, updates: { description: newDesc } });
  }

  function handleStatusChange(newStatus: string | null) {
    if (!newStatus) return;
    if (newStatus === "Ready" && !task!.agent_id) {
      setAgentError("Assign an agent before marking as Ready.");
      return;
    }
    setAgentError(null);
    updateTask.mutate({
      taskId: task!.id,
      updates: { status: newStatus as TaskStatus },
    });
  }

  async function handlePickFile() {
    const selected = await openFilePicker({ multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const filePath of paths) {
      const filename = filePath.slice(
        Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1,
      );
      addAttachment.mutate({ taskId: task!.id, filename, filePath, fileSize: 0 });
    }
  }

  useEffect(() => {
    if (!isEditable || !task) return;
    const taskId = task.id;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        setIsDragOver(false);
        for (const filePath of event.payload.paths) {
          const filename = filePath.split(/[/\\]/).pop() ?? filePath;
          addAttachment.mutate({ taskId, filename, filePath, fileSize: 0 });
        }
      }
      if (event.payload.type === "leave") {
        setIsDragOver(false);
      }
    });
    return () => {
      unlisten.then((fn: () => void) => fn());
    };
  }, [isEditable, task?.id]);

  return (
    <TooltipProvider>
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING }}
        className="absolute inset-0 bg-background flex flex-col z-10"
      >
        {/* ---------------------------------------------------------------- */}
        {/* Action bar                                                         */}
        {/* ---------------------------------------------------------------- */}
        <div className="h-12 border-b border-border flex items-center px-4 gap-2 shrink-0">
          <span className="text-sm max-w-xs truncate text-muted-foreground">{task.title}</span>
          <div className="flex-1" />

          {/* Improve — stub, always disabled */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon" disabled>
                  <Sparkles className="size-4" />
                </Button>
              }
            />
            <TooltipContent>Improve task (coming soon)</TooltipContent>
          </Tooltip>

          {/* Interrupt — InProgress only */}
          {showInterrupt && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon" onClick={() => setIsInterruptOpen(true)}>
                    <Pause className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Interrupt agent</TooltipContent>
            </Tooltip>
          )}

          {/* Execution — InProgress or Review */}
          {showExecution && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => navigate({ agentId: String(task.id) })}
                  >
                    <Zap className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>View agent session</TooltipContent>
            </Tooltip>
          )}

          {/* Delete (status !== Done) — DeleteConfirmButton manages its own AlertDialog */}
          {task.status !== "Done" && (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex items-center" />}>
                <DeleteConfirmButton
                  isPending={isPendingDeleteOrArchive}
                  onConfirm={() => {
                    deleteTask.mutate(task.id, {
                      onSuccess: () => setActiveTaskId(null),
                    });
                  }}
                />
              </TooltipTrigger>
              <TooltipContent>Delete task</TooltipContent>
            </Tooltip>
          )}

          {/* Archive (status === Done) */}
          {task.status === "Done" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground"
                    disabled={isPendingDeleteOrArchive}
                    onClick={() =>
                      archiveTask.mutate(task.id, {
                        onSuccess: () => setActiveTaskId(null),
                      })
                    }
                  >
                    <Archive className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Archive task</TooltipContent>
            </Tooltip>
          )}

          {/* Close */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon" onClick={() => setActiveTaskId(null)}>
                  <X className="size-4" />
                </Button>
              }
            />
            <TooltipContent>Back to board</TooltipContent>
          </Tooltip>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Locked banner                                                       */}
        {/* ---------------------------------------------------------------- */}
        {!isEditable && (
          <div className="bg-muted/30 py-1 px-6 text-xs text-muted-foreground border-b border-border">
            Read-only — task is {task.status}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Content area                                                        */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex flex-1 overflow-hidden">
          {/* Main content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* Title */}
            <EditableField
              value={task.title}
              onSave={handleTitleSave}
              isEditable={isEditable}
              placeholder="Add a title..."
              className="text-xl font-semibold"
            />

            {/* Description */}
            <EditableField
              value={task.description ?? ""}
              onSave={handleDescriptionSave}
              isEditable={isEditable}
              placeholder="Add a description..."
              className="min-h-[100px] text-sm text-muted-foreground leading-relaxed"
            />

            {/* Attachments */}
            <div className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Paperclip className="size-4" />
                Attachments
              </h3>

              {attachments.length === 0 && (
                <p className="text-xs text-muted-foreground">No attachments</p>
              )}

              {attachments.length > 0 && (
                <ul className="space-y-1">
                  {attachments.map((att: TaskAttachment) => (
                    <li
                      key={att.id}
                      className="h-9 flex items-center gap-2 rounded-md border border-border bg-card px-3 text-sm"
                    >
                      <span className="flex-1 truncate text-foreground">{att.filename}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatFileSize(att.file_size)}
                      </span>
                      {isEditable && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          onClick={() =>
                            removeAttachment.mutate({
                              attachmentId: att.id,
                              taskId: att.task_id,
                            })
                          }
                          disabled={removeAttachment.isPending}
                        >
                          <X className="size-3" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {/* Dropzone — Backlog only */}
              {isEditable && (
                <div
                  className={cn(
                    "border-2 border-dashed rounded-lg p-4 text-center text-sm text-muted-foreground transition-colors",
                    isDragOver
                      ? "border-ring bg-muted/20"
                      : "border-border hover:border-muted-foreground/50",
                  )}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragOver(true);
                  }}
                  onDragLeave={() => setIsDragOver(false)}
                >
                  <Upload className="mx-auto mb-2 size-5 text-muted-foreground/60" />
                  <p>
                    Drop files here or{" "}
                    <button
                      className="text-foreground underline underline-offset-2 hover:text-primary"
                      onClick={handlePickFile}
                    >
                      browse
                    </button>
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* ---------------------------------------------------------------- */}
          {/* Right sidebar                                                     */}
          {/* ---------------------------------------------------------------- */}
          <div className="w-60 flex-shrink-0 border-l border-border overflow-y-auto p-4 space-y-4 bg-card">
            {/* Status */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Status</label>
              <Select value={task.status} onValueChange={handleStatusChange}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} disabled={!SELECTABLE_STATUSES.has(s)}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {agentError && <p className="text-xs text-destructive mt-1">{agentError}</p>}
            </div>

            {/* Priority */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Priority</label>
              {isEditable ? (
                <Select
                  value={task.priority}
                  onValueChange={(val) => {
                    if (!val) return;
                    updateTask.mutate({
                      taskId: task.id,
                      // val is string here matching TaskPriority values
                      updates: { priority: val as typeof task.priority },
                    });
                  }}
                >
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="None">None</SelectItem>
                    <SelectItem value="Low">Low</SelectItem>
                    <SelectItem value="Medium">Medium</SelectItem>
                    <SelectItem value="High">High</SelectItem>
                    <SelectItem value="Urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Badge variant="secondary">{task.priority ?? "None"}</Badge>
              )}
            </div>

            {/* Agent */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Agent</label>
              <p className="text-sm text-muted-foreground truncate">
                {task.agent_id ?? "Not assigned"}
              </p>
            </div>

            {/* Base Branch */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Base Branch</label>
              <p className="text-sm text-muted-foreground font-mono truncate">
                {task.base_branch ?? "None"}
              </p>
            </div>

            {/* Labels */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Labels</label>
              {task.labels && task.labels.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {task.labels.map((label) => (
                    <Badge key={label} variant="secondary" className="text-xs">
                      {label}
                      {isEditable && (
                        <button
                          className="ml-1 hover:text-destructive leading-none"
                          onClick={() => {
                            const newLabels = (task.labels ?? []).filter((l) => l !== label);
                            updateTask.mutate({
                              taskId: task.id,
                              updates: { labels: newLabels },
                            });
                          }}
                        >
                          ×
                        </button>
                      )}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">None</p>
              )}
            </div>

            {/* Auto-approve */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Auto-approve</label>
              {isEditable ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={task.auto_approve}
                    onChange={(e) =>
                      updateTask.mutate({
                        taskId: task.id,
                        updates: { auto_approve: e.target.checked },
                      })
                    }
                    className="size-4 rounded border border-input"
                  />
                  <span className="text-sm">{task.auto_approve ? "On" : "Off"}</span>
                </label>
              ) : (
                <Badge variant={task.auto_approve ? "default" : "secondary"}>
                  {task.auto_approve ? "On" : "Off"}
                </Badge>
              )}
            </div>

            {/* Worktree */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Worktree</label>
              {isEditable ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={task.isolated_worktree}
                    onChange={(e) =>
                      updateTask.mutate({
                        taskId: task.id,
                        updates: { isolated_worktree: e.target.checked },
                      })
                    }
                    className="size-4 rounded border border-input"
                  />
                  <span className="text-sm">{task.isolated_worktree ? "Isolated" : "Shared"}</span>
                </label>
              ) : (
                <Badge variant="secondary">{task.isolated_worktree ? "Isolated" : "Shared"}</Badge>
              )}
            </div>
          </div>
        </div>

        {/* Interrupt modal */}
        <InterruptModal
          open={isInterruptOpen}
          onClose={() => setIsInterruptOpen(false)}
          taskId={taskId}
        />
      </motion.div>
    </TooltipProvider>
  );
};
