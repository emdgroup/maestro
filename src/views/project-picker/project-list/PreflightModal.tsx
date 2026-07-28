import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, XCircle, AlertTriangle } from "lucide-react";
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
    <div className="space-y-4">
      <IssueRow
        label={`${tool.tool} not found`}
        detail={
          tool.required_by.length > 0 ? `Required by: ${tool.required_by.join(", ")}` : undefined
        }
        mandatory={tool.mandatory}
      />
      <div className="pl-7 space-y-2">
        <p className="text-xs text-muted-foreground">
          Install this binary and run preflight again, or enter its absolute path if it is already
          installed but could not be detected.
        </p>
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
  const [currentStep, setCurrentStep] = useState(0);
  const [skippedTools, setSkippedTools] = useState<string[]>([]);
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
  const boundedStep = Math.min(currentStep, Math.max(failedTools.length - 1, 0));
  const currentTool = failedTools[boundedStep];
  const isLastStep = boundedStep === failedTools.length - 1;
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
        <div className="mb-4">
          <h3 className="text-sm font-semibold">Environment Issues</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Resolve or review each missing binary before continuing.
          </p>
        </div>

        <div className="mb-5">
          {(preflightError || serverFailed) && (
            <IssueRow
              label="maestro-server"
              detail={
                preflightError ?? preflightResult?.maestro_server.message ?? "Failed to start"
              }
              mandatory
            />
          )}
          {!serverFailed && failedTools.length > 0 && (
            <ol className="mb-5 flex items-center" aria-label="Missing binaries">
              {failedTools.map((tool, index) => {
                const skipped = skippedTools.includes(tool.tool);
                const active = index === boundedStep;
                return (
                  <li key={tool.tool} className="flex min-w-0 flex-1 items-center last:flex-none">
                    <button
                      type="button"
                      className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors ${
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : skipped
                            ? "border-amber-400/60 bg-amber-400/10 text-amber-500"
                            : "border-border bg-muted text-muted-foreground"
                      }`}
                      aria-current={active ? "step" : undefined}
                      aria-label={`${tool.tool}${skipped ? ", skipped" : ""}`}
                      onClick={() => setCurrentStep(index)}
                    >
                      {skipped ? <Check className="size-3.5" /> : index + 1}
                    </button>
                    {index < failedTools.length - 1 && (
                      <span className="mx-2 h-px min-w-4 flex-1 bg-border" />
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {!serverFailed &&
            currentTool &&
            (activeConnection ? (
              <MissingToolPath
                key={currentTool.tool}
                tool={currentTool}
                connection={connectionKey}
                onSaved={() => startPreflight(activeConnection)}
              />
            ) : (
              <IssueRow label={`${currentTool.tool} not found`} mandatory={currentTool.mandatory} />
            ))}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
          <Button variant="outline" size="sm" onClick={handleGoBack}>
            Go Back
          </Button>
          {!serverFailed && failedTools.length > 0 && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={boundedStep === 0}
                onClick={() => setCurrentStep(boundedStep - 1)}
              >
                <ChevronLeft className="size-3.5" />
                Previous
              </Button>
              {!isLastStep ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={currentTool.mandatory}
                  onClick={() => {
                    setSkippedTools((tools) =>
                      tools.includes(currentTool.tool) ? tools : [...tools, currentTool.tool],
                    );
                    setCurrentStep(boundedStep + 1);
                  }}
                >
                  Skip
                  <ChevronRight className="size-3.5" />
                </Button>
              ) : (
                !hasMandatoryFail && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-amber-400/50 text-amber-500 hover:border-amber-400 hover:bg-amber-400/10"
                    onClick={ignoreWarnings}
                  >
                    Continue anyway
                  </Button>
                )
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
