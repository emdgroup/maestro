/**
 * Mock Tauri API for browser-only development (remote SSH without X11)
 * This allows the app to run in a browser without the Tauri runtime
 */

import type { Task } from '../types/bindings';

// Check if we're running in a real Tauri environment
const isTauri = typeof (window as any).__TAURI__ !== 'undefined';

// In-memory mock database for browser-only development
const mockDB = {
  tasks: [] as Task[],
  nextTaskId: 1,
  importSettings: null as any,
};

// Mock invoke function for browser-only mode
export async function invoke<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (isTauri) {
    // Use real Tauri API
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke(cmd, args);
  }

  // Mock responses for browser-only development
  console.log(`[MOCK] invoke('${cmd}', ${JSON.stringify(args)})`);

  switch (cmd) {
    case 'get_settings':
      return {
        project_path: '/home/m306213/workspace/gsd-demo',
        recent_projects: ['/home/m306213/workspace/gsd-demo'],
        model_default: 'claude-opus-4-5',
        mcp_defaults: null,
        skills_defaults: null,
        updated_at: new Date().toISOString(),
      } as T;

    case 'get_or_create_project':
      return {
        id: 1,
        path: args?.path || '/home/m306213/workspace/gsd-demo',
        name: 'gsd-demo',
        created_at: new Date().toISOString(),
      } as T;

    case 'get_tasks':
      console.log(`[MOCK] Returning ${mockDB.tasks.length} tasks`);
      return mockDB.tasks as T;

    case 'create_task': {
      const newTask: Task = {
        id: mockDB.nextTaskId++,
        project_id: args?.project_id || 1,
        name: args?.name || 'New Task',
        description: args?.description || '',
        acceptance_criteria: args?.acceptance_criteria || '',
        skills: args?.skills || [],
        status: 'Backlog',
        external_id: undefined,
        is_imported: false,
        import_source: undefined,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      mockDB.tasks.push(newTask);
      console.log(`[MOCK] Created task #${newTask.id}: ${newTask.name}`);
      return newTask as T;
    }

    case 'update_task': {
      const task = mockDB.tasks.find(t => t.id === args?.task_id);
      if (task) {
        if (args?.status) task.status = args.status;
        if (args?.description) task.description = args.description;
        task.updated_at = new Date().toISOString();
        console.log(`[MOCK] Updated task #${task.id}: status=${task.status}`);
        return task as T;
      }
      return {} as T;
    }

    case 'save_settings':
      console.log('[MOCK] Settings saved (no persistence)');
      return undefined as T;

    case 'save_import_config':
      mockDB.importSettings = {
        provider: args?.provider,
        config: args?.config,
      };
      console.log(`[MOCK] Import config saved: provider=${args?.provider}`);
      return undefined as T;

    case 'sync_github_issues': {
      console.log('[MOCK] Syncing GitHub issues...');
      // Mock response with 3 sample issues
      return {
        imported_count: 3,
        updated_count: 1,
        error_message: null,
      } as T;
    }

    case 'sync_jira_issues': {
      console.log('[MOCK] Syncing Jira issues...');
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

export const tauriMock = {
  invoke,
  isTauri,
};
