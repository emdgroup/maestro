import { cloneElement, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, Plus, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { SEGMENT_LIST, SEGMENT_TRIGGER } from "@/components/kanban/shared/pill-styles";
import { Textarea } from "@/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { AgentConfigFields } from "@/components/common/agent-config/AgentConfigFields";
import { useAgentProfilesQuery, useSaveAgentProfilesMutation } from "@/services/project.service";
import { ROLE_PROMPTS, STAGE_NAMES, STAGE_TITLES } from "@/lib/default-profiles";
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
 */
type RoleEntry = {
  role: AgentRole;
  title: string;
  /** The stage's name in the workflow row. */
  stage: string;
  what: string;
  /** What runs the stage without a profile: nothing, the project's default agent, or Build's. */
  none: "skip" | "default" | "inherit";
  noneText: string;
};

const PIPELINE_ROLES: RoleEntry[] = [
  {
    role: "Refiner",
    title: STAGE_TITLES.Refiner,
    stage: STAGE_NAMES.Refiner,
    what: "Sharpens a task's description before anyone implements it.",
    none: "skip",
    noneText: "The stage is skipped, and tasks in Planning show no Refine button.",
  },
  {
    role: "Planner",
    title: STAGE_TITLES.Planner,
    stage: STAGE_NAMES.Planner,
    what: "Writes a plan, then waits for you to approve it.",
    none: "skip",
    noneText: "The stage is skipped, and work starts straight from the description.",
  },
  {
    role: "Coder",
    title: STAGE_TITLES.Coder,
    stage: STAGE_NAMES.Coder,
    what: "Writes the code.",
    none: "default",
    noneText: "Runs on the project's default agent, with no instructions.",
  },
  {
    role: "Reviewer",
    title: STAGE_TITLES.Reviewer,
    stage: STAGE_NAMES.Reviewer,
    what: "Reviews the diff and can send it back for another run.",
    none: "skip",
    noneText: "The stage is skipped, and finished work comes straight to you.",
  },
];

const LOOP_ROLES: RoleEntry[] = [
  {
    role: "Preparer",
    title: STAGE_TITLES.Preparer,
    stage: STAGE_NAMES.Preparer,
    what: "Writes the loop's tests and sets its checks with you.",
    none: "default",
    noneText: "Runs on the project's default agent.",
  },
  {
    role: "Worker",
    title: STAGE_TITLES.Worker,
    stage: STAGE_NAMES.Worker,
    what: "Works toward the loop's goal, one fresh session per iteration.",
    none: "default",
    noneText: "Runs on the project's default agent.",
  },
  {
    role: "Judge",
    title: STAGE_TITLES.Judge,
    stage: STAGE_NAMES.Judge,
    what: "Decides the judge checks and writes the summary you sign off.",
    none: "inherit",
    noneText: "Runs on the same agent as Build.",
  },
];

type Mode = "pipeline" | "loop";

const MODES: Record<Mode, { help: string; roles: RoleEntry[] }> = {
  pipeline: {
    help: "Stages run in order, and Review can send work back to Implement. You approve at the gates.",
    roles: PIPELINE_ROLES,
  },
  loop: {
    help: "A loop is prepared with you, then each iteration runs Build, then Judge, until every check passes.",
    roles: LOOP_ROLES,
  },
};

const FALLBACK: Record<RoleEntry["none"], string> = {
  skip: "Remove every profile and the stage is skipped.",
  default: "Remove every profile and the stage runs on the project's default agent.",
  inherit: "Remove every profile and the stage runs on the same agent as Build.",
};

interface AgentProfilesSectionProps {
  projectId: number;
  agents: Array<{ id: string; name: string }>;
  connection: ConnectionKey;
  /** The project's default agent, which runs a stage that has no profile and is not skipped. */
  defaultAgent: string | null;
  /** Settings for loops as a whole, shown under the Loops tab. */
  loopSettings?: ReactNode;
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
        "rounded-xl border p-3 space-y-3",
        isDefault ? "border-accent/60 bg-accent/5" : "border-foreground/7 bg-background/50",
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
        <div className="space-y-3 border-t border-foreground/9 pt-3">
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
  const button = (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${entry.stage}: ${runs.text}`}
      className={cn(
        "min-w-0 flex-1 rounded-xl border border-foreground/7 bg-background/50 px-3 py-2.5 text-left transition-colors",
        runs.kind === "skip" && "border-dashed text-muted-foreground",
        selected ? "border-accent bg-accent/10 ring-1 ring-accent/40" : "hover:bg-background/84",
      )}
    />
  );
  const content = (
    <>
      <span className="block text-sm font-medium">{entry.stage}</span>
      <span className="mt-1 flex items-center gap-1.5 text-xs">
        <span
          className={cn(
            "inline-block size-2 shrink-0 rounded-full",
            runs.kind === "profile" ? "bg-success" : "bg-warning",
          )}
        />
        <span className="truncate">{runs.text}</span>
      </span>
      <span className="block truncate pl-3.5 text-[11px] text-muted-foreground">{runs.sub}</span>
    </>
  );
  // The card truncates a long profile name, so hovering it shows the whole one.
  if (runs.kind !== "profile") return cloneElement(button, {}, content);
  return (
    <Tooltip>
      <TooltipTrigger render={button}>{content}</TooltipTrigger>
      <TooltipContent>{runs.text}</TooltipContent>
    </Tooltip>
  );
}

function Arrow() {
  return <ArrowRight aria-hidden className="size-4 shrink-0 self-center text-muted-foreground" />;
}

/** `Arrow` over its reverse, for two stages that hand work back and forth. */
function BackAndForth() {
  return (
    <span aria-hidden className="flex shrink-0 flex-col self-center text-muted-foreground">
      <ArrowRight className="size-4" />
      <ArrowLeft className="size-4" />
    </span>
  );
}

/** Lucide's 24-unit `ArrowRight` at 16px: a 1.33px line with round ends and joins. */
const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.33,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * Out of the iteration box's right side, up round its top-right corner, along its top, and down
 * into the middle of the Build card.
 *
 * Drawn in pixels rather than a scaled viewBox so the stroke and the head match `Arrow`. Three
 * pieces, because only the top run changes length with the box: the right-hand turn, the top run,
 * and the left-hand turn with the head. The Build card's centre is `25% - 4px` of the box's padding
 * box: the box's 8px padding, then half of what is left once the 16px arrow and two 8px gaps
 * between the cards are taken off.
 *
 * The line keeps the same 19px off the box's border along the top as down the right side, leaves
 * the right side 46px down, about level with the arrows inside it, and the head stops 2px above
 * the box's top border.
 */
function LoopArrow() {
  return (
    <>
      {/* The box's top-right corner is at (44, 24). */}
      <svg
        aria-hidden
        width="72"
        height="96"
        viewBox="0 0 72 96"
        {...LINE}
        className="pointer-events-none absolute -right-7 -top-6 text-muted-foreground"
      >
        <path d="M46 70h10a8 8 0 0 0 8-8V12a8 8 0 0 0-8-8" />
      </svg>
      <span
        aria-hidden
        className="pointer-events-none absolute -right-3 -top-5 left-[calc(25%+4px)] h-[1.33px] -translate-y-1/2 bg-muted-foreground"
      />
      {/* The Build card's centre is at x = 8. */}
      <svg
        aria-hidden
        width="24"
        height="32"
        viewBox="0 0 24 32"
        {...LINE}
        className="pointer-events-none absolute -top-7 left-[calc(25%-12px)] text-muted-foreground"
      >
        <path d="M16 8a8 8 0 0 0-8 8v10" />
        <path d="m3.33 21.33 4.67 4.67 4.67-4.67" />
      </svg>
    </>
  );
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
  loopSettings,
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
        role_prompt: ROLE_PROMPTS[role],
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
      const worker = runsBy(LOOP_ROLES.find((r) => r.role === "Worker")!);
      return { text: "Same as Build", sub: worker.sub, kind: "default" };
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
    <div className="rounded-2xl border border-foreground/7 bg-card p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Bot className="size-4" />
          Task workflow stages
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Each stage runs on a profile: an agent, its settings, and instructions for this project.
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
          <TabsList className={SEGMENT_LIST}>
            <TabsTrigger value="pipeline" className={SEGMENT_TRIGGER}>
              Pipeline
            </TabsTrigger>
            <TabsTrigger value="loop" className={SEGMENT_TRIGGER}>
              Loops
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-xs text-muted-foreground">{MODES[mode].help}</p>
      </div>

      {mode === "pipeline" ? (
        <div className="flex items-stretch gap-2">
          {roles.flatMap((r, i) => [
            i > 0 &&
              // The reviewer can send the work back to the coder, so that pair goes both ways.
              (r.role === "Reviewer" ? (
                <BackAndForth key={`to-${r.role}`} />
              ) : (
                <Arrow key={`to-${r.role}`} />
              )),
            stageButton(r),
          ])}
        </div>
      ) : (
        // Prepare, then the box of the two stages each iteration runs. Room above and to the right
        // for the arrow that loops out of the box and back into it.
        // Pulled up to the help line above it: the room on top is the arrow's and the label's.
        <div className="-mt-3 flex items-stretch gap-2 pt-[22px]">
          {/* Padded as the box is, so Prepare lines up with the stages inside it. */}
          <div className="flex flex-1 py-2">{stageButton(roles[0]!)}</div>
          <Arrow />
          <div className="relative mr-7 flex flex-[2] items-stretch gap-2 rounded-xl border border-dashed border-border p-2">
            <span className="absolute bottom-full left-3 text-[11px] leading-4 text-muted-foreground">
              Iteration
            </span>
            {stageButton(roles[1]!)}
            <Arrow />
            {stageButton(roles[2]!)}
            <LoopArrow />
          </div>
        </div>
      )}

      <section
        aria-label={entry.title}
        className="rounded-2xl border border-foreground/7 bg-card p-4 space-y-3"
      >
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
          <p className="rounded-xl bg-foreground/5 px-3 py-2.5 text-xs">
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
                Tasks use the selected profile. A task can pick another from Agents on its card.
              </p>
            )}
            <p className="text-xs text-muted-foreground">{FALLBACK[entry.none]}</p>
          </>
        )}
      </section>

      {mode === "loop" && loopSettings}
    </div>
  );
}
