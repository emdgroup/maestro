import { useState } from "react";
import { Ellipsis, Pencil, PlugZap, RefreshCw, Search, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { McpIcon } from "@/components/common/icons/McpIcon";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import {
  useDeleteMcpServerMutation,
  useMcpCatalogQuery,
  useMcpServersQuery,
  useSaveMcpServerMutation,
  useTestMcpServerMutation,
} from "@/services/mcp.service";
import { AgentStack, AgentsMenu, agentFor } from "../AgentsMenu";
import { CARD, CardSection, Description, EveryAgent, ListedCard } from "../CardSection";
import { McpEditorDialog } from "./McpEditorDialog";
import { catalogMatch, filterServers } from "./mcp";
import type {
  ConnectionKey,
  DiscoveredAgent,
  McpCatalogEntry,
  McpServerConfig,
} from "@/types/bindings";

/** What the editor opens on: a server to edit, or a new one, maybe prefilled from the catalog. */
export type McpDraft = { editing: McpServerConfig | null; seed: McpServerConfig | null };

function ServerIcon({ url }: { url: string | null | undefined }) {
  return url ? (
    <img src={url} alt="" className="size-5 shrink-0 rounded" />
  ) : (
    <McpIcon className="size-5 shrink-0 text-muted-foreground" />
  );
}

function InstalledCard({
  server,
  match,
  agents,
  connection,
  onEdit,
  onRemove,
}: {
  server: McpServerConfig;
  /** The catalog entry it came from, whose name, icon and description it borrows. */
  match: McpCatalogEntry | undefined;
  agents: DiscoveredAgent[];
  connection: ConnectionKey;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const save = useSaveMcpServerMutation(connection);
  const test = useTestMcpServerMutation(connection);

  const runTest = () =>
    test.mutate(
      { server, previousName: server.name },
      {
        onSuccess: (result) =>
          result.ok
            ? toast.success(
                `${server.name} connected${result.tools.length ? `: ${result.tools.length} tools` : ""}`,
              )
            : toast.error(`${server.name}: ${result.error ?? "failed"}`),
      },
    );

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <ServerIcon url={match?.icon_url} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {match?.name ?? server.name}
        </span>
        <span className="rounded-md border border-border px-1.5 text-[10px] text-muted-foreground">
          {server.transport}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`More actions for ${server.name}`}
            render={
              <Button
                variant="ghost"
                size="icon"
                className="-my-1 size-7 shrink-0 text-muted-foreground"
              />
            }
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto whitespace-nowrap">
            <DropdownMenuItem className="text-xs" onClick={onEdit}>
              <Pencil className="size-3.5" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" disabled={test.isPending} onClick={runTest}>
              <PlugZap className="size-3.5" />
              Test connection
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" className="text-xs" onClick={onRemove}>
              <Trash2 className="size-3.5" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {match?.description && <Description text={match.description} />}
      <p className="truncate font-mono text-[11px] text-muted-foreground">{commandLine(server)}</p>
      <div className="mt-auto flex items-center gap-1.5">
        <AgentStack agents={server.agents.map((id) => agentFor(agents, id))} />
        <AgentsMenu
          agents={agents}
          selected={server.agents}
          onSelectAll={() =>
            save.mutate({
              previousName: server.name,
              server: { ...server, agents: agents.map((agent) => agent.id) },
            })
          }
          label={save.isPending ? "Saving…" : "Agents"}
          className="ml-auto"
          disabled={save.isPending}
          onToggle={(id, on) =>
            save.mutate({
              previousName: server.name,
              server: {
                ...server,
                agents: on ? [...server.agents, id] : server.agents.filter((a) => a !== id),
              },
            })
          }
        />
      </div>
    </div>
  );
}

function CatalogCard({ entry, onInstall }: { entry: McpCatalogEntry; onInstall: () => void }) {
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <ServerIcon url={entry.icon_url} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{entry.name}</span>
        {entry.stars !== null && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Star className="size-3" />
            {entry.stars.toLocaleString()}
          </span>
        )}
      </div>
      <Description text={entry.description} />
      <div className="mt-auto flex items-center gap-2">
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {entry.install.transport === "stdio" ? entry.install.command : entry.install.transport}
        </span>
        <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={onInstall}>
          Install
        </Button>
      </div>
    </div>
  );
}

function commandLine(server: McpServerConfig): string {
  return server.transport === "stdio"
    ? [server.command, ...server.args].join(" ")
    : (server.url ?? "");
}

