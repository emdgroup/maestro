import { useMemo } from "react";
import { Container, Monitor, Server, SquareTerminal } from "lucide-react";
import { connectionKeyStr } from "@/lib/connection-utils";
import type {
  ConnectionKey,
  DockerConnection,
  SshConnection,
  WslConnection,
} from "@/types/bindings";
import {
  useDockerConnections,
  useSshConnections,
  useWslConnections,
} from "@/services/connection.service";

/** A connection as Home lists it. */
export interface HomeConnection {
  key: ConnectionKey;
  /** `connectionKeyStr(key)`, the id phases and minimized state are kept under. */
  id: string;
  name: string;
  /** The host under the name: the machine, `user@host`, `WSL`, or the container's image. */
  detail: string;
  ssh?: SshConnection;
  wsl?: WslConnection;
  docker?: DockerConnection;
}

export const CONNECTION_ICONS = {
  local: Monitor,
  ssh: Server,
  wsl: SquareTerminal,
  docker: Container,
};

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
        id: connectionKeyStr({ type: "ssh", id: connection.id }),
        name: connection.display_name ?? connection.host,
        detail: `${connection.username}@${connection.host}`,
        ssh: connection,
      })),
      ...wsl.map((connection) => ({
        key: { type: "wsl", id: connection.id } as ConnectionKey,
        id: connectionKeyStr({ type: "wsl", id: connection.id }),
        name: connection.display_name ?? connection.distro_name,
        detail: "WSL",
        wsl: connection,
      })),
      ...docker.map((connection) => ({
        key: { type: "docker", id: connection.id } as ConnectionKey,
        id: connectionKeyStr({ type: "docker", id: connection.id }),
        name: connection.display_name ?? connection.container_name,
        detail: connection.image_name ?? "Container",
        docker: connection,
      })),
    ],
    [ssh, wsl, docker],
  );
}
