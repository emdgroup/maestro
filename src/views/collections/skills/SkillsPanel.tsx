import { useEffect, useRef, useState } from "react";
import {
  Download,
  Ellipsis,
  Info,
  Pencil,
  RefreshCw,
  Search,
  BookOpen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
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
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import {
  useDeleteSkillMutation,
  useInstallCatalogSkillMutation,
  useSetSkillAgentsMutation,
  useSkillDescriptionQuery,
  useSkillsCatalogQuery,
  useSkillsQuery,
  type SkillAgents,
} from "@/services/skill.service";
import { AgentStack, AgentsMenu, agentFor } from "../AgentsMenu";
import { CARD, CardSection, Description, EveryAgent, ListedCard } from "../CardSection";
import { SkillEditorDialog } from "./SkillEditorDialog";
import { filterSkills } from "./skills";
import type {
  ConnectionKey,
  DiscoveredAgent,
  ListedSkill,
  SkillCatalogEntry,
  SkillInfo,
} from "@/types/bindings";

const SHARED_DIRECTORY_HINT =
  "Several agents (Codex, Cursor, Gemini, Copilot, OpenCode, Cline and others) read the same ~/.agents/skills, so switching a skill off for one can switch it off for the others.";

function InstalledCard({
  skill,
  description,
  agents,
  supported,
  connection,
  onEdit,
  onRemove,
}: {
  skill: SkillInfo;
  description: string;
  agents: DiscoveredAgent[];
  supported: string[];
  connection: ConnectionKey;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const setAgents = useSetSkillAgentsMutation(connection);
  // An agent switched off keeps its entry, so it is unchecked here rather than forgotten.
  const enabled = Object.keys(skill.agents).filter((id) => skill.agents[id]);
  const change = (next: SkillAgents) => setAgents.mutate({ name: skill.name, agents: next });

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <BookOpen className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{skill.name}</span>
        <span className="truncate rounded-md border border-border px-1.5 text-[10px] text-muted-foreground">
          {skill.source ?? "Custom"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`More actions for ${skill.name}`}
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
            {/* A catalog skill can carry files besides SKILL.md that this editor cannot show. */}
            {skill.source === null && (
              <>
                <DropdownMenuItem className="text-xs" onClick={onEdit}>
                  <Pencil className="size-3.5" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem variant="destructive" className="text-xs" onClick={onRemove}>
              <Trash2 className="size-3.5" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Description text={description} />
      <div className="mt-auto flex items-center gap-1.5">
        <AgentStack agents={enabled.map((id) => agentFor(agents, id))} empty="Turned off" />
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={SHARED_DIRECTORY_HINT}
                className="text-muted-foreground/60 hover:text-muted-foreground"
              />
            }
          >
            <Info className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{SHARED_DIRECTORY_HINT}</TooltipContent>
        </Tooltip>
        <AgentsMenu
          agents={agents}
          supported={supported}
          selected={enabled}
          label={setAgents.isPending ? "Installing…" : "Agents"}
          className="ml-auto"
          disabled={setAgents.isPending}
          onSelectAll={() =>
            change({
              ...skill.agents,
              ...Object.fromEntries(
                agents
                  .filter((agent) => supported.includes(agent.id))
                  .map((agent) => [agent.id, true]),
              ),
            })
          }
          onToggle={(id, on) => change({ ...skill.agents, [id]: on })}
        />
      </div>
    </div>
  );
}

/** Whether the element has come on screen yet. Stays true once it has. */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (seen || !element) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) setSeen(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

function CatalogCard({
  entry,
  agents,
  supported,
  connection,
}: {
  entry: SkillCatalogEntry;
  agents: DiscoveredAgent[];
  supported: string[];
  connection: ConnectionKey;
}) {
  const install = useInstallCatalogSkillMutation(connection);
  const [chosen, setChosen] = useState<string[]>([]);
  const [ref, seen] = useSeen<HTMLDivElement>();
  const description = useSkillDescriptionQuery(entry.source, entry.skill_id, seen);
  const installFor = (ids: string[]) =>
    install.mutate(
      {
        source: entry.source,
        skillId: entry.skill_id,
        agents: Object.fromEntries(ids.map((id) => [id, true])),
      },
      { onSuccess: () => toast.success(`Installed ${entry.name}`) },
    );

  return (
    <div ref={ref} className={CARD}>
      <div className="flex items-center gap-2">
        <BookOpen className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{entry.name}</span>
        {entry.installs !== null && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Download className="size-3" />
            {entry.installs.toLocaleString()}
          </span>
        )}
      </div>
      {description.data || description.isError ? (
        <Description text={description.data ?? "No description available."} />
      ) : (
        <span className="inline-block h-3 w-3/4 animate-pulse rounded bg-muted" />
      )}
      <div className="mt-auto flex items-center gap-2">
        <span className="truncate font-mono text-[11px] text-muted-foreground">{entry.source}</span>
        <AgentsMenu
          agents={agents}
          supported={supported}
          selected={chosen}
          label={install.isPending ? "Installing…" : "Install"}
          className="ml-auto"
          disabled={install.isPending}
          onToggle={(id, on) =>
            setChosen(on ? [...chosen, id] : chosen.filter((chosenId) => chosenId !== id))
          }
          actions={[
            // One action whose reach follows the checkboxes: every agent until some are checked.
            chosen.length
              ? {
                  label: `Install for ${chosen.length} selected agent${chosen.length === 1 ? "" : "s"}`,
                  onSelect: () => installFor(chosen),
                }
              : {
                  label: "Install for all agents",
                  onSelect: () =>
                    installFor(
                      agents
                        .filter((agent) => supported.includes(agent.id))
                        .map((agent) => agent.id),
                    ),
                },
          ]}
        />
      </div>
    </div>
  );
}

/**
 * Skills in this connection's library, each switched on or off per agent, with Maestro's own and
 * the project's listed beside them, above a catalog of well-known skills that the search box turns
 * into a skills.sh search.
 */
export function SkillsPanel({
  connection,
  projectPath,
  editorOpen,
  onEditorOpenChange,
  editing,
  onEdit,
}: {
  connection: ConnectionKey;
  projectPath: string;
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
  editing: SkillInfo | null;
  onEdit: (skill: SkillInfo) => void;
}) {
  const { data: library, error } = useSkillsQuery(connection, projectPath);
  const { data: discovery } = useAgentDiscoveryQuery(connection);
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query.trim(), 350);
  const catalog = useSkillsCatalogQuery(search.length >= 2 ? search : "");
  const remove = useDeleteSkillMutation(connection);
  const [removing, setRemoving] = useState<SkillInfo | null>(null);

  const agents = discovery?.agents ?? [];
  const supported = library?.supported_agents ?? [];
  const skills = library?.skills ?? [];
  const installed = filterSkills(skills, query);
  const matches = (skill: ListedSkill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase());
  const builtin = (library?.builtin ?? []).filter(matches);
  const inProject = (library?.project ?? []).filter(matches);
  const installedNames = new Set(
    [...skills, ...(library?.builtin ?? []), ...(library?.project ?? [])].map(
      (skill) => skill.name,
    ),
  );
  const entries = (catalog.data?.pages.flatMap((page) => page.entries) ?? []).filter(
    (entry) => !installedNames.has(entry.skill_id),
  );
  const listed = (skill: ListedSkill) => (
    <ListedCard
      key={`${skill.location}/${skill.name}`}
      icon={<BookOpen className="size-4 shrink-0 text-muted-foreground" />}
      title={skill.name}
      badge={skill.location}
      description={skill.description}
      footer={
        skill.agents.length === 0 ? (
          <EveryAgent />
        ) : (
          <AgentStack
            agents={skill.agents
              .filter((id) => agents.some((agent) => agent.id === id))
              .map((id) => agentFor(agents, id))}
            empty="No agent on this connection reads it"
          />
        )
      }
    />
  );

  return (
    <div className="mr-[7px] flex h-full min-w-0 flex-1 flex-col gap-5 overflow-y-auto rounded-t-xl border-x border-t border-border bg-background p-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search installed skills and skills.sh…"
          aria-label="Search skills"
          className="h-8 pl-8 text-xs"
        />
      </div>

      {error ? (
        <p className="text-xs text-destructive">{String(error)}</p>
      ) : (
        <CardSection title="Installed" count={installed.length + builtin.length}>
          {builtin.map(listed)}
          {installed.map((skill) => (
            <InstalledCard
              key={skill.name}
              skill={skill}
              description={skill.description}
              agents={agents}
              supported={supported}
              connection={connection}
              onEdit={() => onEdit(skill)}
              onRemove={() => setRemoving(skill)}
            />
          ))}
        </CardSection>
      )}

      {inProject.length > 0 && (
        <CardSection title="In this project" count={inProject.length}>
          {inProject.map(listed)}
        </CardSection>
      )}

      <CardSection
        title={search.length >= 2 ? `skills.sh results for “${search}”` : "Most installed"}
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
          <p className="col-span-full text-xs text-muted-foreground">No skill matches.</p>
        ) : (
          entries.map((entry) => (
            <CatalogCard
              key={entry.id}
              entry={entry}
              agents={agents}
              supported={supported}
              connection={connection}
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

      <SkillEditorDialog
        open={editorOpen}
        onOpenChange={onEditorOpenChange}
        connection={connection}
        agents={agents}
        supported={supported}
        editing={editing}
      />

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It is uninstalled from every agent on this connection and deleted from the library.
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
