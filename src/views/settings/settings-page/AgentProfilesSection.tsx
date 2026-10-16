import { useState } from "react";
import { ArrowRight, Bot, ChevronDown, Plus, Repeat, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { Textarea } from "@/ui/textarea";
import { AgentConfigFields } from "@/components/common/agent-config/AgentConfigFields";
import { useAgentProfilesQuery, useSaveAgentProfilesMutation } from "@/services/project.service";
import { isReadOnlyRole } from "@/lib/permission-modes";
import { useSelectedProject } from "@/store/projectStore";
import type { AgentProfile, AgentRole, ConnectionKey, ProfilesDocument } from "@/types/bindings";
import { cn } from "@/lib/utils";

/**
 * The roles, in the order a task passes through them: a pipeline task's four, then a loop's three.
 *
 * `noneText` says what the stage costs the user without a profile rather than what it is called: a
 * pipeline stage with no profile is simply skipped, and "no Reviewer" being the difference between
 * a task stopping at your gate and going straight to it is not obvious from the word "Reviewer".
 *
 * `defaultPrompt` is the text a new profile of that role starts with. It is copied into the
 * profile on creation rather than applied as a fallback at resolution time, because the user has
 * to be able to read it, edit it and delete it — none of which is true of a prompt that only
 * exists as a hidden default. The cost of that choice is that editing the text here does not
 * reach profiles already written, which is the right way round: those are the team's, not ours.
 * Deliberately project-neutral, since the project-specific half is what the user adds.
 */
type RoleEntry = {
  role: AgentRole;
  title: string;
  /** The stage's name in the workflow row. */
  stage: string;
  what: string;
  /** What runs the stage without a profile: nothing, the project's default agent, or Iterate's. */
  none: "skip" | "default" | "inherit";
  noneText: string;
  defaultPrompt: string;
};

const PIPELINE_ROLES: RoleEntry[] = [
  {
    role: "Refiner",
    title: "Refinement",
    stage: "Refine",
    what: "Sharpens a task's description before anyone implements it.",
    none: "skip",
    noneText: "Skipped. Tasks in Planning have no Refine button.",
    defaultPrompt:
      "Sharpen this task's description so it can be implemented without coming back to ask what it " +
      "meant. Read enough of the codebase to ground it: name the files and functions involved, say " +
      "what done looks like, and say what is out of scope. Where the task is genuinely ambiguous, " +
      "write the ambiguity down rather than resolving it silently. Do not change any code.",
  },
  {
    role: "Planner",
    title: "Planning",
    stage: "Plan",
    what: "Writes a plan, then waits for you to approve it.",
    none: "skip",
    noneText: "Skipped. Work starts straight from the description.",
    defaultPrompt:
      "Produce a plan for this task, not an implementation. Read the code paths it touches first, " +
      "then give ordered steps naming the file and function each one changes. Call out the risky " +
      "parts and anything you had to assume, and say how the result will be verified. Do not " +
      "change any code.",
  },
  {
    role: "Coder",
    title: "Implementation",
    stage: "Implement",
    what: "Writes the code.",
    none: "default",
    noneText: "Runs on the project's default agent, with no instructions for this project.",
    defaultPrompt:
      "Implement this task. Follow the conventions of the surrounding code rather than introducing " +
      "your own, and keep the change to what was asked — no speculative extras. Verify before you " +
      "finish by running the project's tests, lint and build, and report plainly what passed, what " +
      "failed, and anything you left undone.",
  },
  {
    role: "Reviewer",
    title: "Review",
    stage: "Review",
    what: "Reviews the diff and can send it back for another run.",
    none: "skip",
    noneText: "Skipped. Finished work waits for you.",
    defaultPrompt:
      "Review this diff against the task it claims to implement. Look for correctness bugs, " +
      "unhandled cases, and changes that go beyond the task; judge style against the project's own " +
      "conventions, not your preferences. Report findings with a file and line and a concrete " +
      "failure case. Send the work back only for problems worth another run.",
  },
];

const LOOP_ROLES: RoleEntry[] = [
  {
    role: "Preparer",
    title: "Preparation",
    stage: "Prepare",
    what: "Writes the loop's tests and sets its checks with you.",
    none: "default",
    noneText: "Runs on the project's default agent.",
    defaultPrompt:
      "Prepare this loop so a worker agent can reach the goal by iterating until every check " +
      "passes. Read the goal and the code it touches, then restate it as observable outcomes and " +
      "ask the user about anything ambiguous before writing checks. Prefer command checks that " +
      "test behaviour through public interfaces, cover the edge cases and error paths the goal " +
      "names, run fast and deterministically, and fail with a message naming the input, the " +
      "expected value and the actual one. Run each one to prove it fails today for the right " +
      "reason. For more than one command, put the logic in a script file rather than a shell " +
      "one-liner: checks run in cmd on Windows and sh elsewhere. Seal every test and check script " +
      "the worker could edit to pass, and nothing it needs to change. Use a judge or manual check " +
      "only for what a command cannot decide. Never implement the goal or weaken a check.",
  },
  {
    role: "Worker",
    title: "Iterations",
    stage: "Iterate",
    what: "Works toward the loop's goal, one fresh session per iteration.",
    none: "default",
    noneText: "Runs on the project's default agent.",
    defaultPrompt:
      "Move this loop toward its goal in this iteration. Start from the failing checks and the " +
      "notes earlier iterations left, then make the smallest change that gets a failing check " +
      "closer to passing. Follow the conventions of the surrounding code. Never edit a test or a " +
      "check script to make it pass. Run the checks before you finish, and leave a short note on " +
      "what you changed and what the next iteration should try.",
  },
  {
    role: "Judge",
    title: "Judging",
    stage: "Judge",
    what: "Decides the judge checks and writes the summary you sign off.",
    none: "inherit",
    noneText: "Runs on the same agent as Iterate.",
    defaultPrompt:
      "Judge each check against the loop's diff and the code it touches, as a reviewer who has to " +
      "sign it off. Pass a check only when the work plainly meets it; when you fail one, say what " +
      "is missing and where, because that reason is all the next iteration gets.",
  },
];

const ROLES = [...PIPELINE_ROLES, ...LOOP_ROLES];

type Mode = "pipeline" | "loop";

const MODES: Record<Mode, { help: string; roles: RoleEntry[] }> = {
  pipeline: {
    help: "A task goes through these stages once, in order. You approve the work at the gates.",
    roles: PIPELINE_ROLES,
  },
  loop: {
    help: "A loop is prepared with you, then repeats Iterate and Judge until every check passes.",
    roles: LOOP_ROLES,
  },
};

const FALLBACK: Record<RoleEntry["none"], string> = {
  skip: "Without a profile, this stage is skipped.",
  default: "Without a profile, it runs on the project's default agent.",
  inherit: "Without a profile, it runs on the same agent as Iterate.",
};

interface AgentProfilesSectionProps {
  projectId: number;
  agents: Array<{ id: string; name: string }>;
  connection: ConnectionKey;
  /** The project's default agent, which runs a stage that has no profile and is not skipped. */
  defaultAgent: string | null;
}

/**
 * One profile: a line naming what it runs, and its editor below it when open.
 *
 * The editor is its own mount so each open profile probes its own agent: the probe costs a real
 * subprocess, and TanStack dedupes by query key, so profiles naming `claude-acp` on the same model
 * pay for one session between them. Only an open profile probes, which is also why one editor is
 * open at a time.
 */
function ProfileRow({
  profile,
  title,
  isDefault,
  open,
  agents,
  projectId,
  projectPath,
  connection,
  onToggle,
  onChange,
  onCommit,
  onMakeDefault,
  onRemove,
}: {
  profile: AgentProfile;
  title: string;
  isDefault: boolean;
  open: boolean;
  agents: Array<{ id: string; name: string }>;
  projectId: number;
  projectPath: string | null;
  connection: ConnectionKey;
  onToggle: () => void;
  /** `commit` persists the patch straight away; the text fields leave it to `onCommit`. */
  onChange: (patch: Partial<AgentProfile>, commit?: boolean) => void;
  onCommit: () => void;
  onMakeDefault: () => void;
  onRemove: () => void;
}) {
  const summary = [
    agents.find((a) => a.id === profile.agent_id)?.name ?? profile.agent_id,
    profile.model,
    profile.permission_mode,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    // React's `onBlur` is `focusout`, which bubbles: one handler here covers the name and the
    // role prompt without threading a save through each of them. The selects commit themselves,
    // since a choice from a list is finished the moment it is made.
    <div
      onBlur={onCommit}
      className={cn(
        "rounded-md border p-3 space-y-3",
        isDefault ? "border-accent/60 bg-accent/5" : "border-border",
      )}
    >
      <div className="flex items-center gap-3">
        {/* Radio rather than a toggle: exactly one profile per role is the default, and a toggle
            would let the user turn the last one off. */}
        <input
          type="radio"
          name={`default-${profile.role}`}
          checked={isDefault}
          onChange={onMakeDefault}
          aria-label={`Use ${profile.name} by default for ${title}`}
          className="accent-accent"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{profile.name || "Unnamed profile"}</p>
          <p className="truncate text-xs text-muted-foreground">{summary}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? "Close" : "Edit"} ${profile.name}`}
        >
          {open ? "Close" : "Edit"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          aria-label={`Remove ${profile.name}`}
          className="shrink-0 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3" />
        </Button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border pt-3">
          <label className="block space-y-1 text-xs text-muted-foreground">
            Name
            <Input
              value={profile.name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="Name"
              className="h-8 text-sm"
            />
          </label>
          <AgentConfigFields
            value={profile}
            label={profile.name}
            agents={agents}
            projectId={projectId}
            projectPath={projectPath}
            connection={connection}
            readOnly={isReadOnlyRole(profile.role)}
            onChange={onChange}
          />
          <label className="block space-y-1 text-xs text-muted-foreground">
            Instructions, sent ahead of the task
            <Textarea
              value={profile.role_prompt ?? ""}
              onChange={(e) => onChange({ role_prompt: e.target.value || null })}
              placeholder="What this stage means in this project."
              className="min-h-24 text-sm"
            />
          </label>
        </div>
      )}
    </div>
  );
}

type Runs = { text: string; sub: string; kind: "profile" | "default" | "skip" };

/** A stage in the workflow row, saying what runs it. */
function StageButton({
  entry,
  runs,
  selected,
  onSelect,
}: {
  entry: RoleEntry;
  runs: Runs;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${entry.stage}: ${runs.text}`}
      className={cn(
        "min-w-0 flex-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
        runs.kind === "skip" && "border-dashed text-muted-foreground",
        selected ? "border-accent bg-accent/10 ring-1 ring-accent/40" : "hover:bg-muted",
      )}
    >
      <span className="block text-sm font-medium">{entry.stage}</span>
      <span className="mt-1 flex items-center gap-1.5 text-xs">
        <span
          className={cn(
            "inline-block size-2 shrink-0 rounded-full",
            runs.kind === "profile"
              ? "bg-chart-2"
              : runs.kind === "skip"
                ? "bg-muted-foreground/40"
                : "bg-chart-4",
          )}
        />
        <span className="truncate">{runs.text}</span>
      </span>
      <span className="block truncate pl-3.5 text-[11px] text-muted-foreground">{runs.sub}</span>
    </button>
  );
}

