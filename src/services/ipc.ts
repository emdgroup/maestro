import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/**
 * Centralized IPC wrapper providing type-safe communication with the Rust backend.
 * All Tauri invoke() calls should go through this wrapper for consistent error handling and logging.
 */
export const ipc = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
      console.log(`[IPC] Calling ${command}`, args);
      const result = await tauriInvoke<T>(command, args);
      console.log(`[IPC] ${command} success`, result);
      return result;
    } catch (error) {
      console.error(`[IPC] ${command} failed`, error);
      throw new Error(
        `IPC command failed: ${command} - ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};
