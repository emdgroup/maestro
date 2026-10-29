import { useState, useRef, useEffect } from "react";
import { useForm, useWatch, Controller } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Repeat, Workflow, X } from "lucide-react";
import { toast } from "sonner";
import { IssueTypeChip } from "@/components/kanban/shared/IssueTypeChip";
import {
  useCreateTaskMutation,
  useAddTaskAttachmentMutation,
  useListRemoteIssuesQuery,
} from "@/services/task.service";
import { useDefaultBaseBranch } from "@/hooks/useDefaultBaseBranch";
import { useProjectIssueTrackingConfig } from "@/services/integration.service";
import { useProjectSettings } from "@/services/project.service";
import { useIsGitRepo } from "@/store/projectStore";
import { EditableField } from "@/components/kanban/task-detail-modal/EditableField";
import { useDraggableFileInput } from "@/components/kanban/shared/useFileInput";
import { DescriptionWithAttachments } from "@/components/kanban/shared/DescriptionWithAttachments";
import { WorkspaceSelector } from "@/components/common/workspace-mode/WorkspaceSelector";
import { TaskMetadataPills } from "@/components/kanban/shared/TaskMetadataPills";
import { useWorktreesQuery } from "@/services/worktree.service";
import { useSelectedProject } from "@/store/projectStore";
import { MAESTRO_BRANCH_PREFIX, validateBranchSuffix } from "@/lib/generateSessionName";
import { findBranchConflict } from "@/components/common/workspace-mode/branch-conflict";
import type {
  BranchMode,
  RemoteIssue,
  RunMode,
  Task,
  TaskPriority,
  WorkspaceMode,
  WorktreeWithStatus,
} from "@/types/bindings";
import { IssueSearchCombobox } from "./IssueSearchCombobox";
import { PRIORITIES } from "@/utils/constants/priority";

interface FormData {
  baseBranch: string;
  priority: TaskPriority;
  workspaceMode: WorkspaceMode;
  workspaceWorktreeId: number | null;
  branchMode: BranchMode;
  /** The part after `maestro/`. Empty submits null, leaving the name generated at spawn. */
  branchSuffix: string;
}

interface PendingFile {
  filename: string;
  filePath: string;
}

interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
  /** Prefills title and description — used when a task is drafted from an agent's message. */
  initial?: { title: string; description: string };
  /** Called once the task exists, for callers that are not looking at the board. */
  onCreated?: (task: Task) => void;
}

