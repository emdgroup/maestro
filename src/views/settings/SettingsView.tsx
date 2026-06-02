import { forwardRef } from "react";
import { SettingsPage, SettingsPageHandle } from "@/views/settings/settings-page/SettingsPage";
import type { ConnectionKey } from "@/types/bindings";

interface SettingsViewProps {
  projectId: number;
  connection: ConnectionKey;
}

export const SettingsView = forwardRef<SettingsPageHandle, SettingsViewProps>(
  ({ projectId, connection }, ref) => {
    return (
      <SettingsPage
        ref={ref}
        projectId={projectId}
        connection={connection}
      />
    );
  },
);

SettingsView.displayName = "SettingsView";
