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
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useProjectSettings } from "@/services/project.service";
import { useSelectedProject, useIsGitRepo } from "@/store/projectStore";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { EditableField } from "@/components/kanban/task-detail-modal/EditableField";
import {
  useDraggableFileInput,
  appendToAttachmentsSection,
} from "@/components/kanban/shared/useFileInput";
import { DescriptionWithAttachments } from "@/components/kanban/shared/DescriptionWithAttachments";
import { BranchSection } from "@/components/kanban/shared/BranchSection";
import { TaskMetadataPills } from "@/components/kanban/shared/TaskMetadataPills";
import type { RemoteIssue, Task, TaskPriority } from "@/types/bindings";
import { IssueSearchCombobox } from "./IssueSearchCombobox";

interface FormData {
  baseBranch: string;
  priority: TaskPriority;
  agentId: string;
  isolatedWorktree: boolean;
  autoApprove: boolean;
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
  const selectedProject = useSelectedProject();
  const isGitRepo = useIsGitRepo();

  const { data: issueConfig } = useProjectIssueTrackingConfig(projectId);
  const hasProvider = issueConfig != null;

  // Keep for currentBranch initialization only — BranchPicker fetches the full list internally
  const { data: branchData } = useProjectBranchesQuery(isOpen ? projectId : null);
  const currentBranch: string = branchData?.[1] ?? "";

  const connection = selectedProject
    ? connectionKeyFromProject(selectedProject)
    : { type: "local" as const };
  const { data: discovery } = useAgentDiscoveryQuery(connection);
  const agents = discovery?.agents ?? [];

  const { data: projectSettings } = useProjectSettings(projectId);

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
      agentId: "",
      isolatedWorktree: true,
      autoApprove: false,
    },
  });

  // `useWatch` rather than `watch`: the latter reads the form's mutable store during
  // render, which the compiler cannot track. Both re-render on change and both start
  // from the `defaultValues` above, so the values seen here are the same.
  const priority = useWatch({ control, name: "priority" });
  const agentId = useWatch({ control, name: "agentId" });
  const isolatedWorktree = useWatch({ control, name: "isolatedWorktree" });
  const autoApprove = useWatch({ control, name: "autoApprove" });

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
        agentId: projectSettings?.default_agent ?? "",
        isolatedWorktree: true,
        autoApprove: false,
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
    const filesToAttach = [...pendingFiles];
    createTask(
      {
        project_id: projectId,
        title: currentTitle,
        description: description.trim() || null,
        skills: [],
        labels,
        base_branch: data.baseBranch,
        agent_id: data.agentId || null,
        priority: data.priority,
        auto_approve: data.autoApprove,
        // A non-git project has no worktree toggle in the UI, so never persist it as on.
        isolated_worktree: isGitRepo ? data.isolatedWorktree : false,
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

            {/* Branch */}
            {isGitRepo && (
              <div className="shrink-0">
                <Controller
                  name="baseBranch"
                  control={control}
                  rules={{ required: isGitRepo ? "Base branch is required" : false }}
                  render={({ field: { value, onChange } }) => (
                    <BranchSection
                      value={value}
                      onChange={onChange}
                      error={errors.baseBranch?.message}
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
                agentId={agentId || null}
                agents={agents}
                onAgentChange={(id) => setValue("agentId", id ?? "")}
                isolatedWorktree={isolatedWorktree}
                onIsolatedWorktreeChange={(v) => setValue("isolatedWorktree", v)}
                autoApprove={autoApprove}
                onAutoApproveChange={(v) => setValue("autoApprove", v)}
                isGitRepo={isGitRepo ?? false}
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
