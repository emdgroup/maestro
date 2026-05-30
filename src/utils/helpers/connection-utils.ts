import type { ConnectionKey, Project } from "@/types/bindings";

export function connectionKeyFromProject(project: Project): ConnectionKey {
  if (project.wsl_connection_id != null) return { type: "wsl", id: project.wsl_connection_id };
  if (project.connection_id != null) return { type: "ssh", id: project.connection_id };
  return { type: "local" };
}

export function connectionKeysEqual(a: ConnectionKey, b: ConnectionKey): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "local") return true;
  return (a as { id: number }).id === (b as { id: number }).id;
}

/** Stable string key for use in useEffect dep arrays and query keys. */
export function connectionKeyStr(key: ConnectionKey): string {
  if (key.type === "local") return "local";
  return `${key.type}:${key.id}`;
}
