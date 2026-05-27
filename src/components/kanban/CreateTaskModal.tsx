import { useState, useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Switch } from "@/ui/switch";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/ui/command";
import { GitBranch, RefreshCw, Check, ChevronDown, Sparkles, Bot, Search } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import {
  useCreateTaskMutation,
  useProjectBranchesQuery,
  useFetchRemoteIssuesQuery,
  taskQueryKeys,
} from "@/services/task.service";
import { useProjectIssueTrackingConfig } from "@/services/integration.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useProjectSettings } from "@/services/project.service";
import { useSelectedProject } from "@/store/projectStore";
import { PRIORITY_COLORS } from "@/utils/constants/priority";
import type { RemoteIssue, TaskPriority } from "@/types/bindings";

const PRIORITIES: TaskPriority[] = ["Urgent", "High", "Medium", "Low", "None"];

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
  const connectionId = selectedProject?.connection_id ?? null;
  const wslConnectionId = selectedProject?.wsl_connection_id ?? null;

  const { data: issueConfig } = useProjectIssueTrackingConfig(projectId);
  const hasProvider = issueConfig != null;

  const { data: branchData, isFetching: branchesFetching } = useProjectBranchesQuery(
    isOpen ? projectId : null,
  );
  const localBranches: string[] = branchData?.[0].local ?? [];
  const remoteBranches: string[] = branchData?.[0].remote ?? [];
  const currentBranch: string = branchData?.[1] ?? "";

  const { data: discovery } = useAgentDiscoveryQuery(connectionId, wslConnectionId);
  const agents = discovery?.agents ?? [];

  const { data: projectSettings } = useProjectSettings(projectId);

  const { mutate: createTask, isPending } = useCreateTaskMutation();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [createAnother, setCreateAnother] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<RemoteIssue | null>(null);
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false);
  const [branchSearch, setBranchSearch] = useState("");
  const [branchTab, setBranchTab] = useState<"local" | "remote">("local");
  const [priorityPopoverOpen, setPriorityPopoverOpen] = useState(false);
  const [agentPopoverOpen, setAgentPopoverOpen] = useState(false);
  const [issuePopoverOpen, setIssuePopoverOpen] = useState(false);

  const { data: remoteIssues, isFetching: issuesFetching } = useFetchRemoteIssuesQuery(
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
      priority: "Medium",
      agentId: "",
      isolatedWorktree: true,
      autoApprove: false,
    },
  });

  const selectedPriority = watch("priority");
  const selectedAgentId = watch("agentId");

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
      setBranchSearch("");
      setBranchTab("local");
    }
  }, [isOpen, reset]);

  const handleIssueSelect = (issue: RemoteIssue) => {
    setSelectedIssue(issue);
    setValue("title", issue.title);
    setValue("description", issue.body ?? "");
    setIssuePopoverOpen(false);
  };

  const onSubmit: SubmitHandler<FormData> = (data) => {
    setError(null);
    createTask(
      {
        project_id: projectId,
        title: data.title,
        description: data.description,
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

  const agentPillLabel = selectedAgent ? selectedAgent.name : "No agent";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[520px] overflow-y-auto custom-scrollbar">
        <DialogTitle className="text-xs font-semibold tracking-widest uppercase text-foreground">
          CREATE TASK
        </DialogTitle>
        <DialogDescription className="sr-only">Create a new task for this project</DialogDescription>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="flex flex-col gap-4">
            {/* Issue search — shown only when provider configured */}
            {hasProvider && (
              <div className="flex flex-col gap-1.5">
                <Popover open={issuePopoverOpen} onOpenChange={setIssuePopoverOpen}>
                  <PopoverTrigger
                    className="flex items-center gap-2 w-full rounded-md border border-border bg-transparent px-3 h-9 text-sm hover:bg-muted transition-colors text-left"
                  >
                    <Search className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className={cn("flex-1 truncate", !selectedIssue && "text-muted-foreground")}>
                      {selectedIssue
                        ? `#${selectedIssue.external_id} ${selectedIssue.title}`
                        : "Search issues..."}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </PopoverTrigger>
                  <PopoverContent className="w-[var(--anchor-width)] p-0 gap-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search issues..." />
                      <CommandList className="custom-scrollbar">
                        <CommandEmpty>
                          {issuesFetching ? "Loading issues..." : "No issues found."}
                        </CommandEmpty>
                        <CommandGroup>
                          {(remoteIssues ?? []).map((issue) => (
                            <CommandItem
                              key={issue.external_id}
                              value={`${issue.external_id} ${issue.title}`}
                              onSelect={() => handleIssueSelect(issue)}
                              className="flex items-center gap-2 py-2"
                            >
                              <span
                                className="size-2 rounded-full shrink-0"
                                style={{
                                  backgroundColor: issue.priority
                                    ? (PRIORITY_COLORS[issue.priority as TaskPriority] ?? "#4b5563")
                                    : "#4b5563",
                                }}
                              />
                              <span className="text-xs text-muted-foreground shrink-0">
                                #{issue.external_id}
                              </span>
                              <span className="flex-1 text-sm truncate">{issue.title}</span>
                              {issue.labels.length > 0 && (
                                <div className="flex items-center gap-1 shrink-0">
                                  {issue.labels.slice(0, 2).map((label) => (
                                    <span
                                      key={label}
                                      className="rounded px-1 py-0.5 text-[10px] border border-border text-muted-foreground"
                                    >
                                      {label}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {selectedIssue?.external_id === issue.external_id && (
                                <Check className="size-3.5 shrink-0" />
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <span className="text-[10px] text-emerald-500 flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-emerald-500 inline-block" />
                  Connected to {issueConfig.provider}
                </span>
              </div>
            )}

            {/* Seamless title */}
            <div>
              <Input
                {...register("title", {
                  required: "Title is required",
                  minLength: { value: 3, message: "Title must be at least 3 characters" },
                })}
                placeholder="Task title"
                className="border-0 shadow-none bg-transparent dark:bg-transparent text-base px-0 focus-visible:ring-0 placeholder:text-muted-foreground/50 h-auto py-0"
              />
              {errors.title && (
                <span className="text-destructive text-xs mt-0.5 block">{errors.title.message}</span>
              )}
            </div>

            {/* Seamless description */}
            <div>
              <Textarea
                {...register("description", {
                  required: "Description is required",
                  minLength: { value: 10, message: "Description must be at least 10 characters" },
                })}
                placeholder="Add description..."
                rows={3}
                className="border-0 shadow-none bg-transparent dark:bg-transparent px-0 resize-none focus-visible:ring-0 placeholder:text-muted-foreground/50"
              />
              {errors.description && (
                <span className="text-destructive text-xs">{errors.description.message}</span>
              )}
            </div>

            {/* Branch selector */}
            <Controller
              name="baseBranch"
              control={control}
              rules={{ required: "Base branch is required" }}
              render={({ field: { value, onChange } }) => (
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground">
                    FROM BRANCH
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Popover open={branchPopoverOpen} onOpenChange={setBranchPopoverOpen}>
                      <PopoverTrigger
                        className={cn(
                          "flex flex-1 items-center gap-2 rounded-md border bg-transparent px-3 h-9 text-sm hover:bg-muted transition-colors",
                          errors.baseBranch ? "border-destructive" : "border-border",
                        )}
                      >
                        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="flex-1 text-left truncate">{value || "Select branch..."}</span>
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                      </PopoverTrigger>
                      <PopoverContent className="w-[var(--anchor-width)] p-0 gap-0" align="start">
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
                                {tab === "local" ? `Local (${filteredLocal.length})` : `Remote (${filteredRemote.length})`}
                              </button>
                            ))}
                          </div>
                        </div>
                        <BranchList
                          branches={branchTab === "local" ? filteredLocal : filteredRemote}
                          selected={value}
                          onSelect={(b) => {
                            onChange(b);
                            setBranchPopoverOpen(false);
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
            />

            {/* Priority + Agent + Toggle pills */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Priority pill */}
              <Popover open={priorityPopoverOpen} onOpenChange={setPriorityPopoverOpen}>
                <PopoverTrigger className="flex items-center gap-1.5 rounded-full border border-border bg-transparent px-2.5 h-7 text-xs hover:bg-muted transition-colors">
                  <span
                    className="size-2 rounded-full shrink-0"
                    style={{ backgroundColor: PRIORITY_COLORS[selectedPriority] }}
                  />
                  {selectedPriority}
                </PopoverTrigger>
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
                            setPriorityPopoverOpen(false);
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

              {/* Agent pill */}
              <Popover open={agentPopoverOpen} onOpenChange={setAgentPopoverOpen}>
                <PopoverTrigger
                  className="flex items-center gap-1.5 rounded-full border border-border bg-transparent px-2.5 h-7 text-xs hover:bg-muted transition-colors max-w-[200px]"
                >
                  {selectedAgent ? (
                    <Sparkles className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <Bot className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{agentPillLabel}</span>
                </PopoverTrigger>
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
                            setAgentPopoverOpen(false);
                          }}
                        >
                          <Bot className="size-3 text-muted-foreground shrink-0" />
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
                              setAgentPopoverOpen(false);
                            }}
                          >
                            <Sparkles className="size-3 text-muted-foreground shrink-0" />
                            <span className="truncate flex-1 text-left">{agent.name}</span>
                            {selectedAgentId === agent.id && <Check className="size-3 shrink-0" />}
                          </button>
                        ))}
                      </>
                    )}
                  />
                </PopoverContent>
              </Popover>

              {/* Toggle pills */}
              <Controller
                name="isolatedWorktree"
                control={control}
                render={({ field: { value, onChange } }) => (
                  <button
                    type="button"
                    onClick={() => onChange(!value)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-xs transition-colors",
                      value
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15"
                        : "border-border bg-transparent text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {value && <Check className="size-3 shrink-0" />}
                    Isolate worktree
                  </button>
                )}
              />

              <Controller
                name="autoApprove"
                control={control}
                render={({ field: { value, onChange } }) => (
                  <button
                    type="button"
                    onClick={() => onChange(!value)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-xs transition-colors",
                      value
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15"
                        : "border-border bg-transparent text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {value && <Check className="size-3 shrink-0" />}
                    Auto-approve
                  </button>
                )}
              />
            </div>

            {/* Footer */}
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
        </form>
      </DialogContent>
    </Dialog>
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
