import { WorkspaceFilesPanel } from "@/components/execution/side-panel/WorkspaceFilesPanel";
import { useWslConnections } from "@/services/connection.service";
import { useFileSessionStore, type FileSession } from "@/store/fileSessionStore";
import type { ConnectionKey } from "@/types/bindings";

/** The Files tab of an agent session's side panel, on its own. */
export function FileSessionPanel({
  session,
  connection,
  isActive,
}: {
  session: FileSession;
  connection: ConnectionKey;
  isActive: boolean;
}) {
  const setDirty = useFileSessionStore((s) => s.setDirty);
  const { data: wslConnections } = useWslConnections();
  const wslDistroName =
    connection.type === "wsl"
      ? (wslConnections?.find((c) => c.id === connection.id)?.distro_name ?? undefined)
      : undefined;

  return (
    <WorkspaceFilesPanel
      workspacePath={session.cwd}
      connection={connection}
      wslDistroName={wslDistroName}
      isActive={isActive}
      onDirtyChange={(dirty) => setDirty(session.session_id, dirty)}
    />
  );
}
