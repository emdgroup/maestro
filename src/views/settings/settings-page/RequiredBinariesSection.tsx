import { useEffect, useState } from "react";
import { CheckCircle2, Cpu, RotateCcw, TriangleAlert } from "lucide-react";
import type { ConnectionKey, ToolCheckEntry } from "@/types/bindings";
import {
  useRequiredToolsQuery,
  useSetToolPathMutation,
  useTestToolPathMutation,
} from "@/services/execution.service";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

interface RequiredBinariesSectionProps {
  connection: ConnectionKey;
}

function targetLabel(connection: ConnectionKey) {
  if (connection.type === "local") return "Local machine";
  if (connection.type === "ssh") return `SSH connection ${connection.id}`;
  if (connection.type === "wsl") return `WSL connection ${connection.id}`;
  return `Docker connection ${connection.id}`;
}

function ToolRow({ tool, connection }: { tool: ToolCheckEntry; connection: ConnectionKey }) {
  const [path, setPath] = useState(tool.configured_path ?? tool.resolved_path ?? "");
  const mutation = useSetToolPathMutation();
  const testMutation = useTestToolPathMutation();

  useEffect(() => {
    setPath(tool.configured_path ?? tool.resolved_path ?? "");
  }, [tool.configured_path, tool.resolved_path]);

  const isOverride = tool.configured_path != null;
  const hasChanged = path !== (tool.configured_path ?? tool.resolved_path ?? "");

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold">{tool.tool}</span>
            <span
              className={`inline-flex items-center gap-1 text-xs ${tool.available ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
            >
              {tool.available ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <TriangleAlert className="size-3.5" />
              )}
              {tool.available ? (isOverride ? "Overridden" : "Detected") : "Unavailable"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Required by {tool.required_by.join(", ") || "an installed agent"}
            {tool.version ? ` · ${tool.version}` : ""}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`tool-path-${tool.tool}`}>Executable path</Label>
        <Input
          id={`tool-path-${tool.tool}`}
          className="font-mono text-sm"
          value={path}
          placeholder={`Enter an absolute path to ${tool.tool}`}
          onChange={(event) => setPath(event.target.value)}
        />
        <p className={`text-xs ${tool.error ? "text-destructive" : "text-muted-foreground"}`}>
          {tool.error ??
            (isOverride
              ? "Stored in ~/.maestro/tools.json on the target environment."
              : "Automatically detected on the target. Editing creates an environment-wide override.")}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={path.trim() === "" || testMutation.isPending}
          onClick={() => testMutation.mutate({ connection, tool: tool.tool, path: path.trim() })}
        >
          Test path
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={
            !hasChanged ||
            path.trim() === "" ||
            mutation.isPending ||
            testMutation.data?.available !== true ||
            testMutation.data.configured_path !== path.trim()
          }
          onClick={() => mutation.mutate({ connection, tool: tool.tool, path: path.trim() })}
        >
          Save override
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!isOverride || mutation.isPending}
          onClick={() => mutation.mutate({ connection, tool: tool.tool, path: null })}
        >
          <RotateCcw className="size-3.5" />
          Use auto-detected
        </Button>
      </div>
      {testMutation.data && (
        <p
          className={`text-xs ${testMutation.data.available ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
        >
          {testMutation.data.available
            ? `Path is valid${testMutation.data.version ? ` · ${testMutation.data.version}` : ""}`
            : testMutation.data.error}
        </p>
      )}
    </div>
  );
}

export function RequiredBinariesSection({ connection }: RequiredBinariesSectionProps) {
  const query = useRequiredToolsQuery(connection);

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
          <Cpu className="w-4 h-4 text-muted-foreground" />
          Required binaries
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Overrides apply to every Maestro project using this execution environment and never enter
          the project repository.
        </p>
      </div>

      <div className="rounded-md bg-muted px-3 py-2 text-sm">
        Execution environment: <span className="font-medium">{targetLabel(connection)}</span>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Checking binaries on the target...</p>
      ) : query.isError ? (
        <p className="text-sm text-destructive">{String(query.error)}</p>
      ) : query.data?.length ? (
        <div className="space-y-3">
          {query.data.map((tool) => (
            <ToolRow key={tool.tool} tool={tool} connection={connection} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No external agent binaries are required.</p>
      )}
    </div>
  );
}
