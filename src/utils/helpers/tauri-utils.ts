import { commands, type Result } from "@/types/bindings";

/**
 * Tauri IPC Communication Utilities
 *
 * This module provides utilities for communicating with the Rust backend:
 *
 * 1. `api` (recommended): Proxy that automatically unwraps Result types
 *    - Usage: `await api.getProjects()`
 *    - Returns: `Promise<T>` (throws on error)
 *    - Benefits: Less boilerplate, same type safety
 *
 * 2. `unwrap` (legacy): Manual unwrapping function
 *    - Usage: `await unwrap(commands.getProjects())`
 *    - Deprecated: Use `api` proxy instead
 *
 * All service files should use the `api` proxy for consistency.
 */

/**
 * Unwraps a Tauri Result<T, E> into a Promise<T>
 * Throws the error if the result is an error status
 * This makes Tauri commands compatible with React Query's error handling
 *
 * @deprecated Use `api` proxy instead for automatic unwrapping
 */
export async function unwrap<T, E>(resultPromise: Promise<Result<T, E>>): Promise<T> {
  const result = await resultPromise;
  if (result.status === "ok") {
    return result.data;
  } else {
    throw new Error(result.error as string);
  }
}

/**
 * Type transformation: Convert commands returning Promise<Result<T, E>>
 * to functions returning Promise<T>
 */
type UnwrapCommands<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<Result<infer R, any>>
    ? (...args: A) => Promise<R>
    : T[K];
};

/**
 * Proxy wrapper around Tauri commands that automatically unwraps Result types.
 *
 * Usage:
 * ```typescript
 * // Before
 * const projects = await unwrap(commands.getProjects());
 *
 * // After
 * const projects = await api.getProjects();
 * ```
 *
 * All methods maintain the same signatures but return Promise<T> instead of Promise<Result<T, E>>.
 * Errors are thrown and can be caught by React Query's error handling.
 */
export const api = new Proxy(commands, {
  get(target, prop: string | symbol) {
    const original = target[prop as keyof typeof commands];

    // Only wrap functions, pass through other properties
    if (typeof original === "function") {
      return (...args: unknown[]) => {
        return original(...args).then((result: any) => {
          // Unwrap Result type
          if (result && typeof result === "object" && "status" in result) {
            if (result.status === "ok") {
              return result.data;
            } else {
              throw new Error(result.error as string);
            }
          }
          // Pass through non-Result values (shouldn't happen with current bindings)
          return result;
        });
      };
    }

    return original;
  },
}) as unknown as UnwrapCommands<typeof commands>;
