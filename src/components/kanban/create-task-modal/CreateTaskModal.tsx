import { useState, useEffect } from "react";
import { useForm, Controller, type Control } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Switch } from "@/ui/switch";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/ui/tooltip";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import {
  Combobox,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/ui/combobox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { GitBranch, RefreshCw, Check, ChevronDown, Bot, BotOff, Shield, ShieldOff, Search } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import {
  useCreateTaskMutation,
  useProjectBranchesQuery,
  useListRemoteIssuesQuery,
  taskQueryKeys,
} from "@/services/task.service";
import { useProjectIssueTrackingConfig } from "@/services/integration.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useProjectSettings } from "@/services/project.service";
import { useSelectedProject, useIsGitRepo } from "@/store/projectStore";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { PRIORITY_COLORS, PRIORITIES } from "@/utils/constants/priority";
import type { RemoteIssue, TaskPriority, ProjectIssueTrackingConfig } from "@/types/bindings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";

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
  title: string;
  description: string;
  baseBranch: string;
  priority: TaskPriority;
  agentId: string;
  isolatedWorktree: boolean;
  autoApprove: boolean;
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

  const { data: branchData, isFetching: branchesFetching } = useProjectBranchesQuery(
    isOpen ? projectId : null,
  );
  const localBranches: string[] = branchData?.[0].local ?? [];
  const remoteBranches: string[] = branchData?.[0].remote ?? [];
  const currentBranch: string = branchData?.[1] ?? "";

  const connection = selectedProject ? connectionKeyFromProject(selectedProject) : { type: "local" as const };
  const { data: discovery } = useAgentDiscoveryQuery(connection);
  const agents = discovery?.agents ?? [];

  const { data: projectSettings } = useProjectSettings(projectId);

  const { mutate: createTask, isPending } = useCreateTaskMutation();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [createAnother, setCreateAnother] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<RemoteIssue | null>(null);
  const [openPopover, setOpenPopover] = useState<"branch" | "priority" | "agent" | null>(null);
  const [branchSearch, setBranchSearch] = useState("");
  const [branchTab, setBranchTab] = useState<"local" | "remote">("local");
  const [issueSearch, setIssueSearch] = useState("");

  const { data: remoteIssues, isFetching: issuesFetching } = useListRemoteIssuesQuery(
    hasProvider ? projectId : null,
    isOpen && hasProvider,
  );

  const {
    register,
    handleSubmit,
    control,
    setValue,
    resetField,
    reset,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: {
      title: "",
      description: "",
      baseBranch: "",
      priority: "None",
      agentId: "",
      isolatedWorktree: true,
      autoApprove: false,
    },
  });

  const selectedPriority = watch("priority");
  const selectedAgentId = watch("agentId");
  const titleValue = watch("title");

  useEffect(() => {
    if (currentBranch && isOpen) {
      setValue("baseBranch", currentBranch);
    }
  }, [currentBranch, isOpen, setValue]);

  useEffect(() => {
    if (projectSettings?.default_agent && isOpen) {
      setValue("agentId", projectSettings.default_agent);
    }
  }, [projectSettings?.default_agent, isOpen, setValue]);

  useEffect(() => {
    if (!isOpen) {
      reset();
      setError(null);
      setSelectedIssue(null);
      setOpenPopover(null);
      setBranchSearch("");
      setBranchTab("local");
      setIssueSearch("");
    }
  }, [isOpen, reset]);

  const handleIssueSelect = (issue: RemoteIssue) => {
    setSelectedIssue(issue);
    setValue("title", issue.title);
    setValue("description", issue.body ?? "");
  };

  const onSubmit: SubmitHandler<FormData> = (data) => {
    setError(null);
    createTask(
      {
        project_id: projectId,
        title: data.title,
        description: data.description || null,
        skills: [],
        base_branch: data.baseBranch,
        agent_id: data.agentId || null,
        priority: data.priority,
        auto_approve: data.autoApprove,
        isolated_worktree: data.isolatedWorktree,
        model_override: null,
      },
      {
        onSuccess: () => {
          if (createAnother) {
            resetField("title");
            resetField("description");
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

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  const filteredLocal = localBranches.filter((b) =>
    b.toLowerCase().includes(branchSearch.toLowerCase()),
  );
  const filteredRemote = remoteBranches.filter((b) =>
    b.toLowerCase().includes(branchSearch.toLowerCase()),
  );

  const filteredIssues = (remoteIssues ?? []).filter(
    (i) =>
      !issueSearch ||
      `#${i.external_id} ${i.title}`.toLowerCase().includes(issueSearch.toLowerCase()),
  );

  const agentPillLabel = selectedAgent ? selectedAgent.name : "No agent";

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:w-fit sm:min-w-130 sm:max-w-[90vw] overflow-y-auto custom-scrollbar">
        <DialogTitle className="text-xs font-semibold tracking-widest uppercase text-foreground">
          CREATE TASK
        </DialogTitle>
        <DialogDescription className="sr-only">
          Create a new task for this project
        </DialogDescription>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)}>
          <TooltipProvider delay={400}>
          <div className="flex flex-col gap-4">
            {/* Issue search — shown only when provider configured */}
            {hasProvider && (
              <Combobox
                value={selectedIssue ? `#${stripProviderPrefix(selectedIssue.external_id)}` : null}
                onValueChange={(val) => {
                  if (!val) {
                    setSelectedIssue(null);
                    setValue("title", "");
                    setValue("description", "");
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
                                        PRIORITY_COLORS[issue.priority as TaskPriority] ?? "#4b5563",
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
                          <TooltipPrimitive.Positioner side="right" sideOffset={8} className="z-50">
                            <TooltipPrimitive.Popup className="w-72 p-3 bg-popover text-popover-foreground rounded-lg shadow-md ring-1 ring-foreground/10 origin-(--transform-origin) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
                              <p className="text-sm font-medium leading-snug mb-2">{issue.title}</p>
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
            )}

            <div>
              <div className="inline-grid min-w-full">
                <span
                  aria-hidden
                  className="col-start-1 row-start-1 pointer-events-none select-none invisible whitespace-pre text-base"
                >
                  {titleValue || "Task title"}
                </span>
                <Input
                  {...register("title", {
                    required: "Title is required",
                    minLength: { value: 3, message: "Title must be at least 3 characters" },
                  })}
                  placeholder="Task title"
                  className="col-start-1 row-start-1 border-0 shadow-none bg-transparent dark:bg-transparent text-base px-0 focus-visible:ring-0 placeholder:text-muted-foreground/50 h-auto py-0"
                />
              </div>
              {errors.title && (
                <span className="text-destructive text-xs mt-0.5 block">
                  {errors.title.message}
                </span>
              )}
            </div>

            <div>
              <Textarea
                {...register("description")}
                placeholder="Add description..."
                className="border-0 shadow-none bg-transparent dark:bg-transparent px-0 resize-none focus-visible:ring-0 placeholder:text-muted-foreground/50 min-h-18 max-h-[40vh] overflow-y-auto custom-scrollbar"
              />
            </div>

            {isGitRepo && <Controller
              name="baseBranch"
              control={control}
              rules={{ required: isGitRepo ? "Base branch is required" : false }}
              render={({ field: { value, onChange } }) => (
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground">
                    FROM BRANCH
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Popover
                      open={openPopover === "branch"}
                      onOpenChange={(v) => setOpenPopover(v ? "branch" : null)}
                    >
                      <Tooltip>
                      <TooltipTrigger
                        render={
                          <PopoverTrigger
                            className={cn(
                              "flex flex-1 items-center gap-2 rounded-md border bg-transparent px-3 h-9 text-sm hover:bg-muted transition-colors",
                              errors.baseBranch ? "border-destructive" : "border-border",
                            )}
                          />
                        }
                      >
                        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="flex-1 text-left truncate">
                          {value || "Select branch..."}
                        </span>
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>Branch used as base for the task execution</TooltipContent>
                      </Tooltip>
                      <PopoverContent className="w-(--anchor-width) p-0 gap-0" align="start">
                        <div className="p-2 border-b border-border">
                          <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-muted/50">
                            <Search className="size-3.5 text-muted-foreground shrink-0" />
                            <input
                              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                              placeholder="Search branches..."
                              value={branchSearch}
                              onChange={(e) => setBranchSearch(e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="p-1">
                          <div className="flex rounded-md bg-muted p-0.5 gap-0.5">
                            {(["local", "remote"] as const).map((tab) => (
                              <button
                                key={tab}
                                type="button"
                                onClick={() => setBranchTab(tab)}
                                className={cn(
                                  "flex-1 rounded-[5px] px-2 py-1 text-xs font-medium transition-colors capitalize",
                                  branchTab === tab
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground/80",
                                )}
                              >
                                {tab === "local"
                                  ? `Local (${filteredLocal.length})`
                                  : `Remote (${filteredRemote.length})`}
                              </button>
                            ))}
                          </div>
                        </div>
                        <BranchList
                          branches={branchTab === "local" ? filteredLocal : filteredRemote}
                          selected={value}
                          onSelect={(b) => {
                            onChange(b);
                            setOpenPopover(null);
                            setBranchSearch("");
                          }}
                        />
                      </PopoverContent>
                    </Popover>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        void queryClient.invalidateQueries({
                          queryKey: [...taskQueryKeys.base, "branches", projectId],
                        })
                      }
                      disabled={branchesFetching}
                    >
                      <RefreshCw className={cn("size-3.5", branchesFetching && "animate-spin")} />
                    </Button>
                  </div>
                  {errors.baseBranch && (
                    <span className="text-destructive text-xs">{errors.baseBranch.message}</span>
                  )}
                </div>
              )}
            />}

            <div className="flex items-center gap-2 flex-wrap">
              <Popover
                open={openPopover === "priority"}
                onOpenChange={(v) => setOpenPopover(v ? "priority" : null)}
              >
                <Tooltip>
                <TooltipTrigger
                  render={
                    <PopoverTrigger className="flex items-center gap-1.5 rounded-full border border-border bg-transparent px-2.5 h-7 text-xs hover:bg-muted transition-colors" />
                  }
                >
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ backgroundColor: PRIORITY_COLORS[selectedPriority] }}
                  />
                  {selectedPriority}
                </TooltipTrigger>
                <TooltipContent>Board ordering priority</TooltipContent>
                </Tooltip>
                <PopoverContent className="w-36 p-1" align="start">
                  {PRIORITIES.map((p) => (
                    <Controller
                      key={p}
                      name="priority"
                      control={control}
                      render={({ field: { onChange } }) => (
                        <button
                          type="button"
                          className="flex items-center gap-2 w-full px-2 py-0.5 text-xs rounded hover:bg-muted transition-colors"
                          onClick={() => {
                            onChange(p);
                            setOpenPopover(null);
                          }}
                        >
                          <span
                            className="size-2 rounded-full shrink-0"
                            style={{ backgroundColor: PRIORITY_COLORS[p] }}
                          />
                          {p}
                          {selectedPriority === p && <Check className="size-3 ml-auto" />}
                        </button>
                      )}
                    />
                  ))}
                </PopoverContent>
              </Popover>

              <Popover
                open={openPopover === "agent"}
                onOpenChange={(v) => setOpenPopover(v ? "agent" : null)}
              >
                <Tooltip>
                <TooltipTrigger
                  render={
                    <PopoverTrigger className="flex items-center gap-1.5 rounded-full border border-border bg-transparent px-2.5 h-7 text-xs hover:bg-muted transition-colors max-w-50" />
                  }
                >
                  {selectedAgent ? (
                    hasBrandIcon(selectedAgent.id) ? (
                      <BrandIcon slug={selectedAgent.id} className="size-3 shrink-0" />
                    ) : selectedAgent.icon ? (
                      <img src={selectedAgent.icon} className="size-3 shrink-0 dark:[filter:invert(1)]" />
                    ) : (
                      <Bot className="size-3 shrink-0 text-muted-foreground" />
                    )
                  ) : (
                    <BotOff className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{agentPillLabel}</span>
                </TooltipTrigger>
                <TooltipContent>AI agent assigned to this task</TooltipContent>
                </Tooltip>
                <PopoverContent className="w-52 p-1" align="start">
                  <Controller
                    name="agentId"
                    control={control}
                    render={({ field: { onChange } }) => (
                      <>
                        <button
                          type="button"
                          className="flex items-center gap-2 w-full px-2 py-0.5 text-xs rounded hover:bg-muted transition-colors"
                          onClick={() => {
                            onChange("");
                            setOpenPopover(null);
                          }}
                        >
                          <BotOff className="size-3 text-muted-foreground shrink-0" />
                          <span className="flex-1 text-left">No agent</span>
                          {!selectedAgentId && <Check className="size-3 ml-auto shrink-0" />}
                        </button>
                        {agents.map((agent) => (
                          <button
                            key={agent.id}
                            type="button"
                            className="flex items-center gap-2 w-full px-2 py-0.5 text-xs rounded hover:bg-muted transition-colors"
                            onClick={() => {
                              onChange(agent.id);
                              setOpenPopover(null);
                            }}
                          >
                            {hasBrandIcon(agent.id) ? (
                              <BrandIcon slug={agent.id} className="size-3 shrink-0" />
                            ) : (
                              <Bot className="size-3 text-muted-foreground shrink-0" />
                            )}
                            <span className="truncate flex-1 text-left">{agent.name}</span>
                            {selectedAgentId === agent.id && <Check className="size-3 shrink-0" />}
                          </button>
                        ))}
                      </>
                    )}
                  />
                </PopoverContent>
              </Popover>

              {isGitRepo && (
                <TogglePill
                  name="isolatedWorktree"
                  label="Worktree"
                  control={control}
                  tooltip="Create dedicated branch + worktree. Off = work on selected branch directly."
                  icon={<GitBranch className="size-3 shrink-0" />}
                />
              )}
              <TogglePill
                name="autoApprove"
                label="Auto-approve"
                control={control}
                tooltip="Skip manual approval for file changes and tool calls"
                icon={<Shield className="size-3 shrink-0" />}
                activeIcon={<ShieldOff className="size-3 shrink-0" />}
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <Switch
                  size="sm"
                  checked={createAnother}
                  onCheckedChange={setCreateAnother}
                  className="data-unchecked:bg-muted data-unchecked:border-border/50"
                />
                Create another
              </label>
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
          </TooltipProvider>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface TogglePillProps {
  name: "isolatedWorktree" | "autoApprove";
  label: string;
  control: Control<FormData>;
  tooltip?: string;
  icon: React.ReactNode;
  activeIcon?: React.ReactNode;
}

function TogglePill({ name, label, control, tooltip, icon, activeIcon }: TogglePillProps) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field: { value, onChange } }) => {
        const button = (
          <button
            type="button"
            onClick={() => onChange(!value)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-xs transition-colors",
              value
                ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
                : "border-border bg-transparent text-muted-foreground hover:bg-muted",
            )}
          >
            {value && activeIcon ? activeIcon : icon}
            {label}
          </button>
        );
        if (!tooltip) return button;
        return (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              {button}
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
          </Tooltip>
        );
      }}
    />
  );
}

interface BranchListProps {
  branches: string[];
  selected: string;
  onSelect: (branch: string) => void;
}

function BranchList({ branches, selected, onSelect }: BranchListProps) {
  if (branches.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">No branches found.</p>;
  }
  return (
    <div className="max-h-48 overflow-y-auto py-1 custom-scrollbar">
      {branches.map((branch) => (
        <button
          key={branch}
          type="button"
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-muted transition-colors text-left"
          onClick={() => onSelect(branch)}
        >
          <GitBranch className="size-3 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{branch}</span>
          {selected === branch && <Check className="size-3 shrink-0" />}
        </button>
      ))}
    </div>
  );
}
