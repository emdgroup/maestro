import { useState } from "react";
import {
  useSaveImportConfig,
  useSyncGithubIssues,
  useSyncJiraIssues,
} from "@/services/project.service";
import { toast } from "sonner";

interface ImportSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigSaved: () => void;
}

type Provider = "github" | "jira" | null;

export function ImportSettings({ isOpen, onClose, onConfigSaved }: ImportSettingsProps) {
  const [provider, setProvider] = useState<Provider>("github");

  // GitHub form fields
  const [githubOwner, setGithubOwner] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubToken, setGithubToken] = useState("");

  // Jira form fields
  const [jiraHost, setJiraHost] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraToken, setJiraToken] = useState("");
  const [jiraJql, setJiraJql] = useState("");

  // TanStack Query mutations
  const saveConfigMutation = useSaveImportConfig();
  const syncGithubMutation = useSyncGithubIssues();
  const syncJiraMutation = useSyncJiraIssues();

  const isTesting = syncGithubMutation.isPending || syncJiraMutation.isPending;
  const isSaving = saveConfigMutation.isPending;

  if (!isOpen) {
    return null;
  }

  async function handleTestConnection() {
    if (!provider) {
      toast.error("Please select a provider");
      return;
    }

    try {
      if (provider === "github") {
        if (!githubOwner || !githubRepo || !githubToken) {
          toast.error("Please fill in all GitHub fields");
          return;
        }

        const result = await syncGithubMutation.mutateAsync({
          projectId: 1,
          owner: githubOwner,
          repo: githubRepo,
          token: githubToken,
        });

        if (result.error_message) {
          toast.error(`GitHub error: ${result.error_message}`);
        } else {
          toast.success("Successfully connected to GitHub");
        }
      } else if (provider === "jira") {
        if (!jiraHost || !jiraEmail || !jiraToken) {
          toast.error("Please fill in all Jira fields");
          return;
        }

        const result = await syncJiraMutation.mutateAsync({
          projectId: 1,
          host: jiraHost,
          email: jiraEmail,
          token: jiraToken,
          jql: jiraJql || "status = Open",
        });

        if (result.error_message) {
          toast.error(`Jira error: ${result.error_message}`);
        } else {
          toast.success("Successfully connected to Jira");
        }
      }
    } catch (error: any) {
      toast.error(error?.message || "Connection test failed");
    }
  }

  async function handleSave() {
    if (!provider) {
      toast.error("Please select a provider");
      return;
    }

    try {
      if (provider === "github") {
        if (!githubOwner || !githubRepo || !githubToken) {
          toast.error("Please fill in all GitHub fields");
          return;
        }

        await saveConfigMutation.mutateAsync({
          projectId: 1,
          importConfig: {
            provider: "github",
            config: {
              owner: githubOwner,
              repo: githubRepo,
              token: githubToken,
            },
          },
        });
      } else if (provider === "jira") {
        if (!jiraHost || !jiraEmail || !jiraToken) {
          toast.error("Please fill in all Jira fields");
          return;
        }

        await saveConfigMutation.mutateAsync({
          projectId: 1,
          importConfig: {
            provider: "jira",
            config: {
              host: jiraHost,
              email: jiraEmail,
              token: jiraToken,
              jql: jiraJql || "status = Open",
            },
          },
        });
      }

      toast.success("Import configuration saved");
      onConfigSaved();
      onClose();
    } catch (error: any) {
      toast.error(error?.message || "Failed to save configuration");
    }
  }

  return (
    <div className="import-settings-overlay">
      <div className="import-settings-modal">
        <div className="modal-header">
          <h2>Import Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {/* Provider Selection */}
          <div className="provider-section">
            <label className="provider-label">
              <input
                type="radio"
                name="provider"
                value="github"
                checked={provider === "github"}
                onChange={(e) => setProvider(e.target.value as Provider)}
              />
              GitHub
            </label>
            <label className="provider-label">
              <input
                type="radio"
                name="provider"
                value="jira"
                checked={provider === "jira"}
                onChange={(e) => setProvider(e.target.value as Provider)}
              />
              Jira
            </label>
          </div>

          {/* GitHub Form */}
          {provider === "github" && (
            <div className="form-section">
              <div className="form-group">
                <label htmlFor="github-owner">Repository Owner</label>
                <input
                  id="github-owner"
                  type="text"
                  placeholder="e.g., octocat"
                  value={githubOwner}
                  onChange={(e) => setGithubOwner(e.target.value)}
                  disabled={isTesting || isSaving}
                />
              </div>
              <div className="form-group">
                <label htmlFor="github-repo">Repository Name</label>
                <input
                  id="github-repo"
                  type="text"
                  placeholder="e.g., Hello-World"
                  value={githubRepo}
                  onChange={(e) => setGithubRepo(e.target.value)}
                  disabled={isTesting || isSaving}
                />
              </div>
              <div className="form-group">
                <label htmlFor="github-token">Personal Access Token</label>
                <input
                  id="github-token"
                  type="password"
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  disabled={isTesting || isSaving}
                />
              </div>
            </div>
          )}

          {/* Jira Form */}
          {provider === "jira" && (
            <div className="form-section">
              <div className="form-group">
                <label htmlFor="jira-host">Jira Host</label>
                <input
                  id="jira-host"
                  type="text"
                  placeholder="e.g., mycompany.atlassian.net"
                  value={jiraHost}
                  onChange={(e) => setJiraHost(e.target.value)}
                  disabled={isTesting || isSaving}
                />
              </div>
              <div className="form-group">
                <label htmlFor="jira-email">Email Address</label>
                <input
                  id="jira-email"
                  type="email"
                  placeholder="user@example.com"
                  value={jiraEmail}
                  onChange={(e) => setJiraEmail(e.target.value)}
                  disabled={isTesting || isSaving}
                />
              </div>
              <div className="form-group">
                <label htmlFor="jira-token">API Token</label>
                <input
                  id="jira-token"
                  type="password"
                  placeholder="Your API token"
                  value={jiraToken}
                  onChange={(e) => setJiraToken(e.target.value)}
                  disabled={isTesting || isSaving}
                />
              </div>
              <div className="form-group">
                <label htmlFor="jira-jql">JQL Query (optional)</label>
                <input
                  id="jira-jql"
                  type="text"
                  placeholder="e.g., status = Open"
                  value={jiraJql}
                  onChange={(e) => setJiraJql(e.target.value)}
                  disabled={isTesting || isSaving}
                />
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="btn-test"
            onClick={handleTestConnection}
            disabled={isTesting || isSaving}
          >
            {isTesting ? "Testing..." : "Test Connection"}
          </button>
          <button className="btn-save" onClick={handleSave} disabled={isSaving || isTesting}>
            {isSaving ? "Saving..." : "Save"}
          </button>
          <button className="btn-cancel" onClick={onClose} disabled={isSaving || isTesting}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
