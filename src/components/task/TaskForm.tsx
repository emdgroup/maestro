import { useForm, SubmitHandler, Controller } from "react-hook-form";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Badge } from "@/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import type { Task } from "@/types";

export interface TaskFormData {
  title: string;
  description: string;
  acceptanceCriteria: string;
  skills: string[];
}

interface TaskFormProps {
  onSubmit: (data: Task) => Promise<void>;
  isLoading: boolean;
  onCancel: () => void;
  projectId: number;
}

const AVAILABLE_SKILLS = [
  "debugging",
  "testing",
  "documentation",
  "performance",
  "security",
  "refactoring",
];

export function TaskForm({ onSubmit, isLoading, onCancel, projectId }: TaskFormProps) {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<TaskFormData>({
    mode: "onBlur",
    defaultValues: {
      skills: [],
    },
  });

  const submitHandler: SubmitHandler<TaskFormData> = async (data) => {
    try {
      await onSubmit({
        created_at: "",
        id: 0,
        status: "Backlog",
        updated_at: "",
        project_id: projectId,
        name: data.title,
        description: data.description,
        acceptance_criteria: data.acceptanceCriteria,
        skills: data.skills,
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
        <Label htmlFor="acceptanceCriteria">Acceptance Criteria *</Label>
        <Textarea
          id="acceptanceCriteria"
          placeholder="Acceptance criteria (min 10 characters)"
          rows={4}
          {...register("acceptanceCriteria", {
            required: "Acceptance criteria is required",
            minLength: {
              value: 10,
              message: "Acceptance criteria must be at least 10 characters",
            },
          })}
        />
        {errors.acceptanceCriteria && (
          <span className="text-destructive text-xs mt-1">{errors.acceptanceCriteria.message}</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="skills">Skills (Optional)</Label>
        <Controller
          name="skills"
          control={control}
          render={({ field: { value, onChange } }) => (
            <div>
              <Select
                value={value.length > 0 ? value[0] : ""}
                onValueChange={(newVal) => {
                  if (newVal && value.includes(newVal)) {
                    onChange(value.filter((s) => s !== newVal));
                  } else {
                    onChange([...value, newVal]);
                  }
                }}
              >
                <SelectTrigger id="skills" className="w-full">
                  <SelectValue placeholder="Select skills..." />
                </SelectTrigger>
                <SelectContent>
                  {AVAILABLE_SKILLS.map((skill) => (
                    <SelectItem key={skill} value={skill}>
                      {skill}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {value.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {value.map((skill) => (
                    <Badge key={skill} variant="default" className="gap-2 py-1.5 px-3">
                      {skill}
                      <button
                        type="button"
                        onClick={() => onChange(value.filter((s) => s !== skill))}
                        className="text-lg opacity-80 hover:opacity-100 transition-opacity"
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
        />
      </div>

      <div className="flex gap-4 mt-4 justify-end">
        <Button type="submit" disabled={isLoading}>
          {isLoading ? "Creating..." : "Create Task"}
        </Button>
        <Button type="button" onClick={onCancel} disabled={isLoading} variant="outline">
          Cancel
        </Button>
      </div>
    </form>
  );
}
