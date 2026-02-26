import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { showErrorToast, showSuccessToast } from "./ErrorToast";

interface SyncButtonProps {
  projectId: number;
  onSyncComplete: () => void;
}

export function SyncButton({ projectId, onSyncComplete }: SyncButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [importProvider, setImportProvider] = useState<string | null>(null);

  // On mount, load import provider from settings
  useEffect(() => {
    async function loadProvider() {
      try {
        const settings = await invoke<any>("get_settings", {});
        if (settings?.import_provider) {
          setImportProvider(settings.import_provider);
        }
      } catch (error) {
        console.error("Failed to load import settings:", error);
      }
    }

    loadProvider();
  }, []);

  async function handleSync() {
    if (!importProvider) {
      showErrorToast("No import provider configured");
      return;
    }

    setIsLoading(true);
    try {
      let result;

      if (importProvider === "github") {
        // In real app, retrieve stored GitHub config from settings
        result = await invoke<any>("sync_github_issues", {
          owner: "example",
          repo: "example-repo",
          token: "token",
          project_id: projectId,
        });
      } else if (importProvider === "jira") {
        // In real app, retrieve stored Jira config from settings
        result = await invoke<any>("sync_jira_issues", {
          host: "example.atlassian.net",
          email: "user@example.com",
          token: "token",
          jql: "status = Open",
          project_id: projectId,
        });
      }

      if (result?.error_message) {
        showErrorToast(`Sync failed: ${result.error_message}`);
      } else {
        const count = result?.imported_count || 0;
        showSuccessToast(`Synced ${count} issues from ${importProvider}`);
        onSyncComplete();
      }
    } catch (error: any) {
      showErrorToast(error?.message || "Sync failed");
    } finally {
      setIsLoading(false);
    }
  }

  // If no provider configured, show disabled button
  if (!importProvider) {
    return (
      <button className="btn-sync" disabled title="Configure import settings first">
        Configure Import
      </button>
    );
  }

  return (
    <button
      className="btn-sync"
      onClick={handleSync}
      disabled={isLoading}
      title={`Sync from ${importProvider}`}
    >
      {isLoading ? (
        <>
          <span className="spinner"></span>
          Syncing...
        </>
      ) : (
        `Sync from ${importProvider}`
      )}
    </button>
  );
}
