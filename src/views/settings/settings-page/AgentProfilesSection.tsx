import { useState } from "react";
import { Bot, Plus, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { AgentConfigFields } from "@/components/common/agent-config/AgentConfigFields";
import { useAgentProfilesQuery, useSaveAgentProfilesMutation } from "@/services/project.service";
import { isReadOnlyRole } from "@/lib/permission-modes";
import { useSelectedProject } from "@/store/projectStore";
import type { AgentProfile, AgentRole, ConnectionKey, ProfilesDocument } from "@/types/bindings";
import { cn } from "@/lib/utils";

/**
 * The four roles, in the order a task passes through them.
 *
 * Each line says what the role costs the user rather than what it is called: a project with no
 * profile for a role simply skips that stage, and "no Reviewer" being the difference between a
 * task stopping at your gate and going straight to it is not obvious from the word "Reviewer".
 *
 * `defaultPrompt` is the text a new profile of that role starts with. It is copied into the
 * profile on creation rather than applied as a fallback at resolution time, because the user has
 * to be able to read it, edit it and delete it — none of which is true of a prompt that only
 * exists as a hidden default. The cost of that choice is that editing the text here does not
 * reach profiles already written, which is the right way round: those are the team's, not ours.
 * Deliberately project-neutral, since the project-specific half is what the user adds.
 */
const ROLES: Array<{ role: AgentRole; title: string; blurb: string; defaultPrompt: string }> = [
  {
    role: "Refiner",
    title: "Refinement",
    blurb:
      "Sharpens a task's description before anyone implements it. Without one, Planning has no Refine.",
    defaultPrompt:
      "Sharpen this task's description so it can be implemented without coming back to ask what it " +
      "meant. Read enough of the codebase to ground it: name the files and functions involved, say " +
      "what done looks like, and say what is out of scope. Where the task is genuinely ambiguous, " +
      "write the ambiguity down rather than resolving it silently. Do not change any code.",
  },
  {
    role: "Planner",
    title: "Planning",
    blurb:
      "Writes a plan and stops at a gate for you. Without one, work starts straight from the description.",
    defaultPrompt:
      "Produce a plan for this task, not an implementation. Read the code paths it touches first, " +
      "then give ordered steps naming the file and function each one changes. Call out the risky " +
      "parts and anything you had to assume, and say how the result will be verified. Do not " +
      "change any code.",
  },
  {
    role: "Coder",
    title: "Implementation",
    blurb:
      "The only role allowed to write. Runs without a profile, on the project's default agent — " +
      "a profile is how it gets this project's instructions.",
    defaultPrompt:
      "Implement this task. Follow the conventions of the surrounding code rather than introducing " +
      "your own, and keep the change to what was asked — no speculative extras. Verify before you " +
      "finish by running the project's tests, lint and build, and report plainly what passed, what " +
      "failed, and anything you left undone.",
  },
  {
    role: "Reviewer",
    title: "Review",
    blurb:
      "Reviews the diff and can send it back. Without one, finished work waits for you instead.",
    defaultPrompt:
      "Review this diff against the task it claims to implement. Look for correctness bugs, " +
      "unhandled cases, and changes that go beyond the task; judge style against the project's own " +
      "conventions, not your preferences. Report findings with a file and line and a concrete " +
      "failure case. Send the work back only for problems worth another run.",
  },
];

interface AgentProfilesSectionProps {
  projectId: number;
  agents: Array<{ id: string; name: string }>;
  connection: ConnectionKey;
}

/**
 * One profile's editable fields: what is this profile's own, around the agent settings every
 * caller of `AgentConfigFields` shares.
 *
 * Still its own component so each card probes its own agent: the probe costs a real subprocess,
 * and TanStack dedupes by query key, so four profiles naming `claude-acp` on the same model pay
 * for one session between them rather than four. Naming different models is what splits them, and
 * that is the point — the effort list differs per model.
 */
function ProfileCard({
  profile,
  title,
  isDefault,
  agents,
  projectId,
  projectPath,
  connection,
  onChange,
  onCommit,
  onMakeDefault,
  onRemove,
}: {
  profile: AgentProfile;
  title: string;
  isDefault: boolean;
  agents: Array<{ id: string; name: string }>;
  projectId: number;
  projectPath: string | null;
  connection: ConnectionKey;
  /** `commit` persists the patch straight away; the text fields leave it to `onCommit`. */
  onChange: (patch: Partial<AgentProfile>, commit?: boolean) => void;
  onCommit: () => void;
  onMakeDefault: () => void;
  onRemove: () => void;
}) {
  return (
    // React's `onBlur` is `focusout`, which bubbles — one handler here covers the name and the
    // role prompt without threading a save through each of them. The three selects commit
    // themselves, since a choice from a list is finished the moment it is made.
    <div
      onBlur={onCommit}
      className={cn(
        "rounded-md border p-3 space-y-2",
        isDefault ? "border-accent/60 bg-accent/5" : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
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
        <Input
          value={profile.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Name"
          className="h-7 text-xs"
        />
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

      <label className="text-[11px] text-muted-foreground space-y-1 block">
        Instructions for this role
        <Textarea
          value={profile.role_prompt ?? ""}
          onChange={(e) => onChange({ role_prompt: e.target.value || null })}
          placeholder="What this role means in this project. Sent ahead of the task."
          className="min-h-16 text-xs"
        />
      </label>
    </div>
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

export function AgentProfilesSection({ projectId, agents, connection }: AgentProfilesSectionProps) {
  const profilesQuery = useAgentProfilesQuery(projectId);
  const saveProfiles = useSaveAgentProfilesMutation();
  const projectPath = useSelectedProject()?.path ?? null;

  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  // What is on disk. The blur handler fires on every focus change, including tabbing through
  // fields without touching them, and a project's `profiles.json` may be an SSH round trip away.
  const [persisted, setPersisted] = useState("");

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

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Bot className="size-4" />
          Agents for the task workflow
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Which agent runs each stage of a task. Saved in this project&apos;s{" "}
          <code className="text-[11px]">.maestro/profiles.json</code>, so the whole team gets the
          same pipeline. A role with no profile is skipped — except Implementation, which runs on
          the project&apos;s default agent.
        </p>
      </div>

      {ROLES.map(({ role, title, blurb }) => {
        const forRole = profiles.filter((p) => p.role === role);
        return (
          <div key={role} className="space-y-2 pt-2 border-t border-border first:border-t-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold">{title}</p>
                <p className="text-[11px] text-muted-foreground">{blurb}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addProfile(role)}
                aria-label={`Add a ${title} profile`}
                className="shrink-0"
              >
                <Plus className="size-3" />
                Add
              </Button>
            </div>

            {forRole.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic">
                {role === "Coder"
                  ? "No profile — runs on the project's default agent."
                  : "No profile — stage skipped."}
              </p>
            ) : (
              forRole.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  profile={profile}
                  title={title}
                  isDefault={defaults[role] === profile.id}
                  agents={agents}
                  projectId={projectId}
                  projectPath={projectPath}
                  connection={connection}
                  onChange={(patch, commit) => updateProfile(profile.id, patch, commit)}
                  onCommit={() => saveNow(profiles, defaults)}
                  onMakeDefault={() => makeDefault(role, profile.id)}
                  onRemove={() => removeProfile(profile.id, role)}
                />
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}