export function CreateTaskModal({
  isOpen,
  onClose,
  projectId,
  initial,
  onCreated,
}: CreateTaskModalProps) {
  const isGitRepo = useIsGitRepo();

  const { data: issueConfig } = useProjectIssueTrackingConfig(projectId);
  const hasProvider = issueConfig != null;

  const { data: projectSettings } = useProjectSettings(projectId);
  const defaultWorkspaceMode: WorkspaceMode =
    projectSettings?.default_workspace_mode ?? "NewWorktree";

  // The project's configured default, or the branch the repository is on. BranchPicker fetches
  // the full list internally; this is only what the field starts out on.
  const defaultBaseBranch = useDefaultBaseBranch(isOpen ? projectId : null);

  const project = useSelectedProject();
  const { data: worktrees } = useWorktreesQuery(projectId, project?.path);

  const { mutate: createTask, isPending } = useCreateTaskMutation();
  // A loop is created bare: its checks are set up from its card, with Prepare loop or by hand.
  const [runMode, setRunMode] = useState<RunMode>("Pipeline");
  const addAttachment = useAddTaskAttachmentMutation();
  // Mirrored from an effect rather than assigned during render — read only by the
  // file-input callback below, which runs after commit.
  const addAttachmentRef = useRef(addAttachment);
  useEffect(() => {
    addAttachmentRef.current = addAttachment;
  });

  const [error, setError] = useState<string | null>(null);
  const [createAnother, setCreateAnother] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<RemoteIssue | null>(null);
  const issuePopupAnchor = useRef<HTMLSpanElement>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const { pickFiles, isDragging } = useDraggableFileInput(isOpen, (filename, filePath) => {
    // Read of this render's value, which is current: a picker or a drop never returns the same
    // path twice, so a duplicate can only come from a later action, after a commit.
    if (pendingFiles.some((f) => f.filePath === filePath)) {
      toast.info(`${filename} is already attached`);
      return;
    }
    // Functional update, not a read of the latest value: `pickFiles` calls this once per
    // selected file in a synchronous loop, so every file but the last would be dropped by
    // a snapshot taken before the batch.
    setPendingFiles((prev) => [...prev, { filename, filePath }]);
  });

  const { data: remoteIssues, isFetching: issuesFetching } = useListRemoteIssuesQuery(
    hasProvider ? projectId : null,
    isOpen && hasProvider,
  );

  const {
    handleSubmit,
    control,
    reset,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: {
      baseBranch: "",
      priority: "None",
      workspaceMode: defaultWorkspaceMode,
      workspaceWorktreeId: null,
      branchMode: "Create",
      branchSuffix: "",
    },
  });

  // `useWatch` rather than `watch`: the latter reads the form's mutable store during
  // render, which the compiler cannot track. Both re-render on change and both start
  // from the `defaultValues` above, so the values seen here are the same.
  const priority = useWatch({ control, name: "priority" });
  const workspaceMode = useWatch({ control, name: "workspaceMode" });
  const workspaceWorktreeId = useWatch({ control, name: "workspaceWorktreeId" });
  const branchMode = useWatch({ control, name: "branchMode" });
  const branchSuffix = useWatch({ control, name: "branchSuffix" });

  // Opening or closing the modal re-seeds the whole form. This component's own state is
  // adjusted during render so a reopened dialog never paints the previous task's fields;
  // react-hook-form's store is reset from the effect below, because `reset` writes state
  // owned by the library and doing that mid-render is not safe.
  const [openState, setOpenState] = useState(isOpen);
  if (openState !== isOpen) {
    setOpenState(isOpen);
    setTitle(isOpen ? (initial?.title ?? "") : "");
    setDescription(isOpen ? (initial?.description ?? "") : "");
    setRunMode("Pipeline");
    if (!isOpen) {
      setError(null);
      setSelectedIssue(null);
      setPendingFiles([]);
      setLabels([]);
    }
  }

  useEffect(() => {
    if (isOpen) {
      reset({
        baseBranch: defaultBaseBranch,
        priority: "None",
        workspaceMode: defaultWorkspaceMode,
        workspaceWorktreeId: null,
        branchMode: "Create",
        branchSuffix: "",
      });
    } else {
      reset();
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // The settings and branch queries may not have answered by the time the reset above runs, which
  // would leave the field empty on a first open. Same late fill the session dialog does, and
  // guarded on the field still being untouched so it never overwrites a branch the user picked.
  const baseBranch = useWatch({ control, name: "baseBranch" });
  useEffect(() => {
    if (isOpen && !baseBranch && defaultBaseBranch) {
      setValue("baseBranch", defaultBaseBranch);
    }
  }, [isOpen, baseBranch, defaultBaseBranch, setValue]);

  const handleIssueSelect = (issue: RemoteIssue | null) => {
    setSelectedIssue(issue);
    if (!issue) {
      setTitle("");
      setDescription("");
      setLabels([]);
      setValue("priority", "None");
      return;
    }
    setTitle(issue.title);
    setDescription(issue.body ?? "");
    setLabels(issue.issue_type ? [issue.issue_type] : []);
    if (PRIORITIES.includes(issue.priority as TaskPriority)) {
      setValue("priority", issue.priority as TaskPriority);
    }
  };

  const onSubmit: SubmitHandler<FormData> = (data) => {
    setError(null);
    const currentTitle = title.trim();
    if (!currentTitle || currentTitle.length < 3) {
      setError("Title must be at least 3 characters");
      return;
    }
    // A non-git project offers no workspace choice, so it can only be the project directory. A
    // loop always gets a worktree of its own.
    const mode: WorkspaceMode = !isGitRepo
      ? "RepositoryDirectory"
      : runMode === "Loop"
        ? "NewWorktree"
        : data.workspaceMode;
    // The field shows this inline too; repeated here because nothing else stops the submit.
    if (mode === "NewWorktree" && data.branchMode === "Create") {
      const invalid = validateBranchSuffix(data.branchSuffix.trim());
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    const filesToAttach = [...pendingFiles];
    const reused =
      mode === "ReuseWorkspace"
        ? ((worktrees ?? []).find((wt) => wt.id === data.workspaceWorktreeId) ?? null)
        : null;
    createTask(
      {
        project_id: projectId,
        title: currentTitle,
        description: description.trim() || null,
        skills: [],
        labels,
        // Merge and review read the base branch whatever the workspace is, so it is always
        // recorded: the reused workspace's own base where there is one, otherwise whatever the
        // picker was showing, which is the project's default.
        base_branch:
          mode === "NewWorktree" ? data.baseBranch : (reused?.base_branch ?? data.baseBranch),
        // The project's agent profiles name the agent per role, so a task no longer carries one.
        agent_id: null,
        priority: data.priority,
        auto_approve: false,
        workspace_mode: mode,
        workspace_worktree_id: reused?.id ?? null,
        workspace_branch_mode: data.branchMode,
        // Blank means "generate it from the task when the worktree is created", which is what the
        // placeholder was previewing.
        workspace_branch: data.branchSuffix.trim()
          ? `${MAESTRO_BRANCH_PREFIX}${data.branchSuffix.trim()}`
          : null,
        model_override: null,
        run_mode: isGitRepo && runMode === "Loop" ? "Loop" : null,
        loop_config: null,
      },
      {
        onSuccess: (newTask: Task) => {
          for (const f of filesToAttach) {
            addAttachmentRef.current.mutate({
              projectId: newTask.project_id,
              taskId: newTask.id,
              filename: f.filename,
              filePath: f.filePath,
            });
          }
          setPendingFiles([]);
          onCreated?.(newTask);
          if (createAnother) {
            setTitle("");
            setDescription("");
            setSelectedIssue(null);
            setLabels([]);
          } else {
            onClose();
          }
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : "Failed to create task");
        },
      },
    );
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      disablePointerDismissal
    >
      <DialogContent
        showCloseButton={false}
        className="sm:w-fit sm:min-w-160 sm:max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden"
      >
        {/* Header */}
        <div className="relative flex items-center gap-3 px-6 pt-4 shrink-0">
          {/* The issue popup's anchor: the header's width less its padding, which is the
              body's content box, so the popup lines up with the fields and stays in the dialog. */}
          <span
            ref={issuePopupAnchor}
            className="pointer-events-none absolute inset-x-6 bottom-0"
          />
          <DialogTitle className="text-[11px] font-normal tracking-[0.14em] uppercase text-muted-foreground">
            Create task
          </DialogTitle>
          {hasProvider && issueConfig && (
            <IssueSearchCombobox
              issueConfig={issueConfig}
              selectedIssue={selectedIssue}
              onSelect={handleIssueSelect}
              remoteIssues={remoteIssues ?? []}
              issuesFetching={issuesFetching}
              popupAnchor={issuePopupAnchor}
            />
          )}
          <div className="flex-1" />
          <DialogClose
            render={<Button variant="ghost" size="icon" className="shrink-0 size-7 rounded-full" />}
          >
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        {/* `handleSubmit` is invoked at submit time rather than during render: it reads
            react-hook-form's field registry, which the library keeps in refs. */}
        <form
          onSubmit={(e) => void handleSubmit(onSubmit)(e)}
          className="flex flex-col flex-1 min-h-0 overflow-hidden"
        >
          {/* Body */}
          <div className="flex-1 flex flex-col min-h-0 overflow-y-auto px-6 pt-1 pb-4 gap-4">
            {error && (
              <div className="shrink-0 bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded text-sm">
                {error}
              </div>
            )}

            {/* Title */}
            <div className="shrink-0">
              <EditableField
                value={title}
                onSave={setTitle}
                isEditable={true}
                placeholder="Task title"
                className="text-2xl font-semibold tracking-[-0.025em]"
              />
            </div>

            {/* Description + attachment */}
            <DescriptionWithAttachments
              value={description}
              onSave={setDescription}
              isEditable={true}
              isDragging={isDragging}
              onPickFiles={pickFiles}
              placeholder="Add description..."
            />

            {/* Attachments, held until the task exists to hang them off */}
            {pendingFiles.length > 0 && (
              <ul className="shrink-0 space-y-1">
                {pendingFiles.map((f) => (
                  <li
                    key={f.filePath}
                    className="home-field h-9 flex items-center gap-2 rounded-xl px-3 text-sm"
                  >
                    <span className="flex-1 truncate text-foreground">{f.filename}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() =>
                        setPendingFiles((prev) => prev.filter((p) => p.filePath !== f.filePath))
                      }
                    >
                      <X className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {/* Labels */}
            {labels.length > 0 && (
              <div className="flex flex-wrap gap-1 shrink-0">
                {labels.map((l) => (
                  <IssueTypeChip
                    key={l}
                    type={l}
                    onRemove={() => setLabels((prev) => prev.filter((x) => x !== l))}
                  />
                ))}
              </div>
            )}

            {/* How it runs, first: it decides which workspaces there are to pick. Only in a git
                project, since a loop needs a worktree of its own. */}
            {isGitRepo && (
              <div className="shrink-0 space-y-1.5">
                <span className="text-[11px] text-muted-foreground">How it runs</span>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      [
                        "Pipeline",
                        Workflow,
                        "Plan, implement, self review, your approval. For work you will judge by reading it.",
                      ],
                      [
                        "Loop",
                        Repeat,
                        "Fresh sessions until sealed checks pass. For work a command can verify.",
                      ],
                    ] as const
                  ).map(([mode, Icon, blurb]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={runMode === mode}
                      onClick={() => {
                        setRunMode(mode);
                        if (mode === "Loop") setValue("workspaceMode", "NewWorktree");
                      }}
                      className="home-pane flex items-start gap-2 rounded-xl p-2.5 text-left text-xs"
                      data-selected={runMode === mode}
                    >
                      <Icon className="mt-0.5 size-4 shrink-0 text-accent" />
                      <span>
                        <span className="font-medium">{mode}</span>
                        <br />
                        <span className="text-[11px] text-muted-foreground">{blurb}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Workspace: where the agent will work, and whatever that choice needs */}
            {isGitRepo && (
              <div className="shrink-0">
                <Controller
                  name="baseBranch"
                  control={control}
                  rules={{
                    // Only the mode that creates a worktree needs a branch chosen — and only the
                    // one that checks a branch out can collide with a worktree already on it.
                    validate: (value) => {
                      if (workspaceMode !== "NewWorktree") return true;
                      if (!value) return "Base branch is required";
                      if (branchMode !== "Checkout") return true;
                      return (
                        findBranchConflict(value, worktrees ?? [], project?.path ?? "") === null ||
                        "That branch is already checked out somewhere else"
                      );
                    },
                  }}
                  render={({ field: { value, onChange } }) => (
                    <WorkspaceSelector
                      mode={workspaceMode}
                      onModeChange={(m) => setValue("workspaceMode", m)}
                      baseBranch={value}
                      onBaseBranchChange={onChange}
                      baseBranchError={errors.baseBranch?.message}
                      branchMode={branchMode}
                      onBranchModeChange={(m) => setValue("branchMode", m)}
                      branchSuffix={branchSuffix}
                      onBranchSuffixChange={(s) => setValue("branchSuffix", s)}
                      generatedBranchSuffix={null}
                      worktrees={worktrees ?? []}
                      repoPath={project?.path ?? ""}
                      selectedWorktreePath={
                        worktrees?.find((wt) => wt.id === workspaceWorktreeId)?.path ?? null
                      }
                      onSelectedWorktreeChange={(wt: WorktreeWithStatus | null) =>
                        setValue("workspaceWorktreeId", wt?.id ?? null)
                      }
                      claimsOwnership
                      newWorktreeOnly={
                        runMode === "Loop"
                          ? "A loop always gets a worktree of its own, so its checks can be sealed from the agent"
                          : null
                      }
                    />
                  )}
                />
              </div>
            )}

            {/* Metadata pills */}
            <div className="shrink-0">
              <TaskMetadataPills
                priority={priority}
                onPriorityChange={(p) => setValue("priority", p)}
              />
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 pt-1 pb-4 flex items-center gap-2 shrink-0 [&_[data-slot=button]]:h-9 [&_[data-slot=button]]:rounded-xl [&_[data-slot=button]]:px-4 [&_[data-slot=button]]:text-xs">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <Switch
                size="sm"
                checked={createAnother}
                onCheckedChange={setCreateAnother}
                className="data-unchecked:bg-muted data-unchecked:border-border/50"
              />
              Create another
            </label>
            <div className="flex-1" />
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? "Saving..." : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
