import { useState } from "react";
import { XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import { useProjectPickerNavigation } from "@/utils/hooks/useProjectPickerNavigation";
import { useSetToolPathMutation } from "@/services/execution.service";
import type { ConnectionKey, ToolCheckEntry } from "@/types/bindings";

function IssueRow({
  label,
  detail,
  mandatory,
}: {
  label: string;
  detail?: string;
  mandatory: boolean;
}) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="mt-0.5 shrink-0">
        {mandatory ? (
          <XCircle className="w-4 h-4 text-destructive" />
        ) : (
          <AlertTriangle className="w-4 h-4 text-amber-400" />
        )}
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-sm font-medium leading-tight">{label}</span>
        {detail && <span className="text-xs text-muted-foreground mt-0.5">{detail}</span>}
      </div>
    </div>
  );
}

function MissingToolPath({
  tool,
  connection,
  onSaved,
}: {
  tool: ToolCheckEntry;
  connection: ConnectionKey;
  onSaved: () => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useSetToolPathMutation();

  const testAndSave = async () => {
    setError(null);
    try {
      const result = await mutation.mutateAsync({
        connection,
        tool: tool.tool,
        path: path.trim(),
      });
      if (!result.available) {
        setError(result.error ?? `${tool.tool} could not be executed`);
        return;
      }
      await onSaved();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-2 py-3">
      <IssueRow
        label={`${tool.tool} not found`}
        detail={
          tool.required_by.length > 0 ? `Required by: ${tool.required_by.join(", ")}` : undefined
        }
        mandatory={tool.mandatory}
      />
      <div className="pl-7 space-y-2">
        <Input
          className="font-mono text-xs"
          value={path}
          placeholder={`Absolute path to ${tool.tool}`}
          aria-label={`Path to ${tool.tool}`}
          onChange={(event) => setPath(event.target.value)}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={path.trim() === "" || mutation.isPending}
          onClick={() => void testAndSave()}
        >
          {mutation.isPending ? "Testing..." : "Test and use path"}
        </Button>
      </div>
    </div>
  );
}

export function PreflightModal() {
  const {
    activeConnection,
    preflightResult,
    preflightError,
    ignoreWarnings,
    resetPreflight,
    startPreflight,
  } = useConnectionContext();
  const { navigateToConnections } = useProjectPickerNavigation();

  const handleGoBack = () => {
    resetPreflight();
    navigateToConnections();
  };

  const serverFailed = preflightError !== null || !preflightResult?.maestro_server.ok;
  const failedTools = preflightResult?.tool_checks.filter((t) => !t.available) ?? [];
  const hasMandatoryFail = serverFailed || failedTools.some((t) => t.mandatory);
  const connectionKey: ConnectionKey =
    activeConnection?.type === "docker" && activeConnection.dockerConnection
      ? { type: "docker", id: activeConnection.dockerConnection.id }
      : activeConnection?.type === "wsl" && activeConnection.wslConnection
        ? { type: "wsl", id: activeConnection.wslConnection.id }
        : activeConnection?.type === "ssh" && activeConnection.sshConnection
          ? { type: "ssh", id: activeConnection.sshConnection.id }
          : { type: "local" };

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[2px] rounded-lg z-10">
      <div className="bg-card border border-border rounded-xl p-5 w-[85%] max-w-md shadow-xl">
        <h3 className="text-sm font-semibold mb-3">Environment Issues</h3>

        <div className="flex flex-col divide-y divide-border/50 mb-4">
          {(preflightError || serverFailed) && (
            <IssueRow
              label="maestro-server"
              detail={
                preflightError ?? preflightResult?.maestro_server.message ?? "Failed to start"
              }
              mandatory
            />
          )}
          {failedTools.map((tool) =>
            activeConnection ? (
              <MissingToolPath
                key={tool.tool}
                tool={tool}
                connection={connectionKey}
                onSaved={() => startPreflight(activeConnection)}
              />
            ) : (
              <IssueRow
                key={tool.tool}
                label={`${tool.tool} not found`}
                mandatory={tool.mandatory}
              />
            ),
          )}
        </div>

        <div className="flex gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={handleGoBack}>
            Go Back
          </Button>
          {!hasMandatoryFail && (
            <Button
              variant="outline"
              size="sm"
              className="border-amber-400/50 text-amber-400 hover:bg-amber-400/10 hover:border-amber-400"
              onClick={ignoreWarnings}
            >
              Ignore
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
