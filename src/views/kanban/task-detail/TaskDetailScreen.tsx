import { useState, useRef, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { useShortcuts } from "@/utils/hooks/useShortcuts";
import { ShortcutHint } from "@/components/common/shortcut-hint/ShortcutHint";
import { DirtyWorktreeDialog } from "@/components/execution/DirtyWorktreeDialog";
import {
  Pause,
  Zap,
  Trash2,
  Archive,
  X,
  Paperclip,
  Upload,
  GitBranch,
  Shield,
  ShieldOff,
  Check,
  GitPullRequest,
} from "lucide-react";
import { commands } from "@/types/bindings";
import type { TaskStatus, TaskAttachment } from "@/types/bindings";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { TooltipProvider } from "@/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/ui/dialog";
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
  useDeleteTaskAttachmentMutation,
  useTaskAttachmentsQuery,
  useUpdateTaskSettingsMutation,
} from "@/services/task.service";
import { useActiveSessionsQuery, useAgentCacheQuery } from "@/services/execution.service";
import { api } from "@/lib/tauri-utils";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { useSelectedProject, useIsGitRepo } from "@/store/projectStore";
import { useNavigationActions, useNavigate } from "@/store/navigationStore";
import { useExecuteTask } from "@/utils/hooks/useExecuteTask";
import { PRIORITY_COLORS, PRIORITIES } from "@/utils/constants/priority";

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
// Attachment helpers
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

function isImageAttachment(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

function AttachmentThumbnail({
  attachment,
  projectId,
}: {
  attachment: TaskAttachment;
  projectId: number;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    commands.proxyImage(projectId, attachment.file_path).then((result) => {
      if (result.status === "ok") setSrc(result.data);
    });
  }, [projectId, attachment.file_path]);

  if (!src) {
    return <span className="w-20 h-20 bg-muted rounded-md animate-pulse" />;
  }

  return (
    <img
      src={src}
      alt={attachment.filename}
      className="w-20 h-20 object-cover rounded-md border border-border"
    />
  );
}

// ---------------------------------------------------------------------------
// DescriptionField — shows rendered markdown, switches to textarea on edit
// ---------------------------------------------------------------------------

interface DescriptionFieldProps {
  value: string;
  onSave: (v: string) => void;
  isEditable: boolean;
  placeholder?: string;
  projectId?: number;
}

