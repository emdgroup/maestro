import { SettingsPage } from "@/views/settings/settings-page/SettingsPage";
import type { ConnectionKey } from "@/types/bindings";

interface SettingsViewProps {
  projectId: number;
  connection: ConnectionKey;
}

export function SettingsView({ projectId, connection }: SettingsViewProps) {
  return <SettingsPage projectId={projectId} connection={connection} />;
}
