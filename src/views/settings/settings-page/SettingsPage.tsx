import { useEffect, useState } from "react";
import { useProjectSettings, useUpdateProjectSettings } from "@/services/project.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useListIntegrations } from "@/services/integration.service";
import { useIsGitRepo, useSelectedProject } from "@/store/projectStore";
import { useNavigationActions, usePendingSettingsPage } from "@/store/navigationStore";
import { useConnectionLabel } from "@/hooks/useConnectionLabel";
import { cn } from "@/lib/utils";
import { UpdateStrip } from "@/components/settings/UpdateStrip";
import type { ConnectionKey, ProjectConfigRequest } from "@/types/bindings";
import { AgentDefaultsSection } from "./AgentDefaultsSection";
import { GitSection } from "./GitSection";
import { CodeHostingSection } from "./CodeHostingSection";
import { AppearanceSection } from "./AppearanceSection";
import { ProjectAppearanceSection } from "./ProjectAppearanceSection";
import { NotificationsSection } from "./NotificationsSection";
import { ConcurrencySection } from "./ConcurrencySection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { AgentProfilesSection } from "./AgentProfilesSection";
import { IssueTrackingSection } from "./IssueTrackingSection";
import { SettingsSidebar } from "./SettingsSidebar";
import { resolveDeepLinkedPage, visiblePages } from "./settings-registry";

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
  const isGitRepo = useIsGitRepo();

  // Ordered here rather than only in the sidebar, so "the first page" — what opens by
  // default — is the one the sidebar shows at the top: a project page in a project, and
  // Updates on the welcome screen, where there is no nearer scope.
  const pages = visiblePages({ inProject, isGitRepo });

  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Deep link: the selection is adjusted during render so the surface opens on the requested page
  // in the same frame; clearing the shared navigation store stays in an effect, because writing
  // another component's state during render is not safe. Same shape as `WorktreesView`.
  const pendingPage = usePendingSettingsPage();
  const { clearPendingSettingsPage } = useNavigationActions();
  const deepLinkedId = resolveDeepLinkedPage(pages, pendingPage);

  const [consumedDeepLink, setConsumedDeepLink] = useState(deepLinkedId);
  if (consumedDeepLink !== deepLinkedId) {
    setConsumedDeepLink(deepLinkedId);
    if (deepLinkedId) setActiveId(deepLinkedId);
  }

  useEffect(() => {
    if (pendingPage) clearPendingSettingsPage();
  }, [pendingPage, clearPendingSettingsPage]);

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
              ) : active?.scope === "connection" && connection ? (
                <ConnectionScopePane pageId={active.id} connection={connection} />
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
      {pageId === "diagnostics" && <DiagnosticsSection />}
    </div>
  );
}

/// Separate from `ProjectScopePane` rather than folded into it: these pages need only the
/// connection, and that pane blocks on the project's settings — a page with no project to load
/// would sit on "Loading settings..." for a query it does not use.
function ConnectionScopePane({
  pageId,
  connection,
}: {
  pageId: string;
  connection: ConnectionKey;
}) {
  return (
    <div className="space-y-6">
      {pageId === "concurrency" && <ConcurrencySection connection={connection} />}
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
        remote_name: settings.remote_name,
        base_branch: settings.base_branch,
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
      {/* Both agent cards on one page: the list the default is picked from and the pipeline that
          consumes it were on separate pages, which made choosing either one a navigation. */}
      {pageId === "agents" && (
        <>
          <AgentDefaultsSection
            defaultAgent={settings?.default_agent ?? null}
            onChange={updateSettings}
            agents={discovery?.agents ?? []}
            agentsLoading={agentsLoading}
            connection={connection}
          />
          <AgentProfilesSection
            projectId={projectId}
            agents={discovery?.agents ?? []}
            connection={connection}
          />
        </>
      )}
      {pageId === "git" && (
        <>
          <GitSection
            defaultWorkspaceMode={settings?.default_workspace_mode ?? "NewWorktree"}
            baseBranch={settings?.base_branch ?? null}
            projectId={projectId}
            onChange={updateSettings}
          />
          <CodeHostingSection
            projectId={projectId}
            remoteName={settings?.remote_name ?? null}
            onChange={updateSettings}
          />
        </>
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