function Arrow() {
  return <ArrowRight aria-hidden className="size-4 shrink-0 self-center text-muted-foreground" />;
}

/**
 * A profile id the user never has to see or type.
 *
 * The id is what a task's override stores and what `defaults` points at, so it has to be stable
 * and unique — but asking for one would be asking about a foreign key. Derived from the role and
 * a timestamp rather than the name, because renaming a profile must not orphan the tasks pointing
 * at it.
 */
function newProfileId(role: AgentRole): string {
  return `${role.toLowerCase()}-${Date.now().toString(36)}`;
}

/** Comparable form of the document, for skipping writes that would change nothing. */
function serialize(profiles: AgentProfile[], defaults: Record<string, string>): string {
  return JSON.stringify({ profiles, defaults });
}

export function AgentProfilesSection({
  projectId,
  agents,
  connection,
  defaultAgent,
}: AgentProfilesSectionProps) {
  const profilesQuery = useAgentProfilesQuery(projectId);
  const saveProfiles = useSaveAgentProfilesMutation();
  const projectPath = useSelectedProject()?.path ?? null;

  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  // What is on disk. The blur handler fires on every focus change, including tabbing through
  // fields without touching them, and a project's `profiles.json` may be an SSH round trip away.
  const [persisted, setPersisted] = useState("");
  // Which workflow is shown, the stage open in each, and the one profile being edited.
  const [mode, setMode] = useState<Mode>("pipeline");
  const [selected, setSelected] = useState<Record<Mode, AgentRole>>({
    pipeline: "Coder",
    loop: "Worker",
  });
  const [editing, setEditing] = useState<string | null>(null);

  // Adopted from the query during render rather than from an effect, which would paint an empty
  // list over profiles already fetched. Latched on the object identity so the user's edits are not
  // overwritten by a refetch that returned the same document.
  const stored = profilesQuery.data ?? null;
  const [loaded, setLoaded] = useState<ProfilesDocument | null>(null);
  if (stored && loaded !== stored) {
    setLoaded(stored);
    // Both are `#[serde(default)]` on the Rust side, so a `profiles.json` that omits either — or
    // has never been written at all — arrives with them undefined rather than empty.
    const storedProfiles = stored.profiles ?? [];
    const storedDefaults = Object.fromEntries(
      Object.entries(stored.defaults ?? {}).filter(
        (entry): entry is [string, string] => entry[1] != null,
      ),
    );
    setProfiles(storedProfiles);
    setDefaults(storedDefaults);
    setPersisted(serialize(storedProfiles, storedDefaults));
  }

  // A different project starts from nothing until its own query lands, so the previous project's
  // profiles are never shown against it.
  const [prevProjectId, setPrevProjectId] = useState(projectId);
  if (prevProjectId !== projectId) {
    setPrevProjectId(projectId);
    setLoaded(null);
    setProfiles([]);
    setDefaults({});
  }

  /**
   * There is no Save button: every change persists as it is made.
   *
   * The next profiles and defaults are passed in rather than read from state, because a handler
   * that just called `setProfiles` still sees the previous render's value. Guarded on `loaded`
   * so the adopt-from-query render can never write an empty document over the project's file.
   */
  function saveNow(nextProfiles: AgentProfile[], nextDefaults: Record<string, string>) {
    if (!loaded) return;
    const next = serialize(nextProfiles, nextDefaults);
    if (next === persisted) return;
    setPersisted(next);
    saveProfiles.mutate({
      projectId,
      document: { profiles: nextProfiles, defaults: nextDefaults },
    });
  }

  function updateProfile(id: string, patch: Partial<AgentProfile>, commit = false) {
    const next = profiles.map((p) => (p.id === id ? { ...p, ...patch } : p));
    setProfiles(next);
    if (commit) saveNow(next, defaults);
  }

  function addProfile(role: AgentRole) {
    const id = newProfileId(role);
    const next: AgentProfile[] = [
      ...profiles,
      {
        id,
        name: `${role} profile`,
        role,
        agent_id: agents[0]?.id ?? "",
        skills: [],
        mcp_servers: [],
        // A draft to edit, not a blank page. An empty box is why most profiles never get a prompt,
        // and a role with no prompt is the generic agent the profile existed to replace.
        role_prompt: ROLES.find((r) => r.role === role)?.defaultPrompt ?? null,
        fallback_behaviour: "Warn",
      },
    ];
    // The first profile for a role becomes its default, because a role with profiles and no
    // default resolves to "the first one declaring the role" anyway — better to say so.
    const nextDefaults = defaults[role] ? defaults : { ...defaults, [role]: id };
    setProfiles(next);
    setDefaults(nextDefaults);
    setEditing(id);
    saveNow(next, nextDefaults);
  }

  function removeProfile(id: string, role: AgentRole) {
    const remaining = profiles.filter((p) => p.id !== id);
    let nextDefaults = defaults;
    if (defaults[role] === id) {
      nextDefaults = { ...defaults };
      const fallback = remaining.find((p) => p.role === role);
      if (fallback) nextDefaults[role] = fallback.id;
      else delete nextDefaults[role];
    }
    setProfiles(remaining);
    setDefaults(nextDefaults);
    saveNow(remaining, nextDefaults);
  }

  function makeDefault(role: AgentRole, id: string) {
    const nextDefaults = { ...defaults, [role]: id };
    setDefaults(nextDefaults);
    saveNow(profiles, nextDefaults);
  }

  const agentName = (id: string | null) =>
    id ? (agents.find((a) => a.id === id)?.name ?? id) : "none set";

  /** What runs a stage: its default profile, else what its `none` says. */
  function runsBy(entry: RoleEntry): Runs {
    const forRole = profiles.filter((p) => p.role === entry.role);
    const chosen = forRole.find((p) => p.id === defaults[entry.role]) ?? forRole[0];
    if (chosen) {
      return {
        text: chosen.name || "Unnamed profile",
        sub: agentName(chosen.agent_id),
        kind: "profile",
      };
    }
    if (entry.none === "skip") return { text: "Skipped", sub: "no profile", kind: "skip" };
    if (entry.none === "inherit") {
      const iterate = runsBy(LOOP_ROLES.find((r) => r.role === "Worker")!);
      return { text: "Same as Iterate", sub: iterate.sub, kind: "default" };
    }
    return { text: "Default agent", sub: agentName(defaultAgent), kind: "default" };
  }

  const roles = MODES[mode].roles;
  const entry = roles.find((r) => r.role === selected[mode])!;
  const forRole = profiles.filter((p) => p.role === entry.role);
  const stageButton = (r: RoleEntry) => (
    <StageButton
      key={r.role}
      entry={r}
      runs={runsBy(r)}
      selected={r.role === entry.role}
      onSelect={() => {
        setSelected({ ...selected, [mode]: r.role });
        setEditing(null);
      }}
    />
  );

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Bot className="size-4" />
          Agents for the task workflow
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Choose the agent and the instructions for each stage.
        </p>
      </div>

      <div className="space-y-2">
        <Tabs
          value={mode}
          onValueChange={(value) => {
            setMode(value as Mode);
            setEditing(null);
          }}
        >
          <TabsList>
            <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
            <TabsTrigger value="loop">Loops</TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-xs text-muted-foreground">{MODES[mode].help}</p>
      </div>

      {mode === "pipeline" ? (
        <div className="flex items-stretch gap-2">
          {roles.flatMap((r, i) => [i > 0 && <Arrow key={`to-${r.role}`} />, stageButton(r)])}
        </div>
      ) : (
        // Room above the row for the line that runs from Judge back into Iterate.
        <div className="flex items-stretch gap-2 pt-8">
          {stageButton(roles[0]!)}
          <Arrow />
          <div className="relative flex flex-[2] items-stretch gap-2 pr-5">
            {stageButton(roles[1]!)}
            <Arrow />
            {stageButton(roles[2]!)}
            {/* Out of Judge's right side, up, along the top, and down into the middle of Iterate,
                whose centre is a quarter of the width left once the gutter, arrow and gaps are
                taken off. */}
            <span
              aria-hidden
              className="pointer-events-none absolute -top-6 right-1 bottom-1/2 w-4 rounded-r-md border-y border-r border-muted-foreground/50"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute -top-6 right-5 left-[calc((100%-3.25rem)/4)] h-6 rounded-tl-md border-t border-l border-muted-foreground/50"
            />
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute -top-2.5 left-[calc((100%-3.25rem)/4)] size-3 -translate-x-1/2 text-muted-foreground"
            />
            <span className="absolute -top-5 left-[calc((100%-3.25rem)/4+0.5rem)] flex items-center gap-1 whitespace-nowrap text-[11px] leading-4 text-muted-foreground">
              <Repeat aria-hidden className="size-3" />
              Repeats until every check passes
            </span>
          </div>
        </div>
      )}

      <section aria-label={entry.title} className="rounded-lg border border-border p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold">{entry.title}</h4>
            <p className="text-xs text-muted-foreground">{entry.what}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => addProfile(entry.role)}
            aria-label={`Add a ${entry.title} profile`}
            className="shrink-0"
          >
            <Plus className="size-3" />
            Add profile
          </Button>
        </div>

        {forRole.length === 0 ? (
          <p className="rounded-md bg-muted/60 px-3 py-2.5 text-xs">
            <span className="font-medium">No profile.</span> {entry.noneText}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {forRole.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  title={entry.title}
                  isDefault={defaults[entry.role] === profile.id}
                  open={editing === profile.id}
                  agents={agents}
                  projectId={projectId}
                  projectPath={projectPath}
                  connection={connection}
                  onToggle={() => setEditing(editing === profile.id ? null : profile.id)}
                  onChange={(patch, commit) => updateProfile(profile.id, patch, commit)}
                  onCommit={() => saveNow(profiles, defaults)}
                  onMakeDefault={() => makeDefault(entry.role, profile.id)}
                  onRemove={() => removeProfile(profile.id, entry.role)}
                />
              ))}
            </div>
            {forRole.length > 1 && (
              <p className="text-xs text-muted-foreground">
                A task uses the default profile unless its Agents dialog picks another.
              </p>
            )}
            <p className="text-xs text-muted-foreground">{FALLBACK[entry.none]}</p>
          </>
        )}
      </section>
    </div>
  );
}
