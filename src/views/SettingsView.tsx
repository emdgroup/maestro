import { forwardRef } from "react";
import { SettingsPage, SettingsPageHandle } from "@/components/common/SettingsPage";

interface SettingsViewProps {
  projectId: number;
  connectionId: number | null;
}

export const SettingsView = forwardRef<SettingsPageHandle, SettingsViewProps>(
  ({ projectId, connectionId }, ref) => {
    return <SettingsPage ref={ref} projectId={projectId} connectionId={connectionId} />;
  },
);

SettingsView.displayName = "SettingsView";
