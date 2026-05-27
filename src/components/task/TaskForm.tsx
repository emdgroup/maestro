import { useEffect } from "react";
import { useForm, SubmitHandler, Controller } from "react-hook-form";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import type { Task } from "@/types/bindings";
import { useProjectBranchesQuery } from "@/services/task.service";

export interface TaskFormData {
  title: string;
  description: string;
  priority: "Urgent" | "High" | "Medium" | "Low" | "None";
  baseBranch: string;
}

interface TaskFormProps {
  onSubmit: (data: Task) => Promise<void>;
  isLoading: boolean;
  onCancel: () => void;
  projectId: number;
  initialValues?: Partial<TaskFormData>;
  submitLabel?: string;
}

export function TaskForm({
  onSubmit,
  isLoading,
  onCancel,
  projectId,
  initialValues,
  submitLabel = "Create Task",
}: TaskFormProps) {
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<TaskFormData>({
    mode: "onBlur",
    defaultValues: {
      priority: "Medium",
      baseBranch: initialValues?.baseBranch ?? "",
      ...initialValues,
    },
  });

  const { data: branchData } = useProjectBranchesQuery(projectId);
  const branches: string[] = branchData ? [...branchData[0].local, ...branchData[0].remote] : [];
  const currentBranch: string = branchData ? branchData[1] : "";

  // Set default origin branch to the current checked-out branch when
  // branch data loads and form has no initial value
  useEffect(() => {
    if (currentBranch && !initialValues?.baseBranch) {
      setValue("baseBranch", currentBranch);
    }
  }, [currentBranch, initialValues?.baseBranch, setValue]);

  const submitHandler: SubmitHandler<TaskFormData> = async (data) => {
    try {
      await onSubmit({
        created_at: "",
        id: 0,
        status: "Backlog",
        priority: data.priority,
        base_branch: data.baseBranch,
        updated_at: "",
        project_id: projectId,
        title: data.title,
        description: data.description,
        skills: [],
        labels: [],
        auto_approve: false,
        isolated_worktree: true,
      });
    } catch (error) {
      console.error("Form submission error:", error);
    }
  };

  return (
    <form onSubmit={handleSubmit(submitHandler)} className="flex flex-col gap-6 py-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="title">Title *</Label>
        <Input
          id="title"
          type="text"
          placeholder="Task title"
          {...register("title", {
            required: "Title is required",
            minLength: {
              value: 3,
              message: "Title must be at least 3 characters",
            },
            maxLength: {
              value: 100,
              message: "Title must be at most 100 characters",
            },
          })}
        />
        {errors.title && (
          <span className="text-destructive text-xs mt-1">{errors.title.message}</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="description">Description *</Label>
        <Textarea
          id="description"
          placeholder="Task description (min 10 characters)"
          rows={4}
          {...register("description", {
            required: "Description is required",
            minLength: {
              value: 10,
              message: "Description must be at least 10 characters",
            },
          })}
        />
        {errors.description && (
          <span className="text-destructive text-xs mt-1">{errors.description.message}</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="priority">Priority</Label>
        <Controller
          name="priority"
          control={control}
          render={({ field: { value, onChange } }) => (
            <Select value={value} onValueChange={onChange}>
              <SelectTrigger id="priority" className="w-full">
                <SelectValue placeholder="Select priority..." />
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

      <div className="flex flex-col gap-2">
        <Label htmlFor="baseBranch">Base Branch *</Label>
        <Controller
          name="baseBranch"
          control={control}
          rules={{ required: "Base branch is required" }}
          render={({ field: { value, onChange } }) => (
            <Select value={value} onValueChange={onChange}>
              <SelectTrigger id="baseBranch" className="w-full">
                <SelectValue placeholder="Select branch..." />
              </SelectTrigger>
              <SelectContent>
                {branches.map((branch) => (
                  <SelectItem key={branch} value={branch}>
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        {errors.baseBranch && (
          <span className="text-destructive text-xs mt-1">{errors.baseBranch.message}</span>
        )}
      </div>

      <div className="flex gap-4 mt-4 justify-end">
        <Button type="submit" disabled={isLoading}>
          {isLoading ? `${submitLabel}...` : submitLabel}
        </Button>
        <Button type="button" onClick={onCancel} disabled={isLoading} variant="outline">
          Cancel
        </Button>
      </div>
    </form>
  );
}
