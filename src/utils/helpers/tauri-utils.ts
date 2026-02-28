import { commands, type Result } from "@/types/bindings";

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
      return async (...args: unknown[]) => {
        const result = await (original as (...args: unknown[]) => Promise<unknown>)(...args);

        // Unwrap Result type using discriminated union check
        if (result && typeof result === "object" && "status" in result) {
          const typedResult = result as Result<unknown, unknown>;
          if (typedResult.status === "ok") {
            return typedResult.data;
          } else {
            throw new Error(String(typedResult.error));
          }
        }

        // Pass through non-Result values (shouldn't happen with current bindings)
        return result;
      };
    }

    return original;
  },
}) as unknown as UnwrapCommands<typeof commands>;
