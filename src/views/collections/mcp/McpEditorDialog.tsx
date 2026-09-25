import { useState } from "react";
import { CircleCheck, CircleX, Loader2, Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Checkbox } from "@/ui/checkbox";
import { NativeSelect, NativeSelectOption } from "@/ui/native-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useSaveMcpServerMutation, useTestMcpServerMutation } from "@/services/mcp.service";
import { AgentStack, AgentsMenu, agentFor } from "../AgentsMenu";
import { needsValue } from "./mcp";
import type {
  ConnectionKey,
  DiscoveredAgent,
  McpKeyValue,
  McpServerConfig,
  McpTestResult,
} from "@/types/bindings";

const EMPTY: McpServerConfig = {
  name: "",
  transport: "stdio",
  command: "",
  args: [],
  env: [],
  url: "",
  headers: [],
  agents: [],
  catalog_id: null,
};

/**
 * Adds an MCP server, or edits `editing`. `seed` prefills a new one, from a catalog entry.
 *
 * Secret rows show blank when editing: the value is in the keychain and is never read back into
 * the webview. Leaving one blank keeps it.
 */
export function McpEditorDialog({
  open,
  onOpenChange,
  connection,
  agents,
  editing,
  seed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: ConnectionKey;
  agents: DiscoveredAgent[];
  editing: McpServerConfig | null;
  seed: McpServerConfig | null;
}) {
  const save = useSaveMcpServerMutation(connection);
  const test = useTestMcpServerMutation(connection);
  const [draft, setDraft] = useState<McpServerConfig>(EMPTY);
  const [argsText, setArgsText] = useState("");
  const [result, setResult] = useState<McpTestResult | null>(null);

  // Reset whenever the dialog opens, during render rather than from an effect, which would paint
  // one frame of whatever was there before.
  const [shownFor, setShownFor] = useState<string | null>(null);
  const current = open ? `${editing?.name ?? "new"}:${seed?.catalog_id ?? ""}` : null;
  if (shownFor !== current) {
    setShownFor(current);
    if (open) {
      const start = editing ?? seed ?? EMPTY;
      setDraft(start);
      setArgsText(start.args.join("\n"));
      setResult(null);
    }
  }

  const stdio = draft.transport === "stdio";
  const server: McpServerConfig = {
    ...draft,
    name: draft.name.trim(),
    command: stdio ? draft.command?.trim() || null : null,
    args: stdio ? argsText.split("\n").filter((line) => line.trim() !== "") : [],
    env: stdio ? draft.env : [],
    url: stdio ? null : draft.url?.trim() || null,
    headers: stdio ? [] : draft.headers,
  };
  const valid =
    server.name !== "" && server.name !== "maestro" && (stdio ? !!server.command : !!server.url);
  const previousName = editing?.name ?? null;

  const setRows = (field: "env" | "headers", rows: McpKeyValue[]) =>
    setDraft({ ...draft, [field]: rows });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
          <DialogTitle className="text-[11px] font-medium text-muted-foreground">
            {editing ? "Edit MCP server" : "New MCP server"}
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            className="ml-auto text-muted-foreground"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-[1fr_9rem] gap-3">
            <Field label="Name">
              <Input
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="context7"
                className="h-8 text-xs"
              />
            </Field>
            <Field label="Type">
              <NativeSelect
                size="sm"
                value={draft.transport}
                onChange={(event) => setDraft({ ...draft, transport: event.target.value })}
                className="w-full text-xs"
                aria-label="Type"
              >
                <NativeSelectOption value="stdio">stdio</NativeSelectOption>
                <NativeSelectOption value="http">http</NativeSelectOption>
                <NativeSelectOption value="sse">sse</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>

          {stdio ? (
            <>
              <Field label="Command">
                <Input
                  value={draft.command ?? ""}
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                  placeholder="npx"
                  className="h-8 font-mono text-xs"
                />
              </Field>
              <Field label="Arguments, one per line">
                <Textarea
                  value={argsText}
                  onChange={(event) => setArgsText(event.target.value)}
                  placeholder={"-y\n@upstash/context7-mcp"}
                  rows={3}
                  className={cn(
                    "font-mono text-xs",
                    needsValue(argsText) && "border-amber-500/70 focus-visible:border-amber-500",
                  )}
                />
              </Field>
              <Rows
                label="Environment variables"
                addLabel="Add variable"
                rows={draft.env}
                onChange={(rows) => setRows("env", rows)}
                stored={editing !== null}
              />
            </>
          ) : (
            <>
              <Field label="URL">
                <Input
                  value={draft.url ?? ""}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  placeholder="https://example.com/mcp"
                  className="h-8 font-mono text-xs"
                />
              </Field>
              <Rows
                label="Headers"
                addLabel="Add header"
                rows={draft.headers}
                onChange={(rows) => setRows("headers", rows)}
                stored={editing !== null}
                extra={
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="sm" className="h-6 text-[11px]" />}
                    >
                      Authentication
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-auto">
                      <DropdownMenuItem
                        className="text-xs"
                        onClick={() =>
                          setRows("headers", [
                            ...draft.headers.filter((row) => row.key !== "Authorization"),
                            { key: "Authorization", value: "", secret: true },
                          ])
                        }
                      >
                        Bearer token
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-xs"
                        onClick={() =>
                          setRows("headers", [
                            ...draft.headers,
                            { key: "", value: "", secret: true },
                          ])
                        }
                      >
                        Custom header
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
            </>
          )}

          <Field label="Agents">
            <div className="flex flex-wrap items-center gap-1.5">
              <AgentStack
                agents={draft.agents.map((id) => agentFor(agents, id))}
                empty="None yet"
              />
              <AgentsMenu
                agents={agents}
                selected={draft.agents}
                label={draft.agents.length ? "Change" : "Choose agents"}
                onSelectAll={() => setDraft({ ...draft, agents: agents.map((agent) => agent.id) })}
                onToggle={(id, on) =>
                  setDraft({
                    ...draft,
                    agents: on ? [...draft.agents, id] : draft.agents.filter((a) => a !== id),
                  })
                }
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Sessions Maestro starts for these agents get this server, on every project of this
              connection.
            </p>
          </Field>
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!valid || test.isPending}
            onClick={() =>
              test.mutate({ server, previousName }, { onSuccess: (outcome) => setResult(outcome) })
            }
          >
            {test.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            Test connection
          </Button>
          <TestOutcome result={result} />
          <Button variant="ghost" className="ml-auto" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={!valid || save.isPending}
            onClick={() =>
              save.mutate({ server, previousName }, { onSuccess: () => onOpenChange(false) })
            }
          >
            {editing ? "Save" : "Add server"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TestOutcome({ result }: { result: McpTestResult | null }) {
  if (!result) return null;
  if (!result.ok)
    return (
      <span className="flex min-w-0 items-center gap-1 text-[11px] text-destructive">
        <CircleX className="size-3.5 shrink-0" />
        <span className="truncate" title={result.error ?? undefined}>
          {result.error ?? "Failed"}
        </span>
      </span>
    );
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400"
      title={result.tools.join(", ")}
    >
      <CircleCheck className="size-3.5 shrink-0" />
      <span className="truncate">
        {result.tools.length
          ? `Connected: ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}`
          : "Connected"}
      </span>
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/** Key and value rows. A row marked secret is masked here and kept in the keychain. */
function Rows({
  label,
  addLabel,
  rows,
  onChange,
  stored,
  extra,
}: {
  label: string;
  addLabel: string;
  rows: McpKeyValue[];
  onChange: (rows: McpKeyValue[]) => void;
  /** Whether a blank secret may already be stored, which makes blank mean "keep". */
  stored: boolean;
  extra?: React.ReactNode;
}) {
  const update = (index: number, patch: Partial<McpKeyValue>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
        <div className="ml-auto flex items-center">
          {extra}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => onChange([...rows, { key: "", value: "", secret: false }])}
          >
            <Plus className="mr-0.5 size-3" />
            {addLabel}
          </Button>
        </div>
      </div>
      {rows.map((row, index) => {
        const blank = row.value === "" && !(row.secret && stored);
        return (
          // oxlint-disable-next-line react/no-array-index-key -- rows have no identity of their own
          <div key={index} className="flex items-center gap-1.5">
            <Input
              aria-label="Name"
              value={row.key}
              onChange={(event) => update(index, { key: event.target.value })}
              placeholder="NAME"
              className="h-7 w-44 font-mono text-xs"
            />
            <Input
              aria-label={`Value of ${row.key || "this row"}`}
              type={row.secret ? "password" : "text"}
              value={row.value}
              onChange={(event) => update(index, { value: event.target.value })}
              placeholder={
                row.secret && stored
                  ? "Stored, leave blank to keep"
                  : row.key === "Authorization"
                    ? "Bearer <token>"
                    : "value"
              }
              className={cn(
                "h-7 flex-1 font-mono text-xs",
                (blank || needsValue(row.value)) && "border-amber-500/70",
              )}
            />
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Checkbox
                checked={row.secret}
                onCheckedChange={(checked) => update(index, { secret: checked === true })}
              />
              Secret
            </label>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${row.key || "row"}`}
              className="text-muted-foreground"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
