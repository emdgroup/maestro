import { useProjectSettings, useUpdateProjectSettings } from "@/services/project.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useListIntegrations } from "@/services/integration.service";
import { UpdateCard } from "@/components/settings/UpdateCard";
import type { ConnectionKey, ProjectConfigRequest } from "@/types/bindings";
import { ProjectDefaultsSection } from "./ProjectDefaultsSection";
import { AppearanceSection } from "./AppearanceSection";
import { NotificationsSection } from "./NotificationsSection";
import { ConcurrencySection } from "./ConcurrencySection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { AgentProfilesSection } from "./AgentProfilesSection";
import { IssueTrackingSection } from "./IssueTrackingSection";

interface SettingsPageProps {
  projectId: number;
  connection: ConnectionKey;
}

export function SettingsPage({ projectId, connection }: SettingsPageProps) {
  const projectSettingsQuery = useProjectSettings(projectId);
  const updateProjectSettings = useUpdateProjectSettings();
  const { data: discovery, isLoading: agentsLoading } = useAgentDiscoveryQuery(connection);
  const { data: integrations } = useListIntegrations();

  const settings = projectSettingsQuery.data;

  // The command takes the whole request, so a patch has to be merged onto what is stored —
  // including `startup_tab`, which has no control here but must survive a write from one that has.
  function updateSettings(patch: Partial<ProjectConfigRequest>) {
    if (!settings) return;
    updateProjectSettings.mutate({
      projectId,
      config: {
        default_agent: settings.default_agent,
        startup_tab: settings.startup_tab,
        default_workspace_mode: settings.default_workspace_mode,
        ...patch,
      },
    });
  }

  const agents = discovery?.agents ?? [];

  // Providers that only host repos and do not support issue tracking in Maestro.
  const reposOnlyProviders = new Set(["bitbucket"]);
  const connectedIntegrations = integrations?.filter((s) => s.connected) ?? [];
  const issueTrackingIntegrations = connectedIntegrations.filter(
    (s) => !reposOnlyProviders.has(s.provider),
  );

  return (
    <div className="h-full">
      <div className="max-w-3xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">Changes are saved as you make them</p>
        </div>

        {projectSettingsQuery.isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            Loading settings...
          </div>
        ) : (
          <div className="space-y-6">
            <UpdateCard />
            <ProjectDefaultsSection
              defaultAgent={settings?.default_agent ?? null}
              defaultWorkspaceMode={settings?.default_workspace_mode ?? "NewWorktree"}
              onChange={updateSettings}
              agents={agents}
              agentsLoading={agentsLoading}
              connection={connection}
            />
            <AgentProfilesSection projectId={projectId} agents={agents} connection={connection} />
            <AppearanceSection />
            <ConcurrencySection />
            <NotificationsSection />
            <IssueTrackingSection
              projectId={projectId}
              issueTrackingIntegrations={issueTrackingIntegrations}
            />
            <DiagnosticsSection />
          </div>
        )}
      </div>
    </div>
  );
}
