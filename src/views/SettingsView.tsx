import { forwardRef } from "react";
import { SettingsPage, SettingsPageHandle } from "@/components/common/SettingsPage";

interface SettingsViewProps {
  projectId: number;
}

/**
 * SettingsView - Page-level orchestrator for the project settings screen
 * Manages model defaults, MCP servers, and skills configuration
 */
export const SettingsView = forwardRef<SettingsPageHandle, SettingsViewProps>(
  ({ projectId }, ref) => {
    return <SettingsPage ref={ref} projectId={projectId} />;
  },
);

SettingsView.displayName = "SettingsView";
