import { forwardRef } from "react";
import { SettingsPage, SettingsPageHandle } from "@/components/common/SettingsPage";

interface SettingsViewProps {
  projectId: number;
  connectionId: number | null;
  projectPath: string;
}

export const SettingsView = forwardRef<SettingsPageHandle, SettingsViewProps>(
  ({ projectId, connectionId, projectPath }, ref) => {
    return (
      <SettingsPage
        ref={ref}
        projectId={projectId}
        connectionId={connectionId}
        projectPath={projectPath}
      />
    );
  },
);

SettingsView.displayName = "SettingsView";
