import { useEffect, useState, useRef, forwardRef, useImperativeHandle } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/ui/button";
import { useProjectSettings, useUpdateProjectSettings } from "@/services/project.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useListIntegrations } from "@/services/integration.service";
import { showSuccessToast } from "@/components/common/error-toast/ErrorToast";
import { UpdateCard } from "@/components/settings/UpdateCard";
import type { ConnectionKey } from "@/types/bindings";
import { ProjectDefaultsSection } from "./ProjectDefaultsSection";
import type { ProjectSettingsFormData } from "./ProjectDefaultsSection";
import { AppearanceSection } from "./AppearanceSection";
import { IssueTrackingSection } from "./IssueTrackingSection";
import type { IssueTrackingSectionHandle } from "./IssueTrackingSection";

interface SettingsPageProps {
  projectId: number;
  connection: ConnectionKey;
}

export interface SettingsPageHandle {
  save: () => Promise<void>;
  resetToDefaults: () => void;
}

export const SettingsPage = forwardRef<SettingsPageHandle, SettingsPageProps>(
  ({ projectId, connection }, ref) => {
    const { control, handleSubmit, reset } = useForm<ProjectSettingsFormData>({
      defaultValues: { default_agent: "", reopen_sessions: false, startup_tab: "" },
    });

    const projectSettingsQuery = useProjectSettings(projectId);
    const updateProjectSettingsMutation = useUpdateProjectSettings();
    const { data: discovery, isLoading: agentsLoading } = useAgentDiscoveryQuery(connection);
    const { data: integrations } = useListIntegrations();
    const [isIssueTrackingValid, setIsIssueTrackingValid] = useState(true);
    const issueTrackingSectionRef = useRef<IssueTrackingSectionHandle>(null);
    const saveHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      if (!projectSettingsQuery.data) return;
      const { default_agent, reopen_sessions, startup_tab } = projectSettingsQuery.data;
      reset({
        default_agent: default_agent ?? "",
        reopen_sessions: reopen_sessions ?? false,
        startup_tab: startup_tab ?? "",
      });
    }, [projectSettingsQuery.data, reset]);

    const onSubmit = async (data: ProjectSettingsFormData) => {
      try {
        await updateProjectSettingsMutation.mutateAsync({
          projectId,
          config: {
            default_agent: data.default_agent || null,
            reopen_sessions: data.reopen_sessions || null,
            startup_tab: data.startup_tab || null,
          },
        });
        await issueTrackingSectionRef.current?.save();
        showSuccessToast("Settings saved");
      } catch (err) {
        console.error("Failed to save project settings:", err);
      }
    };

    const startSaveHoverTimer = () => {
      if (isIssueTrackingValid) return;
      saveHoverTimerRef.current = setTimeout(
        () => issueTrackingSectionRef.current?.setAttempted(true),
        500,
      );
    };

    const cancelSaveHoverTimer = () => {
      if (saveHoverTimerRef.current) {
        clearTimeout(saveHoverTimerRef.current);
        saveHoverTimerRef.current = null;
      }
    };

    useImperativeHandle(ref, () => ({
      save: async () => {
        await handleSubmit(onSubmit)();
      },
      resetToDefaults: () => {
        reset({ default_agent: "", reopen_sessions: false, startup_tab: "" });
      },
    }));

    const agents = discovery?.agents ?? [];
    const isLoading = projectSettingsQuery.isLoading;

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
            <p className="mt-1 text-sm text-muted-foreground">
              Configure the default agent and model for new sessions in this project
            </p>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              Loading settings...
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
              <UpdateCard />
              <ProjectDefaultsSection
                control={control}
                agents={agents}
                agentsLoading={agentsLoading}
              />
              <AppearanceSection />
              <IssueTrackingSection
                ref={issueTrackingSectionRef}
                projectId={projectId}
                issueTrackingIntegrations={issueTrackingIntegrations}
                onValidityChange={setIsIssueTrackingValid}
              />
              <div className="flex justify-end">
                <div onMouseEnter={startSaveHoverTimer} onMouseLeave={cancelSaveHoverTimer}>
                  <Button
                    type="submit"
                    disabled={updateProjectSettingsMutation.isPending || !isIssueTrackingValid}
                  >
                    {updateProjectSettingsMutation.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  },
);

SettingsPage.displayName = "SettingsPage";
