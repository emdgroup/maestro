import { ipc } from "./ipc";

/**
 * Execution service providing type-safe operations for task execution and terminal management.
 * All execution and terminal-related IPC calls are centralized here.
 */
export const executionService = {
  /**
   * Attach to a task's execution terminal
   */
  async attachTerminal(
    taskId: number,
    outputChannel: string
  ): Promise<void> {
    return ipc.invoke<void>("attach_terminal", { taskId, outputChannel });
  },

  /**
   * Send input to a task's execution terminal
   */
  async sendTerminalInput(taskId: number, input: string): Promise<void> {
    return ipc.invoke<void>("send_terminal_input", { taskId, input });
  },

  /**
   * Resize execution terminal
   */
  async resizeTerminal(
    taskId: number,
    cols: number,
    rows: number
  ): Promise<void> {
    return ipc.invoke<void>("resize_terminal", { taskId, cols, rows });
  },

  /**
   * Detach from a task's execution terminal
   */
  async detachTerminal(taskId: number): Promise<void> {
    return ipc.invoke<void>("detach_terminal", { taskId });
  },
};
