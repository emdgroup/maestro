import { useState } from "react";
import { useProjectSettings, useUpdateProjectSettings } from "@/services/project.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useListIntegrations } from "@/services/integration.service";
import { useSelectedProject } from "@/store/projectStore";
import { useConnectionLabel } from "@/hooks/useConnectionLabel";
import { cn } from "@/lib/utils";
import { UpdateStrip } from "@/components/settings/UpdateStrip";
import type { ConnectionKey, ProjectConfigRequest } from "@/types/bindings";
import { ProjectDefaultsSection } from "./ProjectDefaultsSection";
import { AppearanceSection } from "./AppearanceSection";
import { ProjectAppearanceSection } from "./ProjectAppearanceSection";
import { NotificationsSection } from "./NotificationsSection";
import { ConcurrencySection } from "./ConcurrencySection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { AgentProfilesSection } from "./AgentProfilesSection";
import { IssueTrackingSection } from "./IssueTrackingSection";
import { SettingsSidebar } from "./SettingsSidebar";
import { orderedPages, SETTINGS_PAGES } from "./settings-registry";

interface SettingsPageProps {
  /**
   * Both absent on the welcome screen, where there is no project and no connection to scope
   * anything to — the connection and project groups are then not registered at all, rather
   * than registered and disabled.
   */
  projectId?: number;
  connection?: ConnectionKey;
  /** Set by a host that overlays a control on the header bar's end — see `UpdateStrip`. */
  headerPadEnd?: boolean;
  /**
   * False when the host already provides the card — the picker's dialog is one, and nesting a
   * second rounded border inside it just draws the same edge twice.
   */
  framed?: boolean;
}

export function SettingsPage({
  projectId,
  connection,
  headerPadEnd,
  framed = true,
}: SettingsPageProps) {
  const inProject = projectId !== undefined && connection !== undefined;

  // Ordered here rather than only in the sidebar, so "the first page" — what opens by
  // default — is the one the sidebar shows at the top: a project page in a project, and
  // Updates on the welcome screen, where there is no nearer scope.
  const pages = orderedPages(
    inProject ? SETTINGS_PAGES : SETTINGS_PAGES.filter((p) => p.scope === "app"),
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // A page that the current host does not offer — a project page after the project closed,
  // or one filtered out of an earlier search — falls back to the first available one rather
  // than rendering nothing.
  const active = pages.find((p) => p.id === activeId) ?? pages[0];

  const projectLabel = useSelectedProject()?.name ?? "";
  const connectionLabel = useConnectionLabel(connection);

  // One card holding the whole surface: update strip as its header row, sidebar as its left
  // rail, and the content inset behind a rounded top-left corner the way AgentsView and
  // ExecutionSidePanel do it. The page around the card stays `bg-background`, so the card
  // reads as one object rather than as chrome wrapped around a document.
  return (
    <div className={cn("h-full overflow-hidden", framed && "p-4")}>
      <div
        className={cn(
          "mx-auto flex h-full flex-col overflow-hidden bg-card",
          framed && "max-w-6xl rounded-xl border border-border shadow-xs",
        )}
      >
        {/* No bottom border: the inset pane's own `border-t` is the seam, and it starts after
            the rounded corner so no line runs under the sidebar. */}
        <div className="shrink-0">
          <UpdateStrip padEnd={headerPadEnd} />
        </div>

        <div className="flex min-h-0 flex-1">
          <SettingsSidebar
            pages={pages}
            activeId={active?.id ?? ""}
            onSelect={setActiveId}
            query={query}
            onQueryChange={setQuery}
            connectionLabel={connectionLabel}
            projectLabel={projectLabel}
          />

          {/* Recessed to `bg-background`: the section cards inside are `bg-card`, so on a
              card-coloured well they would have no surface to sit on. */}
          <div className="min-h-0 flex-1 overflow-y-auto rounded-tl-xl border-t border-l border-border bg-background custom-scrollbar">
            <div className="mx-auto max-w-2xl p-6">
              <div className="mb-6">
                <h1 className="text-2xl font-semibold text-foreground">
                  {active?.label ?? "Settings"}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Changes are saved as you make them
                </p>
              </div>

              {active?.scope === "app" ? (
                <AppScopePane pageId={active.id} />
              ) : active && projectId !== undefined && connection ? (
                <ProjectScopePane
                  pageId={active.id}
                  projectId={projectId}
                  connection={connection}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppScopePane({ pageId }: { pageId: string }) {
  return (
    <div className="space-y-6">
      {pageId === "appearance" && <AppearanceSection />}
      {pageId === "notifications" && <NotificationsSection />}
      {pageId === "concurrency" && <ConcurrencySection />}
      {pageId === "diagnostics" && <DiagnosticsSection />}
    </div>
  );
}

/** Providers that only host repos and do not support issue tracking in Maestro. */
const REPOS_ONLY_PROVIDERS = new Set(["bitbucket"]);

function ProjectScopePane({
  pageId,
  projectId,
  connection,
}: {
  pageId: string;
  projectId: number;
  connection: ConnectionKey;
}) {
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

  if (projectSettingsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        Loading settings...
      </div>
    );
  }

  const issueTrackingIntegrations = (integrations?.filter((s) => s.connected) ?? []).filter(
    (s) => !REPOS_ONLY_PROVIDERS.has(s.provider),
  );

  return (
    <div className="space-y-6">
      {pageId === "project-defaults" && (
        <ProjectDefaultsSection
          defaultAgent={settings?.default_agent ?? null}
          defaultWorkspaceMode={settings?.default_workspace_mode ?? "NewWorktree"}
          onChange={updateSettings}
          agents={discovery?.agents ?? []}
          agentsLoading={agentsLoading}
          connection={connection}
        />
      )}
      {pageId === "agent-profiles" && (
        <AgentProfilesSection
          projectId={projectId}
          agents={discovery?.agents ?? []}
          connection={connection}
        />
      )}
      {pageId === "issue-tracking" && (
        <IssueTrackingSection
          projectId={projectId}
          issueTrackingIntegrations={issueTrackingIntegrations}
        />
      )}
      {pageId === "project-appearance" && <ProjectAppearanceSection />}
    </div>
  );
}
