/**
 * Production-safe IPC wrapper for Tauri commands with comprehensive logging.
 *
 * This wrapper ensures all IPC calls are visible in browser console for production debugging.
 * All invocations, successes, and errors are logged with [Tauri] prefix for easy filtering.
 *
 * In dev mode, automatically uses mock responses when Tauri is not available (browser-only dev).
 * In production, always uses real Tauri API.
 *
 * Usage:
 *   import { safeInvoke } from './tauri-safe';
 *
 *   // Load project - all steps logged to console
 *   const project = await safeInvoke<Project>('get_or_create_project', { path });
 *
 *   // Errors are logged before throwing, visible in DevTools even in production
 *   try {
 *     await safeInvoke('save_settings', { settings });
 *   } catch (err) {
 *     // err logged with full details above in console.error
 *   }
 */

import { invoke } from "./tauri-mock";

/**
 * Safe wrapper around Tauri's invoke command with full logging.
 *
 * @template T The expected return type
 * @param command The Tauri command to invoke
 * @param args Optional arguments to pass to the command
 * @returns Promise resolving to the command result
 * @throws Error if the command fails (after logging)
 *
 * Console output:
 * - [Tauri] Invoking {command} with args: {args}  (at start)
 * - [Tauri] Success {command}: {result}           (on success)
 * - [Tauri] Error {command}: {error}              (on error, before throw)
 */
export async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // Log the invocation with command and arguments
  console.log(`[Tauri] Invoking ${command}${args ? ` with args: ${JSON.stringify(args)}` : ""}`);

  try {
    // Call invoke (which handles both real Tauri and dev mock automatically)
    const result = await invoke<T>(command, args);

    // Log success with result
    console.log(`[Tauri] Success ${command}:`, result);

    return result;
  } catch (error) {
    // Log error before rethrowing - ensure it's visible in production
    console.error(`[Tauri] Error ${command}:`, error);

    // Rethrow the error so calling code can handle it
    throw error;
  }
}

export default safeInvoke;
