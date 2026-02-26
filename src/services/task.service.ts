import { ipc } from "./ipc";
import type {
  Task,
  CreateTaskRequest,
  ExecutionLog,
  ProjectConfigResponse,
  ProjectConfigRequest,
} from "@/types/bindings";

/**
 * Task service providing type-safe operations for task management.
 * All task-related IPC calls are centralized here.
 */
export const taskService = {
  /**
   * Get all tasks for a project
   */
  async getTasks(projectId: number): Promise<Task[]> {
    return ipc.invoke<Task[]>("get_tasks", { projectId });
  },

  /**
   * Create a new task
   */
  async createTask(request: CreateTaskRequest): Promise<Task> {
    return ipc.invoke<Task>("create_task", { request });
  },

  /**
   * Update task status and other properties
   */
  async updateTask(taskId: number, updates: Partial<Task>): Promise<Task> {
    return ipc.invoke<Task>("update_task", { taskId, updates });
  },

  /**
   * Update task status (convenience method)
   */
  async updateTaskStatus(taskId: number, status: string): Promise<Task> {
    return ipc.invoke<Task>("update_task_status", { taskId, status });
  },

  /**
   * Get execution logs for a task
   */
  async getExecutionLogs(taskId: number): Promise<ExecutionLog[]> {
    return ipc.invoke<ExecutionLog[]>("get_execution_logs", { taskId });
  },

  /**
   * Retry execution of a task
   */
  async retryExecution(logId: number): Promise<ExecutionLog> {
    return ipc.invoke<ExecutionLog>("retry_execution", { logId });
  },

  /**
   * Cancel execution of a task
   */
  async cancelExecution(logId: number): Promise<void> {
    return ipc.invoke<void>("cancel_execution", { logId });
  },

  /**
   * Get task settings/configuration
   */
  async getTaskSettings(projectId: number, taskId: number): Promise<ProjectConfigResponse> {
    return ipc.invoke<ProjectConfigResponse>("get_project_settings", { projectId, taskId });
  },

  /**
   * Update task settings/configuration
   */
  async updateTaskSettings(
    projectId: number,
    taskId: number,
    config: ProjectConfigRequest
  ): Promise<ProjectConfigResponse> {
    return ipc.invoke<ProjectConfigResponse>("update_task_settings", {
      projectId,
      taskId,
      config,
    });
  },

  /**
   * Get diff for review
   */
  async getDiffForReview(taskId: number): Promise<string> {
    return ipc.invoke<string>("get_diff_for_review", { taskId });
  },
};
