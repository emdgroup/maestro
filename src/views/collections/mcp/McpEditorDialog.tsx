import { useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Copy,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  discardMcpAuthorization,
  useAuthorizeMcpServerMutation,
  useMcpRequiresOauthQuery,
  useSaveMcpServerMutation,
  useTestMcpServerMutation,
} from "@/services/mcp.service";
import { ALL_AGENTS, Segmented } from "../AgentsDialog";
import { CommandInput } from "./CommandInput";
import {
  guessName,
  needsValue,
  parseEnvLines,
  parseMcpJson,
  toMcpJson,
  usedVariables,
} from "./mcp";
import type {
  ConnectionKey,
  McpKeyValue,
  McpOAuthSettings,
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
  agents: [ALL_AGENTS],
  catalog_id: null,
  oauth: null,
};

const NO_CLIENT: McpOAuthSettings = {
  client_id: null,
  client_auth: "auto",
  scopes: null,
  key_id: null,
  algorithm: null,
  client_secret: "",
  private_key: "",
};

/** `mcp_oauth::REDIRECT_PORT`: where the browser comes back to for a client the user registered. */
const REDIRECT_URL = "http://127.0.0.1:33418/callback";

const TYPES = [
  { value: "stdio", label: "STDIO" },
  { value: "sse", label: "SSE" },
  { value: "http", label: "S/HTTP" },
];

type AuthMode = "none" | "oauth" | "bearer" | "headers";
const AUTH_MODES: { value: AuthMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "oauth", label: "OAuth" },
  { value: "bearer", label: "Bearer token" },
  { value: "headers", label: "Headers" },
];

const CLIENT_AUTH = [
  { value: "auto", label: "Automatic", hint: "from the server" },
  { value: "none", label: "None", hint: "PKCE only" },
  { value: "client_secret_basic", label: "Client secret", hint: "Basic header" },
  { value: "client_secret_post", label: "Client secret", hint: "in the body" },
  { value: "client_secret_jwt", label: "Client secret JWT", hint: "HMAC" },
  { value: "private_key_jwt", label: "Private key JWT", hint: "signed key" },
];
const ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "EdDSA",
];

const AUTHORIZATION = "Authorization";

/** How a saved remote server authenticates, read back from what it stores. */
function authModeOf(server: McpServerConfig): AuthMode {
  if (server.oauth) return "oauth";
  if (server.headers.length === 1 && server.headers[0].key === AUTHORIZATION) return "bearer";
  return server.headers.length ? "headers" : "none";
}

/**
 * Adds an MCP server, or edits `editing`. `seed` prefills a new one, from a catalog entry. A new
 * server goes to every agent; the card changes that.
 *
 * Secrets show blank when editing: they are in the keychain and never read back into the webview.
 * Leaving one blank keeps it. The environment is plain text, as in `.mcp.json`.
 */
