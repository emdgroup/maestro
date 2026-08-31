import { useState, useRef, useEffect } from "react";
import { useForm, useWatch, Controller } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { X } from "lucide-react";
import { IssueTypeChip } from "@/components/kanban/shared/IssueTypeChip";
import {
  useCreateTaskMutation,
  useAddTaskAttachmentMutation,
  useProjectBranchesQuery,
  useListRemoteIssuesQuery,
} from "@/services/task.service";
import { useProjectIssueTrackingConfig } from "@/services/integration.service";
import { useProjectSettings } from "@/services/project.service";
import { useIsGitRepo } from "@/store/projectStore";
import { EditableField } from "@/components/kanban/task-detail-modal/EditableField";
import {
  useDraggableFileInput,
  appendToAttachmentsSection,
} from "@/components/kanban/shared/useFileInput";
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
  Task,
  TaskPriority,
  WorkspaceMode,
  WorktreeWithStatus,
} from "@/types/bindings";
import { IssueSearchCombobox } from "./IssueSearchCombobox";

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
}

export function CreateTaskModal({ isOpen, onClose, projectId }: CreateTaskModalProps) {
  const isGitRepo = useIsGitRepo();

  const { data: issueConfig } = useProjectIssueTrackingConfig(projectId);
  const hasProvider = issueConfig != null;

  const { data: projectSettings } = useProjectSettings(projectId);
  const defaultWorkspaceMode: WorkspaceMode =
    projectSettings?.default_workspace_mode ?? "NewWorktree";

  // Keep for currentBranch initialization only — BranchPicker fetches the full list internally
  const { data: branchData } = useProjectBranchesQuery(isOpen ? projectId : null);
  const currentBranch: string = branchData?.[1] ?? "";

  const project = useSelectedProject();
  const { data: worktrees } = useWorktreesQuery(projectId, project?.path);

  const { mutate: createTask, isPending } = useCreateTaskMutation();
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
  const [labels, setLabels] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const { pickFiles, isDragging } = useDraggableFileInput(isOpen, (filename, filePath) => {
    setPendingFiles((prev) => [...prev, { filename, filePath }]);
    // Functional update, not a read of the latest value: `pickFiles` calls this once per
    // selected file in a synchronous loop, so every file but the last would be dropped by
    // a snapshot taken before the batch.
    setDescription((prev) => appendToAttachmentsSection(prev, filename));
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
    setTitle("");
    setDescription("");
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
        baseBranch: currentBranch ?? "",
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

  const handleIssueSelect = (issue: RemoteIssue | null) => {
    if (!issue) {
      setSelectedIssue(null);
      setTitle("");
      setDescription("");
      setLabels([]);
      return;
    }
    setSelectedIssue(issue);
    setTitle(issue.title);
    setDescription(issue.body ?? "");
    setLabels(issue.issue_type ? [issue.issue_type] : []);
  };

  const onSubmit: SubmitHandler<FormData> = (data) => {
    setError(null);
    const currentTitle = title.trim();
    if (!currentTitle || currentTitle.length < 3) {
      setError("Title must be at least 3 characters");
      return;
    }
    // A non-git project offers no workspace choice, so it can only be the project directory.
    const mode: WorkspaceMode = isGitRepo ? data.workspaceMode : "RepositoryDirectory";
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
        // recorded: the reused workspace's own base where there is one, otherwise the branch the
        // repository is on — which is what the picker would have been showing.
        base_branch:
          mode === "NewWorktree"
            ? data.baseBranch
            : (reused?.base_branch ?? currentBranch ?? data.baseBranch),
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
      },
      {
        onSuccess: (newTask: Task) => {
          for (const f of filesToAttach) {
            addAttachmentRef.current.mutate({
              taskId: newTask.id,
              filename: f.filename,
              filePath: f.filePath,
            });
          }
          setPendingFiles([]);
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
        <div className="flex items-center gap-3 px-6 pt-3 shrink-0">
          <DialogTitle className="text-xs font-semibold tracking-widest uppercase text-foreground">
            CREATE TASK
          </DialogTitle>
          <div className="flex-1" />
          <DialogClose render={<Button variant="ghost" size="icon" className="shrink-0" />}>
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
          <div className="flex-1 flex flex-col min-h-0 px-6 py-4 gap-4">
            {error && (
              <div className="shrink-0 bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded text-sm">
                {error}
              </div>
            )}

            {/* Issue search */}
            {hasProvider && issueConfig && (
              <div className="shrink-0">
                <IssueSearchCombobox
                  issueConfig={issueConfig}
                  selectedIssue={selectedIssue}
                  onSelect={handleIssueSelect}
                  remoteIssues={remoteIssues ?? []}
                  issuesFetching={issuesFetching}
                />
              </div>
            )}

            {/* Title */}
            <div className="shrink-0">
              <EditableField
                value={title}
                onSave={setTitle}
                isEditable={true}
                placeholder="Task title"
                className="text-xl font-semibold"
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
                      selectedWorktreeId={workspaceWorktreeId}
                      onSelectedWorktreeChange={(wt: WorktreeWithStatus | null) =>
                        setValue("workspaceWorktreeId", wt?.id ?? null)
                      }
                      claimsOwnership
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
          <div className="border-t border-border px-6 py-3 flex items-center gap-2 shrink-0">
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
              {isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
