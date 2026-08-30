import {
  useDockerConnections,
  useSshConnections,
  useWslConnections,
} from "@/services/connection.service";
import type { ConnectionKey } from "@/types/bindings";

/**
 * A name a user would recognise for a connection — "build-box", "Ubuntu-22.04" — for the
 * settings sidebar's scope heading.
 *
 * The three list queries are the ones the project picker already runs, so this reads from
 * cache rather than issuing anything new. Until they resolve, and for a connection that has
 * since been deleted, the type name stands in: a heading that says "SSH" is vague but never
 * wrong, which is what a heading whose whole job is to state scope has to be.
 */
export function useConnectionLabel(connection: ConnectionKey | undefined): string {
  const isSsh = connection?.type === "ssh";
  const isWsl = connection?.type === "wsl";
  const isDocker = connection?.type === "docker";

  const { data: sshConnections } = useSshConnections();
  const { data: wslConnections } = useWslConnections();
  const { data: dockerConnections } = useDockerConnections();

  if (!connection) return "";
  if (connection.type === "local") return "Local machine";

  if (isSsh) {
    const match = sshConnections?.find((c) => c.id === connection.id);
    return match?.display_name || match?.host || "SSH";
  }
  if (isWsl) {
    const match = wslConnections?.find((c) => c.id === connection.id);
    return match?.display_name || match?.distro_name || "WSL";
  }
  if (isDocker) {
    const match = dockerConnections?.find((c) => c.id === connection.id);
    return match?.display_name || match?.container_name || "Container";
  }
  return "";
}
