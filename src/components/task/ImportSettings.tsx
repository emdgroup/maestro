import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { showErrorToast, showSuccessToast } from "./ErrorToast";

interface ImportSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigSaved: () => void;
}

type Provider = "github" | "jira" | null;

export function ImportSettings({ isOpen, onClose, onConfigSaved }: ImportSettingsProps) {
  const [provider, setProvider] = useState<Provider>("github");
  const [testing, setTesting] = useState(false);

  // GitHub form fields
  const [githubOwner, setGithubOwner] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubToken, setGithubToken] = useState("");

  // Jira form fields
  const [jiraHost, setJiraHost] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraToken, setJiraToken] = useState("");
  const [jiraJql, setJiraJql] = useState("");

  if (!isOpen) {
    return null;
  }

  async function handleTestConnection() {
    if (!provider) {
      showErrorToast("Please select a provider");
      return;
    }

    setTesting(true);
    try {
      if (provider === "github") {
        if (!githubOwner || !githubRepo || !githubToken) {
          showErrorToast("Please fill in all GitHub fields");
          setTesting(false);
          return;
        }

        const result = await invoke<any>("sync_github_issues", {
          owner: githubOwner,
          repo: githubRepo,
          token: githubToken,
          project_id: 1,
        });

        if (result.error_message) {
          showErrorToast(`GitHub error: ${result.error_message}`);
        } else {
          showSuccessToast("Successfully connected to GitHub");
        }
      } else if (provider === "jira") {
        if (!jiraHost || !jiraEmail || !jiraToken) {
          showErrorToast("Please fill in all Jira fields");
          setTesting(false);
          return;
        }

        const result = await invoke<any>("sync_jira_issues", {
          host: jiraHost,
          email: jiraEmail,
          token: jiraToken,
          jql: jiraJql || "status = Open",
          project_id: 1,
        });

        if (result.error_message) {
          showErrorToast(`Jira error: ${result.error_message}`);
        } else {
          showSuccessToast("Successfully connected to Jira");
        }
      }
    } catch (error: any) {
      showErrorToast(error?.message || "Connection test failed");
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!provider) {
      showErrorToast("Please select a provider");
      return;
    }

    try {
      if (provider === "github") {
        if (!githubOwner || !githubRepo || !githubToken) {
          showErrorToast("Please fill in all GitHub fields");
          return;
        }

        await invoke("save_import_config", {
          provider: "github",
          config: {
            owner: githubOwner,
            repo: githubRepo,
            token: githubToken,
          },
        });
      } else if (provider === "jira") {
        if (!jiraHost || !jiraEmail || !jiraToken) {
          showErrorToast("Please fill in all Jira fields");
          return;
        }

        await invoke("save_import_config", {
          provider: "jira",
          config: {
            host: jiraHost,
            email: jiraEmail,
            token: jiraToken,
            jql: jiraJql || "status = Open",
          },
        });
      }

      showSuccessToast("Import configuration saved");
      onConfigSaved();
      onClose();
    } catch (error: any) {
      showErrorToast(error?.message || "Failed to save configuration");
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
                  disabled={testing}
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
                  disabled={testing}
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
                  disabled={testing}
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
                  disabled={testing}
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
                  disabled={testing}
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
                  disabled={testing}
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
                  disabled={testing}
                />
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-test" onClick={handleTestConnection} disabled={testing}>
            {testing ? "Testing..." : "Test Connection"}
          </button>
          <button className="btn-save" onClick={handleSave} disabled={testing}>
            Save
          </button>
          <button className="btn-cancel" onClick={onClose} disabled={testing}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
