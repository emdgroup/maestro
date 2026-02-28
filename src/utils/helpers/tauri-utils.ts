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
        // @ts-ignore
        const result_2 = await original(...args);
        // Unwrap Result type
        if (result_2 && typeof result_2 === "object" && "status" in result_2) {
          if (result_2.status === "ok") {
            return result_2.data;
          } else {
            throw new Error(result_2.error as string);
          }
        }
        return result_2;
      };
    }

    return original;
  },
}) as unknown as UnwrapCommands<typeof commands>;