export function McpEditorDialog({
  open,
  onOpenChange,
  connection,
  editing,
  seed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: ConnectionKey;
  editing: McpServerConfig | null;
  seed: McpServerConfig | null;
}) {
  const save = useSaveMcpServerMutation(connection);
  const test = useTestMcpServerMutation(connection);
  const authorize = useAuthorizeMcpServerMutation(connection);
  // A sign-in made in this edit, held in the app's memory until Save stores it.
  const [grant, setGrant] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpServerConfig>(EMPTY);
  const [nameTyped, setNameTyped] = useState(false);
  const [typeChosen, setTypeChosen] = useState(false);
  const [auth, setAuth] = useState<AuthMode>("none");
  const [authChosen, setAuthChosen] = useState(false);
  const [token, setToken] = useState("");
  const [client, setClient] = useState<McpOAuthSettings>(NO_CLIENT);
  const [clientOpen, setClientOpen] = useState(false);
  const [json, setJson] = useState<{ text: string } | null>(null);
  const [result, setResult] = useState<McpTestResult | null>(null);

  // Reset whenever the dialog opens, during render rather than from an effect, which would paint
  // one frame of whatever was there before.
  const [shownFor, setShownFor] = useState<string | null>(null);
  const current = open ? `${editing?.name ?? "new"}:${seed?.catalog_id ?? ""}` : null;
  if (shownFor !== current) {
    setShownFor(current);
    if (open) {
      // A catalog entry names no agents, and a new server goes to all of them.
      const start = editing ?? (seed ? { ...seed, agents: [ALL_AGENTS] } : EMPTY);
      setDraft(start);
      setNameTyped(editing !== null);
      setTypeChosen(editing !== null);
      setAuth(authModeOf(start));
      setAuthChosen(editing !== null);
      setToken("");
      setClient({ ...NO_CLIENT, ...start.oauth });
      setClientOpen(!!start.oauth?.client_id);
      setJson(null);
      setResult(null);
      setGrant(null);
    }
  }

  const stdio = draft.transport === "stdio";
  const url = draft.url?.trim() ?? "";
  const requiresOauth = useMcpRequiresOauthQuery(useDebouncedValue(url, 500)).data === true;
  // A new server follows the detection until the user picks a method themselves.
  const mode: AuthMode = authChosen ? auth : requiresOauth ? "oauth" : auth;

  const server: McpServerConfig = {
    ...draft,
    name: draft.name.trim(),
    command: stdio ? draft.command?.trim() || null : null,
    args: stdio ? draft.args : [],
    env: stdio ? draft.env.filter((row) => row.key.trim()) : [],
    url: stdio ? null : url || null,
    headers: stdio
      ? []
      : mode === "none"
        ? []
        : mode === "headers"
          ? draft.headers.filter((row) => row.key.trim()).map((row) => ({ ...row, secret: true }))
          : [
              {
                key: AUTHORIZATION,
                value:
                  mode === "bearer" && token.trim()
                    ? `Bearer ${token.trim().replace(/^Bearer\s+/i, "")}`
                    : "",
                secret: true,
              },
            ],
    oauth: !stdio && mode === "oauth" ? client : null,
  };
  const previousName = editing?.name ?? null;
  // A new OAuth server has no token until someone signs in, and would reach agents without one.
  const unsigned = !stdio && mode === "oauth" && !grant && editing?.oauth == null;
  const valid =
    server.name !== "" &&
    server.name !== "maestro" &&
    (stdio ? !!server.command : !!server.url) &&
    !unsigned;

  const update = (patch: Partial<McpServerConfig>) => {
    const next = { ...draft, ...patch };
    if (!nameTyped) next.name = guessName(next);
    setDraft(next);
    setResult(null);
  };
  const setTokens = (tokens: string[]) => {
    const [command = "", ...args] = tokens;
    const missing = usedVariables(args).filter((key) => !draft.env.some((row) => row.key === key));
    update({
      command,
      args,
      env: [...draft.env, ...missing.map((key) => ({ key, value: "", secret: false }))],
    });
  };
  const applyJson = (text: string): boolean => {
    const parsed = parseMcpJson(text);
    if ("error" in parsed) {
      toast.error(parsed.error);
      return false;
    }
    const { server: pasted, skipped } = parsed;
    const next = { ...draft, ...pasted, agents: draft.agents };
    if (!pasted.name && !nameTyped) next.name = guessName(next);
    if (pasted.name) setNameTyped(true);
    setDraft(next);
    setTypeChosen(true);
    const headers = pasted.headers ?? [];
    const bearer = headers.length === 1 && headers[0].key === AUTHORIZATION;
    if (next.transport !== "stdio" && headers.length) {
      setAuth(bearer ? "bearer" : "headers");
      setAuthChosen(true);
      setToken(bearer ? headers[0].value.replace(/^Bearer\s+/i, "") : "");
    }
    setResult(null);
    if (skipped)
      toast.info(`Took “${pasted.name}”; ${skipped} more server${skipped > 1 ? "s" : ""} left out`);
    return true;
  };

  const signIn = () =>
    authorize.mutate(
      { url, settings: client, storedAs: previousName },
      {
        onSuccess: (id) => {
          if (grant) discardMcpAuthorization(grant);
          setGrant(id);
          setResult(null);
        },
        onError: (error) => {
          if (String(error).includes("Client settings")) setClientOpen(true);
        },
      },
    );
  // Closing without saving drops the sign-in, so it never reaches the keychain.
  const close = () => {
    if (grant) discardMcpAuthorization(grant);
    setGrant(null);
    onOpenChange(false);
  };
  const submit = () =>
    save.mutate(
      { server, previousName, oauth: grant },
      {
        onSuccess: () => {
          setGrant(null);
          onOpenChange(false);
        },
      },
    );
  const switchView = (view: string) => {
    if (view === "json" && !json) setJson({ text: toMcpJson(server) });
    if (view === "form" && json) {
      if (json.text.trim() && !applyJson(json.text)) return;
      setJson(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
          <DialogTitle className="text-[11px] font-medium text-muted-foreground">
            {editing ? "Edit MCP server" : "New MCP server"}
          </DialogTitle>
          <Segmented
            label="View"
            className="ml-auto"
            size="xs"
            value={json ? "json" : "form"}
            options={[
              { value: "form", label: "Form" },
              { value: "json", label: "JSON" },
            ]}
            onChange={switchView}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            className="text-muted-foreground"
            onClick={close}
          >
            <X className="size-4" />
          </Button>
        </div>

        {json ? (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-5">
            <Textarea
              aria-label="JSON config"
              value={json.text}
              spellCheck={false}
              rows={14}
              onChange={(event) => setJson({ text: event.target.value })}
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              The shape of <span className="font-mono">.mcp.json</span>: paste a whole{" "}
              <span className="font-mono">mcpServers</span> block or one server. Back to Form reads
              it.
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <div className="flex items-end gap-3">
              <Field label="Name" className="flex-1">
                <Input
                  autoFocus
                  aria-label="Name"
                  value={draft.name}
                  onChange={(event) => {
                    setNameTyped(event.target.value !== "");
                    setDraft({ ...draft, name: event.target.value });
                  }}
                  placeholder={stdio ? "filesystem" : "linear"}
                  className="h-8 text-xs"
                />
              </Field>
              <Field label="Type">
                <Segmented
                  label="Type"
                  value={draft.transport}
                  options={TYPES}
                  onChange={(transport) => {
                    setTypeChosen(true);
                    update({ transport });
                  }}
                />
              </Field>
            </div>

            {stdio ? (
              <>
                <Field label="Command">
                  <CommandInput
                    tokens={draft.command ? [draft.command, ...draft.args] : draft.args}
                    onChange={setTokens}
                    onPasteJson={applyJson}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Space ends an argument unless inside quotes. Paste a command line or a JSON
                    config; click an argument to edit it.
                  </p>
                </Field>
                <Rows
                  label="Environment variables"
                  addLabel="Add variable"
                  rows={draft.env}
                  onChange={(env) => update({ env })}
                  stored={editing !== null}
                />
              </>
            ) : (
              <>
                <Field label="URL">
                  <Input
                    aria-label="URL"
                    value={draft.url ?? ""}
                    onChange={(event) => {
                      const next = event.target.value;
                      const sse = /\/sse\/?$/.test(next.trim());
                      update({
                        url: next,
                        ...(typeChosen ? {} : { transport: sse ? "sse" : "http" }),
                      });
                    }}
                    onPaste={(event) => {
                      const pasted = event.clipboardData.getData("text").trim();
                      if (pasted.startsWith("{")) {
                        event.preventDefault();
                        applyJson(pasted);
                      }
                    }}
                    placeholder="https://example.com/mcp"
                    className={cn(
                      "h-8 font-mono text-xs",
                      needsValue(url) && "border-amber-500/70",
                    )}
                  />
                </Field>
                <Field
                  label="Authentication"
                  aside={
                    requiresOauth && (
                      <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-400">
                        this server asks for OAuth
                      </span>
                    )
                  }
                >
                  <Segmented
                    label="Authentication"
                    value={mode}
                    options={AUTH_MODES}
                    onChange={(value) => {
                      setAuth(value as AuthMode);
                      setAuthChosen(true);
                      setResult(null);
                    }}
                  />
                  {mode === "bearer" && (
                    <Input
                      aria-label="Bearer token"
                      type="password"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      placeholder={
                        editing && authModeOf(editing) === "bearer"
                          ? "Stored, leave blank to keep"
                          : "Token, kept in the keychain"
                      }
                      className="mt-1 h-8 font-mono text-xs"
                    />
                  )}
                  {mode === "headers" && (
                    <div className="mt-1">
                      <Rows
                        addLabel="Add header"
                        rows={draft.headers}
                        onChange={(headers) => update({ headers })}
                        masked
                        stored={editing !== null}
                      />
                    </div>
                  )}
                  {mode === "oauth" && (
                    <OAuthPanel
                      settings={client}
                      onChange={setClient}
                      open={clientOpen}
                      onOpenChange={setClientOpen}
                      signedIn={grant !== null}
                      saved={editing?.oauth != null}
                      pending={authorize.isPending}
                      canSignIn={!!url}
                      onSignIn={signIn}
                    />
                  )}
                </Field>
              </>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!valid || test.isPending || json !== null}
            onClick={() =>
              test.mutate(
                { server, previousName, oauth: grant },
                { onSuccess: (outcome) => setResult(outcome) },
              )
            }
          >
            {test.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            Test connection
          </Button>
          {unsigned ? (
            <span className="text-[11px] text-muted-foreground">Sign in to create it.</span>
          ) : (
            <TestOutcome result={result} />
          )}
          <Button variant="ghost" className="ml-auto" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={!valid || save.isPending || json !== null}
            onClick={submit}
          >
            {save.isPending ? "Saving…" : editing ? "Save" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A joined row of toggles where exactly one is on. */
/** Signing in, and the client it signs in as, folded away since most servers need no setting. */
function OAuthPanel({
  settings,
  onChange,
  open,
  onOpenChange,
  signedIn,
  saved,
  pending,
  canSignIn,
  onSignIn,
}: {
  settings: McpOAuthSettings;
  onChange: (settings: McpOAuthSettings) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  signedIn: boolean;
  /** Whether a sign-in is already stored, which makes a blank secret mean "keep". */
  saved: boolean;
  pending: boolean;
  canSignIn: boolean;
  onSignIn: () => void;
}) {
  const keyFile = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<McpOAuthSettings>) => onChange({ ...settings, ...patch });
  const text = (value: string) => (value.trim() === "" ? null : value);
  const method = settings.client_auth || "auto";
  const keepHint = saved ? "Stored, leave blank to keep" : "Kept in the keychain";

  return (
    <div className="mt-1 space-y-2">
      <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-[11px]">
        {signedIn ? (
          <span className="flex flex-1 items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <CircleCheck className="size-3.5" />
            Signed in. Save to keep the token.
          </span>
        ) : (
          <span className="flex-1 text-muted-foreground">
            {saved
              ? "Signed in. Sign in again if the token stopped working."
              : "Opens the browser to sign in. The token is kept in the keychain and refreshes itself."}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 text-[11px]"
          disabled={pending || !canSignIn}
          onClick={onSignIn}
        >
          {pending && <Loader2 className="mr-1 size-3 animate-spin" />}
          {pending ? "Signing in…" : signedIn || saved ? "Sign in again" : "Sign in"}
        </Button>
      </div>
      <button
        type="button"
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => onOpenChange(!open)}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Client settings
        <span className="font-mono">
          · {settings.client_id ? settings.client_id : "registered automatically"}
        </span>
      </button>
      {open && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Client ID">
              <Input
                aria-label="Client ID"
                value={settings.client_id ?? ""}
                onChange={(event) => set({ client_id: text(event.target.value) })}
                placeholder="Registered automatically"
                className="h-8 font-mono text-xs"
              />
            </Field>
            <Field label="Client authentication">
              <Select value={method} onValueChange={(value) => set({ client_auth: String(value) })}>
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue>
                    {(value: string) => {
                      const option = CLIENT_AUTH.find((item) => item.value === value);
                      return (
                        <span>
                          {option?.label}{" "}
                          <span className="text-muted-foreground">· {option?.hint}</span>
                        </span>
                      );
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CLIENT_AUTH.map((option) => (
                    <SelectItem key={option.value} value={option.value} className="text-xs">
                      {option.label}
                      <span className="ml-auto pl-3 text-[10px] text-muted-foreground">
                        {option.hint}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {settings.client_id && (
            <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              Register <span className="font-mono text-foreground">{REDIRECT_URL}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy the redirect URL"
                className="size-5"
                onClick={() => {
                  void navigator.clipboard.writeText(REDIRECT_URL);
                  toast.success("Redirect URL copied");
                }}
              >
                <Copy className="size-3" />
              </Button>
              as the redirect URL in the provider's app settings.
            </p>
          )}
          {method === "private_key_jwt" ? (
            <>
              <Field
                label="Private key"
                aside={
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground underline hover:text-foreground"
                    onClick={() => keyFile.current?.click()}
                  >
                    Load from file…
                  </button>
                }
              >
                <Textarea
                  aria-label="Private key"
                  value={settings.private_key}
                  rows={3}
                  spellCheck={false}
                  onChange={(event) => set({ private_key: event.target.value })}
                  placeholder={
                    saved ? keepHint : "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"
                  }
                  className="font-mono text-[11px]"
                />
                <input
                  ref={keyFile}
                  type="file"
                  accept=".pem,.key,.txt"
                  className="hidden"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (file) set({ private_key: await file.text() });
                    event.target.value = "";
                  }}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Key ID">
                  <Input
                    aria-label="Key ID"
                    value={settings.key_id ?? ""}
                    onChange={(event) => set({ key_id: text(event.target.value) })}
                    placeholder="kid, optional"
                    className="h-8 font-mono text-xs"
                  />
                </Field>
                <Field label="Algorithm">
                  <Select
                    value={settings.algorithm ?? "RS256"}
                    onValueChange={(value) => set({ algorithm: String(value) })}
                  >
                    <SelectTrigger size="sm" className="w-full font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ALGORITHMS.map((algorithm) => (
                        <SelectItem key={algorithm} value={algorithm} className="font-mono text-xs">
                          {algorithm}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </>
          ) : (
            method !== "none" && (
              <Field label="Client secret">
                <Input
                  aria-label="Client secret"
                  type="password"
                  value={settings.client_secret}
                  onChange={(event) => set({ client_secret: event.target.value })}
                  placeholder={method === "auto" && !saved ? "None, a public client" : keepHint}
                  className="h-8 font-mono text-xs"
                />
              </Field>
            )
          )}
          <Field label="Scopes">
            <Input
              aria-label="Scopes"
              value={settings.scopes ?? ""}
              onChange={(event) => set({ scopes: text(event.target.value) })}
              placeholder="What the server asks for"
              className="h-8 font-mono text-xs"
            />
          </Field>
        </div>
      )}
    </div>
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

function Field({
  label,
  aside,
  className,
  children,
}: {
  label: string;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * Key and value rows. `masked` rows are secrets kept in the keychain, blank when read back;
 * `stored` says one may already be there, which makes blank mean "keep". Pasting `KEY=value`
 * lines into any field adds a row for each.
 */
function Rows({
  label,
  addLabel,
  rows,
  onChange,
  masked = false,
  stored = false,
}: {
  label?: string;
  addLabel: string;
  rows: McpKeyValue[];
  onChange: (rows: McpKeyValue[]) => void;
  masked?: boolean;
  stored?: boolean;
}) {
  const update = (index: number, patch: Partial<McpKeyValue>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const add = (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 text-[11px]"
      onClick={() => onChange([...rows, { key: "", value: "", secret: masked }])}
    >
      <Plus className="mr-0.5 size-3" />
      {addLabel}
    </Button>
  );
  const paste = (index: number) => (event: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = parseEnvLines(event.clipboardData.getData("text"));
    if (pasted.length === 0) return;
    event.preventDefault();
    const row = rows[index];
    const replace = !row.key && !row.value ? 1 : 0;
    onChange([
      ...rows.slice(0, index),
      ...pasted.map((pair) => ({ ...pair, secret: masked })),
      ...rows.slice(index + replace),
    ]);
  };
  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex items-center">
          <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
          <span className="ml-auto">{add}</span>
        </div>
      )}
      {rows.map((row, index) => {
        // A secret from before the environment went plain keeps its keychain value.
        const secret = masked || row.secret;
        const keep = secret && stored;
        return (
          // oxlint-disable-next-line react/no-array-index-key -- rows have no identity of their own
          <div key={index} className="flex items-center gap-1.5">
            <Input
              aria-label="Name"
              value={row.key}
              onChange={(event) => update(index, { key: event.target.value })}
              onPaste={paste(index)}
              placeholder={masked ? "Header" : "NAME"}
              className="h-7 w-44 font-mono text-xs"
            />
            <Input
              aria-label={`Value of ${row.key || "this row"}`}
              type={secret ? "password" : "text"}
              value={row.value}
              onChange={(event) => update(index, { value: event.target.value })}
              onPaste={paste(index)}
              placeholder={
                keep ? "Stored, leave blank to keep" : masked ? "Kept in the keychain" : "value"
              }
              className={cn(
                "h-7 flex-1 font-mono text-xs",
                ((row.value === "" && !keep) || needsValue(row.value)) && "border-amber-500/70",
              )}
            />
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
      {!label && add}
    </div>
  );
}
