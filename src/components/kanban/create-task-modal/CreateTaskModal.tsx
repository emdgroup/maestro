import { useState, useRef, useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import {
  Combobox,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/ui/combobox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { Search, X } from "lucide-react";
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
import { PRIORITY_COLORS } from "@/utils/constants/priority";
import type { RemoteIssue, Task, TaskPriority, ProjectIssueTrackingConfig } from "@/types/bindings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { EditableField } from "@/components/kanban/task-detail-modal/EditableField";
import {
  useDraggableFileInput,
  appendToAttachmentsSection,
} from "@/components/kanban/shared/useFileInput";
import { DescriptionWithAttachments } from "@/components/kanban/shared/DescriptionWithAttachments";
import { BranchSection } from "@/components/kanban/shared/BranchSection";
import { TaskMetadataPills } from "@/components/kanban/shared/TaskMetadataPills";

function stripProviderPrefix(externalId: string): string {
  const colon = externalId.indexOf(":");
  return colon >= 0 ? externalId.slice(colon + 1) : externalId;
}

function getIssueSearchPlaceholder(config: ProjectIssueTrackingConfig): string {
  const { provider, owner, repo, project_path, project_key, team_id, project_name } = config;
  let context: string;
  switch (provider) {
    case "github":
    case "forgejo":
    case "gitea":
      context = owner && repo ? `${owner}/${repo}` : "";
      break;
    case "gitlab":
      context = project_path ?? "";
      break;
    case "jira_cloud":
      context = project_key ?? "";
      break;
    case "linear":
      context = team_id ?? "";
      break;
    case "azuredevops":
      context = project_name ?? "";
      break;
    default:
      context = "";
  }
  return context ? `Search ${context} issues` : "Search issues...";
}

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
  const addAttachmentRef = useRef(addAttachment);
  addAttachmentRef.current = addAttachment;

  const [error, setError] = useState<string | null>(null);
  const [createAnother, setCreateAnother] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<RemoteIssue | null>(null);
  const [issueSearch, setIssueSearch] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  const [title, setTitleState] = useState("");
  const titleRef = useRef("");
  const [description, setDescriptionState] = useState("");
  const descriptionRef = useRef("");

  function setTitle(v: string) {
    titleRef.current = v;
    setTitleState(v);
  }

  function setDescription(v: string) {
    descriptionRef.current = v;
    setDescriptionState(v);
  }

  const { pickFiles, isDragging } = useDraggableFileInput(isOpen, (filename, filePath) => {
    setPendingFiles((prev) => [...prev, { filename, filePath }]);
    setDescription(appendToAttachmentsSection(descriptionRef.current, filename));
  });

  const { data: remoteIssues, isFetching: issuesFetching } = useListRemoteIssuesQuery(
    hasProvider ? projectId : null,
    isOpen && hasProvider,
  );

  const {
    handleSubmit,
    control,
    reset,
    watch,
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

  const priority = watch("priority");
  const agentId = watch("agentId");
  const isolatedWorktree = watch("isolatedWorktree");
  const autoApprove = watch("autoApprove");

  useEffect(() => {
    if (isOpen) {
      reset({
        baseBranch: currentBranch ?? "",
        priority: "None",
        agentId: projectSettings?.default_agent ?? "",
        isolatedWorktree: true,
        autoApprove: false,
      });
      setTitle("");
      setDescription("");
    } else {
      reset();
      setError(null);
      setSelectedIssue(null);
      setIssueSearch("");
      setPendingFiles([]);
      setTitle("");
      setDescription("");
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleIssueSelect = (issue: RemoteIssue) => {
    setSelectedIssue(issue);
    setTitle(issue.title);
    setDescription(issue.body ?? "");
  };

  const onSubmit: SubmitHandler<FormData> = (data) => {
    setError(null);
    const currentTitle = titleRef.current.trim();
    if (!currentTitle || currentTitle.length < 3) {
      setError("Title must be at least 3 characters");
      return;
    }
    const filesToAttach = [...pendingFiles];
    createTask(
      {
        project_id: projectId,
        title: currentTitle,
        description: descriptionRef.current.trim() || null,
        skills: [],
        base_branch: data.baseBranch,
        agent_id: data.agentId || null,
        priority: data.priority,
        auto_approve: data.autoApprove,
        isolated_worktree: data.isolatedWorktree,
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

  const filteredIssues = (remoteIssues ?? []).filter(
    (i) =>
      !issueSearch ||
      `#${i.external_id} ${i.title}`.toLowerCase().includes(issueSearch.toLowerCase()),
  );

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:w-fit sm:min-w-160 sm:max-w-[90vw] max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden"
      >
        <DialogDescription className="sr-only">
          Create a new task for this project
        </DialogDescription>

        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-4 pb-3 shrink-0">
          <DialogTitle className="text-xs font-semibold tracking-widest uppercase text-foreground">
            CREATE TASK
          </DialogTitle>
          <div className="flex-1" />
          <DialogClose render={<Button variant="ghost" size="icon" className="shrink-0" />}>
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        <form
          onSubmit={handleSubmit(onSubmit)}
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
            {hasProvider && (
              <div className="shrink-0">
                <Combobox
                  value={
                    selectedIssue ? `#${stripProviderPrefix(selectedIssue.external_id)}` : null
                  }
                  onValueChange={(val) => {
                    if (!val) {
                      setSelectedIssue(null);
                      setTitle("");
                      setDescription("");
                      return;
                    }
                    const externalId = val.replace(/^#/, "").split(" ")[0];
                    const issue = (remoteIssues ?? []).find((i) => i.external_id === externalId);
                    if (issue) handleIssueSelect(issue);
                  }}
                  filter={null}
                  onInputValueChange={setIssueSearch}
                >
                  <InputGroup className="w-full">
                    <InputGroupAddon align="inline-start">
                      <BrandIcon
                        slug={issueConfig.provider}
                        className="text-muted-foreground"
                        width={14}
                        height={14}
                      />
                    </InputGroupAddon>
                    <ComboboxPrimitive.Input
                      render={<InputGroupInput />}
                      placeholder={getIssueSearchPlaceholder(issueConfig)}
                    />
                    <InputGroupAddon align="inline-end">
                      <Search className="size-3.5 opacity-50" />
                    </InputGroupAddon>
                  </InputGroup>
                  <ComboboxContent className="min-w-(--anchor-width)" sideOffset={4}>
                    <ComboboxList className="custom-scrollbar space-y-1">
                      {issuesFetching && <ComboboxEmpty>Loading issues...</ComboboxEmpty>}
                      {!issuesFetching && filteredIssues.length === 0 && (
                        <ComboboxEmpty>No issues found.</ComboboxEmpty>
                      )}
                      <TooltipPrimitive.Provider delay={400}>
                        {filteredIssues.map((issue) => (
                          <TooltipPrimitive.Root key={issue.external_id}>
                            <ComboboxItem
                              value={`#${issue.external_id} ${issue.title}`}
                              className="p-0 px-1 rounded-md focus:outline-none hover:bg-transparent data-highlighted:bg-transparent data-highlighted:text-inherit data-highlighted:**:text-inherit not-data-[variant=destructive]:data-highlighted:**:text-inherit"
                            >
                              <TooltipPrimitive.Trigger
                                render={<div />}
                                className="w-full rounded-md p-2 bg-muted/60 hover:bg-muted transition-colors cursor-default"
                              >
                                <div className="flex items-center justify-between gap-2 mb-0.5">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      e.preventDefault();
                                      void openUrl(issue.url);
                                    }}
                                    className="text-[11px] !text-accent hover:underline shrink-0 cursor-pointer"
                                  >
                                    #{stripProviderPrefix(issue.external_id)}
                                  </button>
                                  {issue.priority && (
                                    <div className="flex items-center gap-1 shrink-0">
                                      <span
                                        className="size-2 rounded-full"
                                        style={{
                                          backgroundColor:
                                            PRIORITY_COLORS[issue.priority as TaskPriority] ??
                                            "#4b5563",
                                        }}
                                      />
                                      <span className="text-[10px] text-muted-foreground">
                                        {issue.priority}
                                      </span>
                                    </div>
                                  )}
                                </div>
                                <p className="text-sm truncate">{issue.title}</p>
                                {issue.labels.length > 0 && (
                                  <div className="flex items-center gap-1 overflow-hidden mt-1 mask-[linear-gradient(to_right,black_80%,transparent_100%)]">
                                    {issue.labels.map((label) => (
                                      <span
                                        key={label}
                                        className="rounded px-1 py-0.5 text-[10px] border border-border text-muted-foreground shrink-0"
                                      >
                                        {label}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </TooltipPrimitive.Trigger>
                            </ComboboxItem>
                            <TooltipPrimitive.Portal>
                              <TooltipPrimitive.Positioner
                                side="right"
                                sideOffset={8}
                                className="z-50"
                              >
                                <TooltipPrimitive.Popup className="w-72 p-3 bg-popover text-popover-foreground rounded-lg shadow-md ring-1 ring-foreground/10 origin-(--transform-origin) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
                                  <p className="text-sm font-medium leading-snug mb-2">
                                    {issue.title}
                                  </p>
                                  {issue.labels.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                      {issue.labels.map((label) => (
                                        <span
                                          key={label}
                                          className="rounded px-1.5 py-0.5 text-[10px] border border-border text-muted-foreground"
                                        >
                                          {label}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </TooltipPrimitive.Popup>
                              </TooltipPrimitive.Positioner>
                            </TooltipPrimitive.Portal>
                          </TooltipPrimitive.Root>
                        ))}
                      </TooltipPrimitive.Provider>
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
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

            {/* Branch */}
            {isGitRepo && (
              <div className="shrink-0">
                <Controller
                  name="baseBranch"
                  control={control}
                  rules={{ required: isGitRepo ? "Base branch is required" : false }}
                  render={({ field: { value, onChange } }) => (
                    <BranchSection
                      projectId={projectId}
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
