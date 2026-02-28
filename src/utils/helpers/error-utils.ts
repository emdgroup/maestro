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
 * Create a standardized error toast handler for React Query mutations
 * @param actionName - Human-readable description of the failed action (e.g., "Failed to create task")
 */
export function createErrorToastHandler(actionName: string) {
  return (error: unknown) => {
    toast.error(`${actionName}: ${getErrorMessage(error)}`);
  };
}
