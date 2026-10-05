import { useMemo } from "react";
import type { ConnectionKey } from "@/types/bindings";
import {
  useDockerConnections,
  useSshConnections,
  useWslConnections,
} from "@/services/connection.service";
import { connectionKeyId } from "@/store/homeStore";
import type { HomeConnection } from "./ConnectionPanel";

const LOCAL: ConnectionKey = { type: "local" };

/** Every saved connection, This computer first. Home lists them, and so does the header's path. */
export function useHomeConnections(): HomeConnection[] {
  const { data: ssh = [] } = useSshConnections();
  const { data: wsl = [] } = useWslConnections();
  const { data: docker = [] } = useDockerConnections();
  return useMemo(
    () => [
      { key: LOCAL, id: "local", name: "This computer", detail: "" },
      ...ssh.map((connection) => ({
        key: { type: "ssh", id: connection.id } as ConnectionKey,
        id: connectionKeyId({ type: "ssh", id: connection.id }),
        name: connection.display_name ?? connection.host,
        detail: `${connection.username}@${connection.host}`,
        ssh: connection,
      })),
      ...wsl.map((connection) => ({
        key: { type: "wsl", id: connection.id } as ConnectionKey,
        id: connectionKeyId({ type: "wsl", id: connection.id }),
        name: connection.display_name ?? connection.distro_name,
        detail: "WSL",
        wsl: connection,
      })),
      ...docker.map((connection) => ({
        key: { type: "docker", id: connection.id } as ConnectionKey,
        id: connectionKeyId({ type: "docker", id: connection.id }),
        name: connection.display_name ?? connection.container_name,
        detail: connection.image_name ?? "Container",
        docker: connection,
      })),
    ],
    [ssh, wsl, docker],
  );
}
