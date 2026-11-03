import type { ConnectionKey, Project } from "@/types/bindings";

export function connectionKeyFromProject(project: Project): ConnectionKey {
  if (project.docker_connection_id != null)
    return { type: "docker", id: project.docker_connection_id };
  if (project.wsl_connection_id != null) return { type: "wsl", id: project.wsl_connection_id };
  if (project.connection_id != null) return { type: "ssh", id: project.connection_id };
  return { type: "local" };
}

export function connectionKeysEqual(a: ConnectionKey, b: ConnectionKey): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "local") return true;
  return (a as { id: number }).id === (b as { id: number }).id;
}

/**
 * Stable string key for a connection (`local`, `ssh:3`): for useEffect dep arrays, query keys and
 * the stores' per-connection maps.
 */
export function connectionKeyStr(key: ConnectionKey): string {
  if (key.type === "local") return "local";
  return `${key.type}:${key.id}`;
}

/**
 * The id the backend names a connection's event channels with (`local`, `ssh-3`), as in
 * `acp://auth-output/ssh-3`. Must match `connection_key_id` in `src-tauri/src/acp/auth_handlers.rs`.
 */
export function connectionChannelId(key: ConnectionKey): string {
  if (key.type === "local") return "local";
  return `${key.type}-${key.id}`;
}
