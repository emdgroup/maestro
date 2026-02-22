/**
 * Mock Tauri API for browser-only development (remote SSH without X11)
 * This allows the app to run in a browser without the Tauri runtime
 */

import type { Task } from "../types/bindings";

// Helper to check if Tauri is available (checked at call time, not module load time)
function checkTauriAvailable(): boolean {
  return typeof (window as any).__TAURI__ !== "undefined";
}

// Wait for Tauri to be available (gives it time to initialize)
async function waitForTauri(timeoutMs: number = 5000): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (checkTauriAvailable()) {
      console.log("[Tauri] Runtime detected and ready");
      return true;
    }
    // Wait 50ms before checking again
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  console.error("[Tauri] Runtime not available after", timeoutMs, "ms");
  return false;
}

// Build-time mock exclusion: This entire block is removed from production via Vite tree-shaking.
// Vite replaces import.meta.env.DEV with 'false' during production build, and tree-shaking
// removes the unreachable if (false) branch. This prevents mock code bloat in release builds.
// See CLAUDE.md "Build-Time Mock Exclusion" section for details.
if ((import.meta as any).env.DEV) {
  // In-memory mock database for browser-only development
  var mockDB = {
    tasks: [] as Task[],
    nextTaskId: 1,
    importSettings: null as any,
  };
}

// Production fallback: Always available for production use when Tauri is not available.
// In production builds (import.meta.env.DEV = false), mock handlers are tree-shaken away
// and only the Tauri real invoke or error path is included in the bundle.
export async function invoke<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  // Check if Tauri is available right now
  if (checkTauriAvailable()) {
    // Use real Tauri API
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke(cmd, args);
  }

  // If not available immediately, wait for it (might still be initializing)
  console.log("[Tauri] Runtime not immediately available, waiting...");
  const available = await waitForTauri();

  if (available) {
    // Tauri initialized after waiting
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke(cmd, args);
  }

  // Dev-only mock responses (tree-shaken in production)
  if ((import.meta as any).env.DEV) {
    // Mock responses for browser-only development
    console.log(`[MOCK] invoke('${cmd}', ${JSON.stringify(args)})`);

    switch (cmd) {
      case "get_settings":
        return {
          project_path: "/home/m306213/workspace/gsd-demo",
          recent_projects: ["/home/m306213/workspace/gsd-demo"],
          model_default: "claude-opus-4-5",
          mcp_defaults: null,
          skills_defaults: null,
          updated_at: new Date().toISOString(),
        } as T;

      case "get_or_create_project":
        return {
          id: 1,
          path: args?.path || "/home/m306213/workspace/gsd-demo",
          name: "gsd-demo",
          created_at: new Date().toISOString(),
        } as T;

      case "get_tasks":
        console.log(`[MOCK] Returning ${(mockDB as any).tasks.length} tasks`);
        // Return a deep clone to prevent React from freezing the array
        return JSON.parse(JSON.stringify((mockDB as any).tasks)) as T;

      case "create_task": {
        const newTask: Task = {
          id: (mockDB as any).nextTaskId++,
          project_id: args?.project_id || 1,
          name: args?.name || "New Task",
          description: args?.description || "",
          acceptance_criteria: args?.acceptance_criteria || "",
          skills: Array.isArray(args?.skills) ? [...args.skills] : [],
          status: "Backlog",
          external_id: undefined,
          is_imported: false,
          import_source: undefined,
          model_override: undefined,
          mcp_allowlist: undefined,
          skills_override: undefined,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        (mockDB as any).tasks.push(newTask);
        console.log(`[MOCK] Created task #${newTask.id}: ${newTask.name}`);
        return JSON.parse(JSON.stringify(newTask)) as T;
      }

      case "update_task": {
        const task = (mockDB as any).tasks.find((t: any) => t.id === args?.task_id);
        if (task) {
          if (args?.status) task.status = args.status;
          if (args?.description) task.description = args.description;
          task.updated_at = new Date().toISOString();
          console.log(`[MOCK] Updated task #${task.id}: status=${task.status}`);
          return task as T;
        }
        return {} as T;
      }

      case "save_settings":
        console.log("[MOCK] Settings saved (no persistence)");
        return undefined as T;

      case "save_import_config":
        (mockDB as any).importSettings = {
          provider: args?.provider,
          config: args?.config,
        };
        console.log(`[MOCK] Import config saved: provider=${args?.provider}`);
        return undefined as T;

      case "sync_github_issues": {
        console.log("[MOCK] Syncing GitHub issues...");
        // Mock response with 3 sample issues
        return {
          imported_count: 3,
          updated_count: 1,
          error_message: null,
        } as T;
      }

      case "sync_jira_issues": {
        console.log("[MOCK] Syncing Jira issues...");
        // Mock response with 2 sample issues
        return {
          imported_count: 2,
          updated_count: 0,
          error_message: null,
        } as T;
      }

      default:
        throw new Error(`Mock not implemented for command: ${cmd}`);
    }
  }

  throw new Error(
    `Tauri environment not available. Command: ${cmd}. This likely means the app is running in a browser without the Tauri runtime.`,
  );
}

export const tauriMock = {
  invoke,
  checkTauriAvailable,
};
