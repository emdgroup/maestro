/**
 * Centralized service layer for all backend communication.
 * All services use TanStack Query hooks with the `api` proxy pattern.
 *
 * The `api` proxy automatically unwraps Tauri Result<T, E> types
 * and throws errors for React Query's error handling.
 */

// Re-export all hooks from individual services
export * from "./connection.service";
export * from "./execution.service";
export * from "./project.service";
export * from "./settings.service";
export * from "./task.service";
