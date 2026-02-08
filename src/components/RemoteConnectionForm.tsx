import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { SshConfig } from "../types/bindings";

interface RemoteConnectionFormProps {
  onSubmit: (config: SshConfig) => Promise<void>;
  onBack: () => void;
  loading?: boolean;
}

export function RemoteConnectionForm({
  onSubmit,
  onBack,
  loading = false,
}: RemoteConnectionFormProps) {
  const [config, setConfig] = useState<SshConfig>({
    host: "",
    port: 22,
    username: "user",
    auth_method: "Agent",
    remote_path: "/home/user/project",
  });

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      await invoke<boolean>("test_remote_connection", { config });
      setTestResult({ ok: true, msg: "✓ Connection successful!" });
      toast.success("SSH connection test passed");
    } catch (error) {
      const errorMsg = String(error);
      setTestResult({ ok: false, msg: errorMsg });
      toast.error(`Connection failed: ${errorMsg}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!config.host || !config.username || !config.remote_path) {
      toast.error("Please fill all required fields");
      return;
    }

    if (testResult?.ok !== true) {
      toast.error("Please test connection successfully before creating project");
      return;
    }

    await onSubmit(config);
  };

  const updateAuthMethod = (method: "Agent" | "KeyFile") => {
    if (method === "Agent") {
      setConfig({ ...config, auth_method: "Agent" });
    } else {
      setConfig({
        ...config,
        auth_method: { KeyFile: { path: "$HOME/.ssh/id_rsa" } },
      });
    }
  };

  const updateKeyFilePath = (path: string) => {
    if (typeof config.auth_method === "object" && "KeyFile" in config.auth_method) {
      setConfig({
        ...config,
        auth_method: { KeyFile: { path } },
      });
    }
  };

  const isKeyFileMethod =
    typeof config.auth_method === "object" && config.auth_method !== null && "KeyFile" in config.auth_method;
  const keyFilePath = isKeyFileMethod
    ? (config.auth_method as { KeyFile: { path: string } }).KeyFile.path
    : "";

  return (
    <div className="remote-connection-form">
      <h2>Remote SSH Connection</h2>

      <form onSubmit={handleSubmit}>
        {/* Host field */}
        <div className="form-group">
          <label htmlFor="host">
            Host: <span className="required">*</span>
          </label>
          <input
            id="host"
            type="text"
            placeholder="example.com or user@example.com"
            value={config.host}
            onChange={(e) => setConfig({ ...config, host: e.target.value })}
            disabled={loading || testing}
            required
          />
        </div>

        {/* Port field */}
        <div className="form-group">
          <label htmlFor="port">
            Port:
          </label>
          <input
            id="port"
            type="number"
            value={config.port}
            onChange={(e) => setConfig({ ...config, port: parseInt(e.target.value) || 22 })}
            disabled={loading || testing}
            min={1}
            max={65535}
          />
        </div>

        {/* Username field */}
        <div className="form-group">
          <label htmlFor="username">
            Username: <span className="required">*</span>
          </label>
          <input
            id="username"
            type="text"
            placeholder="ssh username"
            value={config.username}
            onChange={(e) => setConfig({ ...config, username: e.target.value })}
            disabled={loading || testing}
            required
          />
        </div>

        {/* Auth method radio buttons */}
        <fieldset className="auth-method-group">
          <legend>Authentication Method:</legend>
          <div className="radio-group">
            <label className="radio-label">
              <input
                type="radio"
                name="auth_method"
                value="Agent"
                checked={config.auth_method === "Agent"}
                onChange={() => updateAuthMethod("Agent")}
                disabled={loading || testing}
              />
              SSH Agent
            </label>
            <label className="radio-label">
              <input
                type="radio"
                name="auth_method"
                value="KeyFile"
                checked={isKeyFileMethod}
                onChange={() => updateAuthMethod("KeyFile")}
                disabled={loading || testing}
              />
              Private Key File
            </label>
          </div>

          {isKeyFileMethod && (
            <div className="form-group key-file-path">
              <label htmlFor="keyfile">Key File Path:</label>
              <input
                id="keyfile"
                type="text"
                placeholder="/path/to/private/key"
                value={keyFilePath}
                onChange={(e) => updateKeyFilePath(e.target.value)}
                disabled={loading || testing}
              />
            </div>
          )}
        </fieldset>

        {/* Remote path field */}
        <div className="form-group">
          <label htmlFor="remote_path">
            Remote Project Path: <span className="required">*</span>
          </label>
          <input
            id="remote_path"
            type="text"
            placeholder="/home/user/project"
            value={config.remote_path}
            onChange={(e) => setConfig({ ...config, remote_path: e.target.value })}
            disabled={loading || testing}
            required
          />
        </div>

        {/* Test connection button */}
        <div className="form-group">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testing || loading || !config.host || !config.username}
            className="test-button"
          >
            {testing ? "⏳ Testing..." : "🧪 Test Connection"}
          </button>
        </div>

        {/* Test result feedback */}
        {testResult && (
          <div className={`test-result ${testResult.ok ? "success" : "error"}`}>
            {testResult.msg}
          </div>
        )}

        {/* Submit and back buttons */}
        <div className="form-group button-group">
          <button
            type="submit"
            disabled={loading || !testResult?.ok}
            className="submit-button"
          >
            {loading ? "Creating..." : "Create Remote Project"}
          </button>
          <button
            type="button"
            onClick={onBack}
            disabled={loading || testing}
            className="back-button"
          >
            Back
          </button>
        </div>
      </form>
    </div>
  );
}