/**
 * MCP servers the user manages on this connection's machine, with Maestro's own and the project's
 * `.mcp.json` listed beside them, above the GitHub MCP Registry's catalog. The search box filters
 * what is installed and searches the catalog.
 */
export function McpPanel({
  connection,
  projectPath,
  draft,
  onDraftChange,
}: {
  connection: ConnectionKey;
  projectPath: string;
  draft: McpDraft | null;
  onDraftChange: (draft: McpDraft | null) => void;
}) {
  const { data: listed, error } = useMcpServersQuery(connection, projectPath);
  const servers = listed?.servers;
  const { data: discovery } = useAgentDiscoveryQuery(connection);
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query.trim(), 350);
  const catalog = useMcpCatalogQuery(search);
  // The unsearched list too, so what is installed keeps its catalog name and icon while searching.
  const recommended = useMcpCatalogQuery("");
  const remove = useDeleteMcpServerMutation(connection);
  const [removing, setRemoving] = useState<McpServerConfig | null>(null);

  const agents = discovery?.agents ?? [];
  const installed = filterServers(servers ?? [], query);
  const inProject = filterServers(listed?.project ?? [], query);
  const loaded = [...(catalog.data?.pages ?? []), ...(recommended.data?.pages ?? [])].flatMap(
    (page) => page.entries,
  );
  const matchOf = (server: McpServerConfig) => catalogMatch(server, loaded);
  const matched = new Set(
    [...(servers ?? []), ...(listed?.project ?? [])].map((server) => matchOf(server)?.id),
  );
  const entries = (catalog.data?.pages.flatMap((page) => page.entries) ?? []).filter(
    (entry) => !matched.has(entry.id),
  );

  return (
    <div className="mr-[7px] flex h-full min-w-0 flex-1 flex-col gap-5 overflow-y-auto rounded-t-xl border-x border-t border-border bg-background p-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search installed servers and the catalog…"
          aria-label="Search MCP servers"
          className="h-8 pl-8 text-xs"
        />
      </div>

      {error ? (
        <p className="text-xs text-destructive">{String(error)}</p>
      ) : (
        <CardSection title="Installed" count={installed.length + 1}>
          <ListedCard
            icon={<McpIcon className="size-5 shrink-0 text-accent" />}
            title="maestro"
            badge="Maestro"
            description="Canvas surfaces, tasks, automations, templates and prompts. Added to every session Maestro starts."
            footer={<EveryAgent />}
          />
          {installed.map((server) => (
            <InstalledCard
              key={server.name}
              server={server}
              match={matchOf(server)}
              agents={agents}
              connection={connection}
              onEdit={() => onDraftChange({ editing: server, seed: null })}
              onRemove={() => setRemoving(server)}
            />
          ))}
        </CardSection>
      )}

      {inProject.length > 0 && (
        <CardSection title="In this project" count={inProject.length}>
          {inProject.map((server) => {
            const match = matchOf(server);
            return (
              <ListedCard
                key={server.name}
                icon={<ServerIcon url={match?.icon_url} />}
                title={match?.name ?? server.name}
                description={match?.description || commandLine(server)}
                footer={<EveryAgent />}
              />
            );
          })}
        </CardSection>
      )}

      <CardSection
        title={search ? `Catalog results for “${search}”` : "Catalog"}
        action={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh the catalog"
            className="text-muted-foreground"
            disabled={catalog.isFetching}
            onClick={() => void catalog.refetch()}
          >
            <RefreshCw className={cn("size-3.5", catalog.isFetching && "animate-spin")} />
          </Button>
        }
      >
        {catalog.error ? (
          <p className="col-span-full text-xs text-destructive">{String(catalog.error)}</p>
        ) : catalog.data && entries.length === 0 ? (
          <p className="col-span-full text-xs text-muted-foreground">
            Nothing in the catalog matches.
          </p>
        ) : (
          entries.map((entry) => (
            <CatalogCard
              key={entry.id}
              entry={entry}
              onInstall={() => onDraftChange({ editing: null, seed: entry.install })}
            />
          ))
        )}
      </CardSection>
      {catalog.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="self-center text-xs"
          disabled={catalog.isFetchingNextPage}
          onClick={() => void catalog.fetchNextPage()}
        >
          {catalog.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}

      <McpEditorDialog
        open={draft !== null}
        onOpenChange={(open) => !open && onDraftChange(null)}
        connection={connection}
        agents={agents}
        editing={draft?.editing ?? null}
        seed={draft?.seed ?? null}
      />

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents stop getting it in new sessions on this connection, and its stored secrets are
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) remove.mutate(removing.name);
                setRemoving(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
