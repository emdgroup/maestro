import { ProjectPicker } from "@/components/project-picker";
import React from "react";
import { ConnectionProvider } from "@/contexts/ConnectionContext.tsx";

/**
 * ProjectPickerView - Page-level orchestrator for the project selection first-run screen
 * Enables users to select an existing project or create a new one
 * Displayed before project is loaded in the initialization flow
 */
export const ProjectPickerView: React.FC = () => (
  <ConnectionProvider>
    <ProjectPicker />
  </ConnectionProvider>
);
