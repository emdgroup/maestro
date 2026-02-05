import { useForm, SubmitHandler, Controller } from "react-hook-form";
import * as Select from "@radix-ui/react-select";
import { CreateTaskRequest } from "../types/bindings";
import "../styles/TaskForm.css";

export interface TaskFormData {
  title: string;
  description: string;
  acceptanceCriteria: string;
  skills: string[];
}

interface TaskFormProps {
  onSubmit: (data: CreateTaskRequest) => Promise<void>;
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

export function TaskForm({
  onSubmit,
  isLoading,
  onCancel,
  projectId,
}: TaskFormProps) {
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
    <form onSubmit={handleSubmit(submitHandler)} className="task-form">
      <div className="form-group">
        <label htmlFor="title">Title *</label>
        <input
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
          <span className="error-message">{errors.title.message}</span>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="description">Description *</label>
        <textarea
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
          <span className="error-message">{errors.description.message}</span>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="acceptanceCriteria">Acceptance Criteria *</label>
        <textarea
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
          <span className="error-message">
            {errors.acceptanceCriteria.message}
          </span>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="skills">Skills (Optional)</label>
        <Controller
          name="skills"
          control={control}
          render={({ field: { value, onChange } }) => (
            <div>
              <Select.Root value={value.length > 0 ? value[0] : ""} onValueChange={(newVal) => {
                if (value.includes(newVal)) {
                  onChange(value.filter(s => s !== newVal));
                } else {
                  onChange([...value, newVal]);
                }
              }}>
                <Select.Trigger className="select-trigger">
                  <Select.Value placeholder="Select skills..." />
                </Select.Trigger>
                <Select.Content className="select-content">
                  <Select.Viewport>
                    {AVAILABLE_SKILLS.map((skill) => (
                      <Select.Item key={skill} value={skill} className="select-item">
                        <Select.ItemText>{skill}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Root>
              {value.length > 0 && (
                <div className="skills-selected">
                  {value.map((skill) => (
                    <span key={skill} className="skill-badge">
                      {skill}
                      <button
                        type="button"
                        onClick={() =>
                          onChange(value.filter(s => s !== skill))
                        }
                        className="skill-remove"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        />
      </div>

      <div className="form-actions">
        <button
          type="submit"
          disabled={isLoading}
          className="btn-submit"
        >
          {isLoading ? "Creating..." : "Create Task"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isLoading}
          className="btn-cancel"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
