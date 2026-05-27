import { useState, useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/ui/tabs";
import { Button, buttonVariants } from "@/ui/button";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
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
import { Checkbox } from "@/ui/checkbox";
import { RefreshCw, ChevronDown } from "lucide-react";
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
import type { RemoteIssue } from "@/types/bindings";

interface FormData {
  title: string;
  description: string;
  baseBranch: string;
  priority: string;
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
  const branches: string[] = branchData?.[0] ?? [];
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

  const formFields = (
    <div className="flex flex-col gap-3">
      {/* Title */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Title *</Label>
        <Input
          {...register("title", {
            required: "Title is required",
            minLength: { value: 3, message: "Title must be at least 3 characters" },
          })}
          placeholder="Task title"
          className="w-full"
        />
        {errors.title && (
          <span className="text-destructive text-xs">{errors.title.message}</span>
        )}
      </div>

      {/* Description */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Description *</Label>
        <Textarea
          {...register("description", {
            required: "Description is required",
            minLength: { value: 10, message: "Description must be at least 10 characters" },
          })}
          placeholder="Describe the task..."
          rows={3}
          className="w-full"
        />
        {errors.description && (
          <span className="text-destructive text-xs">{errors.description.message}</span>
        )}
      </div>

      {/* Branch */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Base Branch *</Label>
        <div className="flex items-center gap-1.5">
          <Controller
            name="baseBranch"
            control={control}
            rules={{ required: "Base branch is required" }}
            render={({ field: { value, onChange } }) => (
              <Popover open={branchPopoverOpen} onOpenChange={setBranchPopoverOpen}>
                <PopoverTrigger
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "flex-1 justify-between",
                  )}
                >
                  <span className="truncate">{value || "Select branch..."}</span>
                  <ChevronDown className="size-3.5 shrink-0 ml-1 opacity-50" />
                </PopoverTrigger>
                <PopoverContent className="w-64 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search branches..." />
                    <CommandList>
                      <CommandEmpty>No branches found.</CommandEmpty>
                      <CommandGroup>
                        {branches.map((branch) => (
                          <CommandItem
                            key={branch}
                            value={branch}
                            data-checked={value === branch}
                            onSelect={() => {
                              onChange(branch);
                              setBranchPopoverOpen(false);
                            }}
                          >
                            {branch}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
          />
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

      {/* Priority */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Priority</Label>
        <Controller
          name="priority"
          control={control}
          render={({ field: { value, onChange } }) => (
            <Select value={value} onValueChange={onChange}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Urgent">Urgent</SelectItem>
                <SelectItem value="High">High</SelectItem>
                <SelectItem value="Medium">Medium</SelectItem>
                <SelectItem value="Low">Low</SelectItem>
                <SelectItem value="None">None</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {/* Agent */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Agent (assignee)</Label>
        <Controller
          name="agentId"
          control={control}
          render={({ field: { value, onChange } }) => (
            <Select value={value} onValueChange={onChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="None (no agent)">
                  {value === ""
                    ? "None (no agent)"
                    : (agents.find((a) => a.id === value)?.name ?? value)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">None (no agent)</SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {/* Toggles */}
      <div className="flex flex-col gap-2">
        <Controller
          name="isolatedWorktree"
          control={control}
          render={({ field: { value, onChange } }) => (
            <div className="flex items-center gap-2">
              <Switch size="sm" checked={value} onCheckedChange={onChange} id="isolated-worktree" />
              <Label htmlFor="isolated-worktree" className="text-xs text-muted-foreground cursor-pointer">
                Isolated worktree
              </Label>
            </div>
          )}
        />
        <Controller
          name="autoApprove"
          control={control}
          render={({ field: { value, onChange } }) => (
            <div className="flex items-center gap-2">
              <Switch size="sm" checked={value} onCheckedChange={onChange} id="auto-approve" />
              <Label htmlFor="auto-approve" className="text-xs text-muted-foreground cursor-pointer">
                Auto-approve
              </Label>
            </div>
          )}
        />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-1">
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <Checkbox
            checked={createAnother}
            onCheckedChange={(checked) => setCreateAnother(checked === true)}
          />
          Create another
        </label>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={isPending}>
            {isPending ? "Creating..." : "Create Task"}
          </Button>
        </div>
      </div>
    </div>
  );

  const issueCombobox = (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">Issue</Label>
      <Popover open={issuePopoverOpen} onOpenChange={setIssuePopoverOpen}>
        <PopoverTrigger
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "w-full justify-between",
          )}
        >
          <span className="truncate">
            {selectedIssue ? `${selectedIssue.external_id}: ${selectedIssue.title}` : "Select an issue..."}
          </span>
          <ChevronDown className="size-3.5 shrink-0 ml-1 opacity-50" />
        </PopoverTrigger>
        <PopoverContent className="w-full p-0" align="start">
          <Command>
            <CommandInput placeholder="Search issues..." />
            <CommandList>
              <CommandEmpty>
                {issuesFetching ? "Loading issues..." : "No issues found."}
              </CommandEmpty>
              <CommandGroup>
                {(remoteIssues ?? []).map((issue) => (
                  <CommandItem
                    key={issue.external_id}
                    value={`${issue.external_id} ${issue.title}`}
                    data-checked={selectedIssue?.external_id === issue.external_id}
                    onSelect={() => handleIssueSelect(issue)}
                  >
                    <span className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-xs text-muted-foreground">{issue.external_id}</span>
                      <span className="text-sm truncate">{issue.title}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogTitle>New Task</DialogTitle>
        <DialogDescription className="sr-only">Create a new task for this project</DialogDescription>

        {error && (
          <div className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)}>
          {hasProvider ? (
            <Tabs defaultValue="branch">
              <TabsList>
                <TabsTrigger value="branch">From Branch</TabsTrigger>
                <TabsTrigger value="issue">From Issue</TabsTrigger>
              </TabsList>
              <TabsContent value="branch" className="mt-3">
                {formFields}
              </TabsContent>
              <TabsContent value="issue" className="mt-3">
                <div className="flex flex-col gap-3">
                  {issueCombobox}
                  {formFields}
                </div>
              </TabsContent>
            </Tabs>
          ) : (
            formFields
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