function DescriptionField({
  value,
  onSave,
  isEditable,
  placeholder = "",
  projectId,
}: DescriptionFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value) onSave(trimmed);
  }, [draft, value, onSave]);

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className={cn(
          "w-full min-h-[120px] resize-none outline-none rounded px-1 py-0.5",
          "text-sm text-muted-foreground leading-relaxed",
          "ring-1 ring-ring bg-transparent",
        )}
      />
    );
  }

  if (value) {
    return (
      <div
        onClick={() => isEditable && setEditing(true)}
        className={cn(
          "rounded px-1 py-0.5 min-h-[1.5em] text-sm leading-relaxed",
          isEditable && "hover:ring-1 hover:ring-border cursor-text",
          !isEditable && "cursor-default",
        )}
      >
        <MarkdownBlock text={value} projectId={projectId} />
      </div>
    );
  }

  return (
    <div
      onClick={() => isEditable && setEditing(true)}
      className={cn(
        "rounded px-1 py-0.5 min-h-[1.5em] text-sm text-muted-foreground leading-relaxed",
        isEditable && "hover:ring-1 hover:ring-border cursor-text",
        !isEditable && "cursor-default",
      )}
    >
      {isEditable ? placeholder : ""}
    </div>
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
// Constants
// ---------------------------------------------------------------------------

const PILL = "flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-xs transition-colors";
const POPOVER_ITEM =
  "flex items-center gap-2 w-full px-2 py-1 text-xs rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors";

const ALL_STATUSES: TaskStatus[] = ["Backlog", "Ready", "InProgress", "Review", "Done"];
const SELECTABLE_STATUSES = new Set<TaskStatus>(["Backlog", "Ready"]);

// ---------------------------------------------------------------------------
// TaskDetailScreen — modal overlay
// ---------------------------------------------------------------------------

interface TaskDetailScreenProps {
  taskId: number | null;
  onReviewClick?: (taskId: number) => void;
}

export const TaskDetailScreen: React.FC<TaskDetailScreenProps> = ({ taskId, onReviewClick }) => {
  const selectedProject = useSelectedProject();
  const isGitRepo = useIsGitRepo();
  const projectId = selectedProject?.id ?? null;

  const { data: tasks } = useTasksQuery(projectId);
  const task = (tasks ?? []).find((t) => t.id === taskId) ?? null;

  const { data: attachments = [] } = useTaskAttachmentsQuery(taskId ?? 0);

  const updateTask = useUpdateTask();
  const updateTaskSettings = useUpdateTaskSettingsMutation();
  const deleteTask = useDeleteTaskMutation();
  const archiveTask = useArchiveTaskMutation();
  const addAttachment = useAddTaskAttachmentMutation();
  const addAttachmentRef = useRef(addAttachment);
  addAttachmentRef.current = addAttachment;
  const removeAttachment = useDeleteTaskAttachmentMutation();

  const connection = selectedProject
    ? connectionKeyFromProject(selectedProject)
    : { type: "local" as const };
  const { data: agentCache } = useAgentCacheQuery(task?.agent_id ?? null, connection);

  const { setActiveTaskId } = useNavigationActions();
  const navigate = useNavigate();

  const {
    execute,
    isExecuting,
    dirtyDialogOpen,
    dirtyModifiedCount,
    dirtyUntrackedCount,
    onDirtyChoice,
    onDirtyCancel,
  } = useExecuteTask(projectId, selectedProject?.path ?? "", connection);

  const [isInterruptOpen, setIsInterruptOpen] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [openPopover, setOpenPopover] = useState<string | null>(null);

  useShortcuts("taskDetail", {
    "task-back": () => {
      if (!task) return;
      if (document.querySelector('[role="alertdialog"]')) return;
      setActiveTaskId(null);
    },
    "task-delete": () => {
      if (task !== null && task.status !== "Done") setDeleteOpen(true);
    },
    "task-save": () => {
      if (!task) return;
      (document.activeElement as HTMLElement)?.blur();
    },
  });

  const isEditable = task?.status === "Backlog";

  function handleTitleSave(newTitle: string) {
    if (!newTitle || !task) return;
    updateTask.mutate({ taskId: task.id, updates: { title: newTitle } });
  }

  function handleDescriptionSave(newDesc: string) {
    if (!task) return;
    updateTask.mutate({ taskId: task.id, updates: { description: newDesc } });
  }

  function handleStatusChange(newStatus: string | null) {
    if (!newStatus || !task) return;
    if (newStatus === "Ready" && !task.agent_id) {
      setAgentError("Assign an agent before marking as Ready.");
      return;
    }
    setAgentError(null);
    updateTask.mutate({
      taskId: task.id,
      updates: { status: newStatus as TaskStatus },
    });
  }

  async function handlePickFile() {
    if (!task) return;
    try {
      const selected = await openFilePicker({ multiple: true });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const filePath of paths) {
        const filename = filePath.slice(
          Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1,
        );
        addAttachment.mutate({ taskId: task.id, filename, filePath });
      }
    } catch {
      toast.error("Failed to open file picker");
    }
  }

  useEffect(() => {
    if (!isEditable || !task) return;
    const currentTaskId = task.id;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        setIsDragOver(false);
        for (const filePath of event.payload.paths) {
          const filename = filePath.split(/[/\\]/).pop() ?? filePath;
          addAttachmentRef.current.mutate({ taskId: currentTaskId, filename, filePath });
        }
      }
      if (event.payload.type === "leave") {
        setIsDragOver(false);
      }
    });
    return () => {
      unlisten.then((fn: () => void) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditable, task?.id]);

  useEffect(() => {
    if (!isEditable || !task) return;
    const currentTaskId = task.id;

    async function handlePaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file" && items[i].type.startsWith("image/")) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length === 0) return;
      e.preventDefault();

      let pastedCount = 0;
      for (const file of imageFiles) {
        try {
          const mimeType = file.type || "image/png";
          const buffer = await file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          const base64Data = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
          const tempPath = await api.saveClipboardImage(base64Data, mimeType);
          const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
          const filename =
            pastedCount === 0 ? `Pasted image.${ext}` : `Pasted image (${pastedCount}).${ext}`;
          pastedCount += 1;
          addAttachmentRef.current.mutate({ taskId: currentTaskId, filename, filePath: tempPath });
        } catch {
          toast.error("Failed to paste image");
        }
      }
    }

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditable, task?.id]);

  const isPendingDeleteOrArchive = deleteTask.isPending || archiveTask.isPending;

  const modelOptions = agentCache?.config_options.find((o) => o.id === "model")?.options ?? [];
  const modeOptions = agentCache?.config_options.find((o) => o.id === "mode")?.options ?? [];

  return (
    <TooltipProvider>
      <Dialog
        open={taskId !== null}
        onOpenChange={(open) => {
          if (!open) setActiveTaskId(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="w-[90vw] max-w-[90vw] sm:w-[90vw] sm:max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden"
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
              {/* ---------------------------------------------------------- */}
              {/* Header: label + close                                         */}
              {/* ---------------------------------------------------------- */}
              <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-border shrink-0">
                <DialogTitle className="flex-1 text-sm font-medium">
                  {isEditable ? "Update task" : `Read only · ${task.status}`}
                </DialogTitle>
                <ShortcutHint shortcutId="task-back">
                  <DialogClose render={<Button variant="ghost" size="icon" className="shrink-0" />}>
                    <X className="size-4" />
                    <span className="sr-only">Close</span>
                  </DialogClose>
                </ShortcutHint>
              </div>

              {/* ---------------------------------------------------------- */}
              {/* Scrollable body                                               */}
              {/* ---------------------------------------------------------- */}
              <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5 space-y-6 min-h-0">
                {/* Title */}
                <EditableField
                  value={task.title}
                  onSave={handleTitleSave}
                  isEditable={isEditable}
                  placeholder="Add a title..."
                  className="text-xl font-semibold"
                />

                {/* Description */}
                <DescriptionField
                  value={task.description ?? ""}
                  onSave={handleDescriptionSave}
                  isEditable={isEditable ?? false}
                  placeholder="Add a description..."
                  projectId={projectId ?? undefined}
                />

                {/* Attachments */}
                <div className="space-y-3">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Paperclip className="size-3.5" />
                    Attachments
                  </h3>

                  {attachments.length === 0 && !isEditable && (
                    <p className="text-xs text-muted-foreground">No attachments</p>
                  )}

                  {attachments.length > 0 &&
                    (() => {
                      const imageAtts = attachments.filter((a: TaskAttachment) =>
                        isImageAttachment(a.filename),
                      );
                      const fileAtts = attachments.filter(
                        (a: TaskAttachment) => !isImageAttachment(a.filename),
                      );
                      return (
                        <div className="space-y-2">
                          {imageAtts.length > 0 && projectId && (
                            <div className="flex flex-wrap gap-2">
                              {imageAtts.map((att: TaskAttachment) => (
                                <div key={att.id} className="relative group">
                                  <AttachmentThumbnail attachment={att} projectId={projectId} />
                                  {isEditable && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-background border border-border opacity-0 group-hover:opacity-100 transition-opacity"
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
                                </div>
                              ))}
                            </div>
                          )}
                          {fileAtts.length > 0 && (
                            <ul className="space-y-1">
                              {fileAtts.map((att: TaskAttachment) => (
                                <li
                                  key={att.id}
                                  className="h-9 flex items-center gap-2 rounded-md border border-border bg-card px-3 text-sm"
                                >
                                  <span className="flex-1 truncate text-foreground">
                                    {att.filename}
                                  </span>
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
                        </div>
                      );
                    })()}

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

                {/* Metadata */}
                <div className="space-y-3 pt-2 border-t border-border">
                  <div className="flex flex-wrap gap-2">
                    {/* Status */}
                    <Popover
                      open={openPopover === "status"}
                      onOpenChange={(v) => setOpenPopover(v ? "status" : null)}
                    >
                      <PopoverTrigger
                        className={cn(
                          PILL,
                          "border-border bg-transparent text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {task.status}
                      </PopoverTrigger>
                      <PopoverContent className="w-36 p-1" align="start">
                        {ALL_STATUSES.filter((s) => isGitRepo || s !== "Review").map((s) => (
                          <button
                            key={s}
                            disabled={!SELECTABLE_STATUSES.has(s)}
                            onClick={() => {
                              handleStatusChange(s);
                              setOpenPopover(null);
                            }}
                            className={POPOVER_ITEM}
                          >
                            {s}
                            {task.status === s && <Check className="size-3 ml-auto" />}
                          </button>
                        ))}
                      </PopoverContent>
                    </Popover>

                    {/* Priority */}
                    {isEditable ? (
                      <Popover
                        open={openPopover === "priority"}
                        onOpenChange={(v) => setOpenPopover(v ? "priority" : null)}
                      >
                        <PopoverTrigger
                          className={cn(
                            PILL,
                            "border-border bg-transparent text-muted-foreground hover:bg-muted",
                          )}
                        >
                          <span
                            className="size-2 rounded-full shrink-0"
                            style={{ backgroundColor: PRIORITY_COLORS[task.priority] }}
                          />
                          {task.priority}
                        </PopoverTrigger>
                        <PopoverContent className="w-36 p-1" align="start">
                          {PRIORITIES.map((p) => (
                            <button
                              key={p}
                              onClick={() => {
                                updateTask.mutate({
                                  taskId: task.id,
                                  updates: { priority: p },
                                });
                                setOpenPopover(null);
                              }}
                              className={POPOVER_ITEM}
                            >
                              <span
                                className="size-2 rounded-full shrink-0"
                                style={{ backgroundColor: PRIORITY_COLORS[p] }}
                              />
                              {p}
                              {task.priority === p && <Check className="size-3 ml-auto" />}
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <span
                        className={cn(PILL, "border-border text-muted-foreground cursor-default")}
                      >
                        <span
                          className="size-2 rounded-full shrink-0"
                          style={{ backgroundColor: PRIORITY_COLORS[task.priority] }}
                        />
                        {task.priority}
                      </span>
                    )}

                    {/* Agent — always static */}
                    <span
                      className={cn(PILL, "border-border text-muted-foreground cursor-default")}
                    >
                      {task.agent_id ?? "No agent"}
                    </span>

                    {/* Model */}
                    {isEditable && modelOptions.length > 0 ? (
                      <Popover
                        open={openPopover === "model"}
                        onOpenChange={(v) => setOpenPopover(v ? "model" : null)}
                      >
                        <PopoverTrigger
                          className={cn(
                            PILL,
                            "border-border bg-transparent text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {task.model_override ?? "Default model"}
                        </PopoverTrigger>
                        <PopoverContent className="w-44 p-1" align="start">
                          <button
                            onClick={() => {
                              updateTaskSettings.mutate({
                                taskId: task.id,
                                config: { model_override: null },
                              });
                              setOpenPopover(null);
                            }}
                            className={POPOVER_ITEM}
                          >
                            Agent default
                            {!task.model_override && <Check className="size-3 ml-auto" />}
                          </button>
                          {modelOptions.map((m) => (
                            <button
                              key={m.value}
                              onClick={() => {
                                updateTaskSettings.mutate({
                                  taskId: task.id,
                                  config: { model_override: m.value },
                                });
                                setOpenPopover(null);
                              }}
                              className={POPOVER_ITEM}
                            >
                              {m.name}
                              {task.model_override === m.value && (
                                <Check className="size-3 ml-auto" />
                              )}
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>
                    ) : (task.model_override ?? !isEditable) ? (
                      <span
                        className={cn(PILL, "border-border text-muted-foreground cursor-default")}
                      >
                        {task.model_override ?? "Default model"}
                      </span>
                    ) : null}

                    {/* Permission Mode */}
                    {isEditable && modeOptions.length > 0 ? (
                      <Popover
                        open={openPopover === "mode"}
                        onOpenChange={(v) => setOpenPopover(v ? "mode" : null)}
                      >
                        <PopoverTrigger
                          className={cn(
                            PILL,
                            "border-border bg-transparent text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {task.permission_mode_override ?? "Default mode"}
                        </PopoverTrigger>
                        <PopoverContent className="w-44 p-1" align="start">
                          <button
                            onClick={() => {
                              updateTaskSettings.mutate({
                                taskId: task.id,
                                config: { permission_mode_override: null },
                              });
                              setOpenPopover(null);
                            }}
                            className={POPOVER_ITEM}
                          >
                            Agent default
                            {!task.permission_mode_override && <Check className="size-3 ml-auto" />}
                          </button>
                          {modeOptions.map((m) => (
                            <button
                              key={m.value}
                              onClick={() => {
                                updateTaskSettings.mutate({
                                  taskId: task.id,
                                  config: { permission_mode_override: m.value },
                                });
                                setOpenPopover(null);
                              }}
                              className={POPOVER_ITEM}
                            >
                              {m.name}
                              {task.permission_mode_override === m.value && (
                                <Check className="size-3 ml-auto" />
                              )}
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>
                    ) : (task.permission_mode_override ?? !isEditable) ? (
                      <span
                        className={cn(PILL, "border-border text-muted-foreground cursor-default")}
                      >
                        {task.permission_mode_override ?? "Default mode"}
                      </span>
                    ) : null}

                    {/* Worktree toggle (git only) */}
                    {isGitRepo &&
                      (isEditable ? (
                        <button
                          onClick={() =>
                            updateTask.mutate({
                              taskId: task.id,
                              updates: { isolated_worktree: !task.isolated_worktree },
                            })
                          }
                          className={cn(
                            PILL,
                            task.isolated_worktree
                              ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
                              : "border-border bg-transparent text-muted-foreground hover:bg-muted",
                          )}
                        >
                          <GitBranch className="size-3 shrink-0" />
                          {task.isolated_worktree ? "Isolated" : "Shared"} worktree
                        </button>
                      ) : (
                        <span
                          className={cn(
                            PILL,
                            task.isolated_worktree
                              ? "border-accent/40 bg-accent/10 text-accent"
                              : "border-border text-muted-foreground",
                            "cursor-default",
                          )}
                        >
                          <GitBranch className="size-3 shrink-0" />
                          {task.isolated_worktree ? "Isolated" : "Shared"} worktree
                        </span>
                      ))}

                    {/* Auto-approve toggle */}
                    {isEditable ? (
                      <button
                        onClick={() =>
                          updateTask.mutate({
                            taskId: task.id,
                            updates: { auto_approve: !task.auto_approve },
                          })
                        }
                        className={cn(
                          PILL,
                          task.auto_approve
                            ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
                            : "border-border bg-transparent text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {task.auto_approve ? (
                          <ShieldOff className="size-3 shrink-0" />
                        ) : (
                          <Shield className="size-3 shrink-0" />
                        )}
                        Auto-approve
                      </button>
                    ) : (
                      <span
                        className={cn(
                          PILL,
                          task.auto_approve
                            ? "border-accent/40 bg-accent/10 text-accent"
                            : "border-border text-muted-foreground",
                          "cursor-default",
                        )}
                      >
                        <Shield className="size-3 shrink-0" />
                        Auto-approve {task.auto_approve ? "on" : "off"}
                      </span>
                    )}

                    {/* Base Branch (git only, read-only) */}
                    {isGitRepo && task.base_branch && (
                      <span
                        className={cn(
                          PILL,
                          "border-border text-muted-foreground font-mono cursor-default",
                        )}
                      >
                        <GitBranch className="size-3 shrink-0" />
                        {task.base_branch}
                      </span>
                    )}
                  </div>

                  {agentError && <p className="text-xs text-destructive">{agentError}</p>}

                  {/* Labels */}
                  {task.labels && task.labels.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {task.labels.map((label) => (
                        <Badge key={label} variant="secondary" className="text-xs">
                          {label}
                          {isEditable && (
                            <button
                              className="ml-1 hover:text-destructive leading-none"
                              onClick={() =>
                                updateTask.mutate({
                                  taskId: task.id,
                                  updates: { labels: task.labels.filter((l) => l !== label) },
                                })
                              }
                            >
                              ×
                            </button>
                          )}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* ---------------------------------------------------------- */}
              {/* Footer: actions by status                                     */}
              {/* ---------------------------------------------------------- */}
              <div className="border-t border-border px-6 py-3 flex items-center gap-2 shrink-0">
                <div className="flex-1" />

                {/* Ready: Execute */}
                {task.status === "Ready" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void execute(task)}
                    disabled={isExecuting}
                  >
                    <Zap className="size-4" />
                    {isExecuting ? "Executing..." : "Execute"}
                  </Button>
                )}

                {/* InProgress: Interrupt + View session */}
                {task.status === "InProgress" && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setIsInterruptOpen(true)}>
                      <Pause className="size-4" />
                      Interrupt
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate({ agentId: String(task.id) })}
                    >
                      <Zap className="size-4" />
                      View session
                    </Button>
                  </>
                )}

                {/* Review: Review + View session */}
                {task.status === "Review" && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onReviewClick?.(task.id);
                        setActiveTaskId(null);
                      }}
                    >
                      <GitPullRequest className="size-4" />
                      Review
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate({ agentId: String(task.id) })}
                    >
                      <Zap className="size-4" />
                      View session
                    </Button>
                  </>
                )}

                {/* Done: Archive */}
                {task.status === "Done" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isPendingDeleteOrArchive}
                    onClick={() =>
                      archiveTask.mutate(task.id, { onSuccess: () => setActiveTaskId(null) })
                    }
                  >
                    <Archive className="size-4" />
                    Archive
                  </Button>
                )}

                {/* Non-Done: Delete task (explicit, right) */}
                {task.status !== "Done" && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
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
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {task && (
        <InterruptModal
          open={isInterruptOpen}
          onClose={() => setIsInterruptOpen(false)}
          taskId={task.id}
        />
      )}
      <DirtyWorktreeDialog
        open={dirtyDialogOpen}
        modifiedCount={dirtyModifiedCount}
        untrackedCount={dirtyUntrackedCount}
        onChoice={onDirtyChoice}
        onCancel={onDirtyCancel}
      />
    </TooltipProvider>
  );
};
