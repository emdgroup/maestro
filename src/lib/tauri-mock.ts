/**
 * Mock Tauri API for browser-only development (remote SSH without X11)
 * This allows the app to run in a browser without the Tauri runtime
 */

// Check if we're running in a real Tauri environment
const isTauri = typeof (window as any).__TAURI__ !== 'undefined';

// Mock invoke function for browser-only mode
export async function invoke<T>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (isTauri) {
    // Use real Tauri API
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke(cmd, args);
  }

  // Mock responses for browser-only development
  console.warn(`[MOCK] invoke('${cmd}', ${JSON.stringify(args)})`);

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
      return [] as T;

    case 'create_task':
      return {
        id: Date.now(),
        project_id: args?.project_id || 1,
        name: args?.name || 'New Task',
        description: args?.description || '',
        acceptance_criteria: args?.acceptance_criteria || '',
        skills: args?.skills || [],
        status: 'backlog',
        external_id: null,
        is_imported: false,
        import_source: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as T;

    case 'update_task':
      return {} as T;

    case 'save_settings':
      return undefined as T;

    default:
      throw new Error(`Mock not implemented for command: ${cmd}`);
  }
}

export const tauriMock = {
  invoke,
  isTauri,
};
