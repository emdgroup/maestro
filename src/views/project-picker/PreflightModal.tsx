import { XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/ui/button";
import { useConnectionContext } from "@/contexts/ConnectionContext";
import { useProjectPickerNavigation } from "@/utils/hooks/useProjectPickerNavigation";

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

export function PreflightModal() {
  const { preflightResult, preflightError, ignoreWarnings, resetPreflight } =
    useConnectionContext();
  const { navigateToConnections } = useProjectPickerNavigation();

  const handleGoBack = () => {
    resetPreflight();
    navigateToConnections();
  };

  const serverFailed = preflightError !== null || !preflightResult?.maestro_server.ok;
  const failedTools = preflightResult?.tool_checks.filter((t) => !t.available) ?? [];
  const hasMandatoryFail = serverFailed || failedTools.some((t) => t.mandatory);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[2px] rounded-lg z-10">
      <div className="bg-card border border-border rounded-xl p-5 w-[85%] max-w-xs shadow-xl">
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
          {failedTools.map((tool) => (
            <IssueRow
              key={tool.tool}
              label={tool.tool}
              detail={
                tool.required_by.length > 0
                  ? `Required by: ${tool.required_by.join(", ")}`
                  : "Not found"
              }
              mandatory={tool.mandatory}
            />
          ))}
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
