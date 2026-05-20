import { forwardRef } from "react";
import { SettingsPage, SettingsPageHandle } from "@/components/common/SettingsPage";

interface SettingsViewProps {
  projectId: number;
  connectionId: number | null;
  wslConnectionId?: number | null;
}

export const SettingsView = forwardRef<SettingsPageHandle, SettingsViewProps>(
  ({ projectId, connectionId, wslConnectionId }, ref) => {
    return <SettingsPage ref={ref} projectId={projectId} connectionId={connectionId} wslConnectionId={wslConnectionId} />;
  },
);

SettingsView.displayName = "SettingsView";
