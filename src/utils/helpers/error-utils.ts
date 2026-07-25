/**
 * Error handling utilities
 */

import { toast } from "sonner";

/**
 * Extract error message from Error objects or any value
 * Safely converts various error types to readable messages
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Prefix the Rust side uses to mark a project that is already open in another Maestro instance.
 * Defined as `PROJECT_LOCKED_PREFIX` in `src-tauri/src/project/lock.rs`; the two must be
 * changed together.
 */
const PROJECT_LOCKED_PREFIX = "PROJECT_LOCKED:";

/**
 * True when a failure means the project is held by another Maestro instance, rather than
 * having failed for some other reason. Callers use this to show a specific message instead
 * of the raw error.
 */
export function isProjectLockedError(error: unknown): boolean {
  return getErrorMessage(error).includes(PROJECT_LOCKED_PREFIX);
}

/**
 * Create a standardized error toast handler for React Query mutations
 * @param actionName - Human-readable description of the failed action (e.g., "Failed to create task")
 */
export function createErrorToastHandler(actionName: string) {
  return (error: unknown) => {
    toast.error(`${actionName}: ${getErrorMessage(error)}`);
  };
}
