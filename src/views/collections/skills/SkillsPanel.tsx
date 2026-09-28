import { useEffect, useRef, useState } from "react";
import { Download, Ellipsis, Info, Pencil, RefreshCw, BookOpen, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
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
  useSkillSummaryQuery,
  useSkillsCatalogQuery,
  useSkillsQuery,
} from "@/services/skill.service";
import { ALL_AGENTS, AgentStack, AgentsDialog, AgentsSummary, agentFor } from "../AgentsDialog";
import {
  CARD,
  CardSection,
  CardTitle,
  CATALOG_STEP,
  Chip,
  Description,
  EveryAgent,
  ListedCard,
  SearchBox,
} from "../CardSection";
import { SkillEditorDialog } from "./SkillEditorDialog";
import { filterSkills, skillAgents, skillPage } from "./skills";
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
  const [choosing, setChoosing] = useState(false);

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <BookOpen className="size-4 shrink-0 text-accent" />
        <CardTitle title={skill.name} href={skill.source && skillPage(skill.source, skill.name)} />
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
        <AgentsSummary
          agents={agents}
          ids={enabled}
          empty="Turned off"
          disabled={setAgents.isPending}
          onClick={() => setChoosing(true)}
        />
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
        {setAgents.isPending && (
          <span className="text-[11px] text-muted-foreground">Installing…</span>
        )}
        <Chip>{skill.source ?? "Custom"}</Chip>
      </div>
      <AgentsDialog
        open={choosing}
        onOpenChange={setChoosing}
        name={skill.name}
        agents={agents}
        supported={supported}
        value={enabled}
        confirmLabel="Save"
        onConfirm={(picked) => {
          setAgents.mutate({ name: skill.name, agents: skillAgents(picked, skill.agents) });
          setChoosing(false);
        }}
      />
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

/** The whole `SKILL.md` description, fetched when the hover popup mounts this. */
function FullDescription({
  source,
  skillId,
  fallback,
}: {
  source: string;
  skillId: string;
  fallback: string;
}) {
  const description = useSkillDescriptionQuery(source, skillId);
  if (description.isPending) return <Spinner className="size-3.5" />;
  return description.data ?? fallback;
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
  const [choosing, setChoosing] = useState(false);
  const [ref, seen] = useSeen<HTMLDivElement>();
  const summary = useSkillSummaryQuery(entry.source, entry.skill_id, seen);
  const installFor = (picked: string[]) =>
    install.mutate(
      { source: entry.source, skillId: entry.skill_id, agents: skillAgents(picked) },
      {
        onSuccess: () => {
          setChoosing(false);
          toast.success(`Installed ${entry.name}`);
        },
      },
    );

  return (
    <div ref={ref} className={CARD}>
      <div className="flex items-center gap-2">
        <BookOpen className="size-4 shrink-0 text-muted-foreground" />
        <CardTitle title={entry.name} href={skillPage(entry.source, entry.skill_id)} />
        {entry.installs !== null && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Download className="size-3" />
            {entry.installs.toLocaleString()}
          </span>
        )}
      </div>
      {summary.isSuccess || summary.isError ? (
        <Description
          text={summary.data ?? "No description available."}
          full={
            summary.data ? (
              <FullDescription
                source={entry.source}
                skillId={entry.skill_id}
                fallback={summary.data}
              />
            ) : undefined
          }
        />
      ) : (
        <span className="inline-block h-3 w-3/4 animate-pulse rounded bg-muted" />
      )}
      <div className="mt-auto flex items-center gap-2">
        <span className="truncate font-mono text-[11px] text-muted-foreground">{entry.source}</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-7 text-xs"
          disabled={install.isPending}
          onClick={() => setChoosing(true)}
        >
          {install.isPending ? "Installing…" : "Install"}
        </Button>
      </div>
      <AgentsDialog
        open={choosing}
        onOpenChange={setChoosing}
        name={entry.name}
        agents={agents}
        supported={supported}
        value={[ALL_AGENTS]}
        confirmLabel={install.isPending ? "Installing…" : "Install"}
        pending={install.isPending}
        onConfirm={installFor}
      />
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
  const [shown, setShown] = useState({ search, count: CATALOG_STEP });
  const count = shown.search === search ? shown.count : CATALOG_STEP;
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
      <SearchBox
        value={query}
        onChange={setQuery}
        placeholder="Search installed skills and skills.sh…"
        label="Search skills"
      />

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
          entries
            .slice(0, count)
            .map((entry) => (
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
      {(entries.length > count || catalog.hasNextPage) && (
        <Button
          variant="outline"
          size="sm"
          className="self-center text-xs"
          disabled={catalog.isFetchingNextPage}
          onClick={() => {
            setShown({ search, count: count + CATALOG_STEP });
            // The next leaderboard page only once the loaded ones run out.
            if (count + CATALOG_STEP > entries.length) void catalog.fetchNextPage();
          }}
        >
          {catalog.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      )}

      <SkillEditorDialog
        open={editorOpen}
        onOpenChange={onEditorOpenChange}
        connection={connection}
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
