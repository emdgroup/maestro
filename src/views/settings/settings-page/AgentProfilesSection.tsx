import { useEffect, useMemo, useState } from "react";
import { Bot, Plus, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { useAgentProfilesQuery, useSaveAgentProfilesMutation } from "@/services/project.service";
import { useAgentConfigQuery, type AgentModel } from "@/services/execution.service";
import { isReadOnlyRole, resolveAutomaticMode } from "@/lib/permission-modes";
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
 * One profile's editable fields.
 *
 * Its own component so it can ask for its own agent's models: the probe costs a real subprocess,
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
  const agentMissing = !!profile.agent_id && !agents.some((a) => a.id === profile.agent_id);
  const agentLabel = agentMissing
    ? `${profile.agent_id} (not found)`
    : (agents.find((a) => a.id === profile.agent_id)?.name ?? "Select an agent");

  // An agent this machine does not have cannot answer, and every field below clears what the probe
  // does not confirm — so probing one would wipe a profile written on a machine that has it. The
  // agent itself is still shown as `(not found)`, which is the honest thing to say about it.
  const probeEnabled = !!profile.agent_id && !agentMissing;

  const {
    data: config,
    isLoading: probeLoading,
    isSuccess: probeAnswered,
    isError: probeFailed,
  } = useAgentConfigQuery(
    profile.agent_id || null,
    projectPath,
    projectId,
    connection,
    // Effort is per-model, so the probe has to run against the model this profile names rather
    // than whichever one the agent opens on.
    profile.model ?? null,
    probeEnabled,
  );

  // Memoized for the reset effects below: `?? []` hands them a fresh array on every render, which
  // is a dependency that never settles.
  const available = useMemo(() => config?.models ?? [], [config]);
  const availableModes = useMemo(() => config?.modes ?? [], [config]);
  const availableEfforts = useMemo(() => config?.effort?.values ?? [], [config]);

  // Every reset below waits for this, and it is asserted rather than inferred from `!probeLoading`.
  // A query whose key has just changed is neither loading nor answered for a render or two, and a
  // disabled probe reports `isLoading: false` with no data for ever — both look exactly like "the
  // agent offers nothing", which is what the resets act on. Reading the settled states directly is
  // the difference between a re-probe and a wipe.
  const probeSettled = probeEnabled && (probeAnswered || probeFailed);

  // The models a probe of *this agent* reported, kept across the re-probe that changing the model
  // sets off. Retaining them is not showing a stale answer: the model list is a property of the
  // agent, and the model the session opened on cannot change it. It is what lets this one field go
  // on naming the model the user just picked, instead of blanking to "asking the agent…" for the
  // one answer the user supplied themselves. Reset with the agent, whose list it is.
  //
  // Naming only. The reset effects below read the live `available`, which is empty until the probe
  // settles and is exactly what they wait for.
  const [namedModels, setNamedModels] = useState<AgentModel[]>([]);
  const [namedFor, setNamedFor] = useState(profile.agent_id);
  if (namedFor !== profile.agent_id) {
    setNamedFor(profile.agent_id);
    setNamedModels([]);
  } else if (available.length > 0 && namedModels !== available) {
    setNamedModels(available);
  }
  const modelName = (id: string) =>
    (available.find((m) => m.model_id === id) ?? namedModels.find((m) => m.model_id === id))
      ?.name ?? id;

  // What the dropdown offers. Falling back to the retained list is what keeps the control alive
  // during a re-probe: disabling it while the user's own selection was still settling meant
  // base-ui tore down an open popup and reported the value as cleared, which read as the model
  // reverting to "agent default" the moment it was picked.
  const modelOptions = available.length > 0 ? available : namedModels;

  const defaultModelItemLabel = probeFailed ? "agent default (could not ask)" : "agent default";
  const defaultModelLabel = probeLoading ? "asking the agent…" : defaultModelItemLabel;
  // Deliberately does not go to "asking the agent…" while probing: a chosen model is the one thing
  // on this card that is not in question. Only the unchosen case defers to the probe, because
  // "agent default" is genuinely a name nobody knows yet.
  const modelLabel = profile.model ? modelName(profile.model) : defaultModelLabel;

  const readOnlyRole = isReadOnlyRole(profile.role);
  const automaticMode = resolveAutomaticMode(
    availableModes.map((m) => m.mode_id),
    readOnlyRole,
  );

  // No field ever shows a value the agent did not offer. A stored value this machine cannot
  // confirm is treated the same as one it confirmed absent, because the two are indistinguishable
  // from here and the alternative — labelling it `(not offered)` — put a selection on screen that
  // the spawn then silently ignored. The cost is real and deliberate: an unreachable agent clears
  // the fields of the profiles naming it, for the whole team, since `profiles.json` is committed.
  //
  // Each write makes its own condition false, so none of these re-fire.
  useEffect(() => {
    if (!probeSettled || !profile.model) return;
    if (available.some((m) => m.model_id === profile.model)) return;
    onChange({ model: null }, true);
  }, [probeSettled, profile.model, available, onChange]);

  // The mode carries the fill-in case too: a profile that names none gets the one its role needs
  // as soon as the agent says what it offers, rather than leaving the spawn to resolve it every
  // time into a field that stays blank. Both cases are "replace what is stored with what the role
  // would pick", which is why they are one effect.
  useEffect(() => {
    if (!probeSettled) return;
    const stored = profile.permission_mode ?? null;
    if (stored && availableModes.some((m) => m.mode_id === stored)) return;
    if (stored === automaticMode) return;
    onChange({ permission_mode: automaticMode }, true);
  }, [probeSettled, profile.permission_mode, availableModes, automaticMode, onChange]);

  // Nothing to fill in here, unlike the mode: an unset effort is a real answer and the common one.
  useEffect(() => {
    if (!probeSettled || !profile.effort) return;
    if (availableEfforts.some((e) => e.value === profile.effort)) return;
    onChange({ effort: null }, true);
  }, [probeSettled, profile.effort, availableEfforts, onChange]);

  // An agent that offers no modes has nothing to pick from, and a profile with nothing stored has
  // nothing to show, so the dropdown would open onto an empty list.
  const noModesToOffer = !probeLoading && availableModes.length === 0 && !profile.permission_mode;

  // Only ever the name of a real mode. The unselected states are the transient ones — the probe
  // still running, or an agent offering modes but none the role can use — and they say what is
  // happening rather than naming a choice that was never made.
  const modeLabel = profile.permission_mode
    ? (availableModes.find((m) => m.mode_id === profile.permission_mode)?.name ??
      profile.permission_mode)
    : probeLoading
      ? "asking the agent…"
      : noModesToOffer
        ? "Not available"
        : "Select a permission mode";

  // Unlike the mode, an unset effort is a real and common answer — most agents have no such
  // setting, and those that do have a default of their own worth deferring to. So there is nothing
  // to fill in, and "Not available" is reserved for an agent that offers none at all.
  const noEffortToOffer = !probeLoading && availableEfforts.length === 0 && !profile.effort;
  const effortLabel = profile.effort
    ? (availableEfforts.find((e) => e.value === profile.effort)?.name ?? profile.effort)
    : probeLoading
      ? "asking the agent…"
      : noEffortToOffer
        ? "Not available"
        : "agent default";

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

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Agent</span>
          {/* `?? ""` because base-ui hands back null when a selection is cleared, which a native
              select could not do. An empty agent id is "not chosen yet", which the resolver
              already treats as falling back to the project default. */}
          {/* The other three fields belong to the agent, so they go with it — in one patch, not as
              a reset the probe works out afterwards. A model id is only meaningful to the harness
              that issued it, and carrying one across meant the next probe asked the new agent to
              select a model it had never heard of, which it answers with an error the user sees. */}
          <Select
            value={profile.agent_id}
            onValueChange={(v) =>
              onChange(
                { agent_id: v ?? "", model: null, permission_mode: null, effort: null },
                true,
              )
            }
          >
            <SelectTrigger size="sm" className="w-full text-xs" aria-label={agentLabel}>
              <span className="truncate flex-1 text-left">{agentLabel}</span>
            </SelectTrigger>
            <SelectContent>
              {/* Kept even when discovery has not found it: a profile naming an agent this machine
                  lacks is still the team's choice, and silently re-pointing it at another agent
                  would be worse than showing it. */}
              {agentMissing && (
                <SelectItem value={profile.agent_id} className="text-xs">
                  {profile.agent_id} (not found)
                </SelectItem>
              )}
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id} className="text-xs">
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Model</span>
          {/* Only disabled while there is genuinely nothing to show — the first probe of an agent.
              A re-probe leaves it live off the retained list, because that list cannot change and
              the user has to be able to change their mind straight away. */}
          <Select
            value={profile.model ?? ""}
            disabled={probeLoading && modelOptions.length === 0}
            onValueChange={(v) => onChange({ model: v || null }, true)}
          >
            <SelectTrigger
              size="sm"
              className="w-full text-xs"
              aria-label={`Model for ${profile.name}`}
            >
              <span className="truncate flex-1 text-left">{modelLabel}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="" className="text-xs">
                {defaultModelItemLabel}
              </SelectItem>
              {modelOptions.map((model) => (
                <SelectItem key={model.model_id} value={model.model_id} className="text-xs">
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {/* Mode ids differ per harness, so the list is the agent's own — the same probe that
            answers for the models answers for these. Every entry is a mode the agent really has:
            the role's default is one of them, already selected, rather than a synthetic "automatic"
            entry standing in for a choice nobody can see. */}
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Permission mode</span>
          <Select
            value={profile.permission_mode ?? ""}
            disabled={probeLoading || noModesToOffer}
            onValueChange={(v) => onChange({ permission_mode: v || null }, true)}
          >
            <SelectTrigger
              size="sm"
              className="w-full text-xs"
              aria-label={`Permission mode for ${profile.name}`}
            >
              <span className="truncate flex-1 text-left">{modeLabel}</span>
            </SelectTrigger>
            <SelectContent>
              {availableModes.map((mode) => (
                <SelectItem key={mode.mode_id} value={mode.mode_id} className="text-xs">
                  {mode.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {noModesToOffer && (
            <p className="text-[11px] text-muted-foreground">
              No permission mode available, the agent will use its own default.
            </p>
          )}
        </div>

        {/* Only some harnesses expose a reasoning budget, and it is not part of ACP proper — it
            arrives as one entry in the generic config-option list, which is why the probe has to
            find it rather than read a field. An agent without one leaves this disabled instead of
            hiding it, so a profile written against an agent that has it still shows what it asks
            for on a machine whose agent does not. */}
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Effort</span>
          <Select
            value={profile.effort ?? ""}
            disabled={probeLoading || noEffortToOffer}
            onValueChange={(v) => onChange({ effort: v || null }, true)}
          >
            <SelectTrigger
              size="sm"
              className="w-full text-xs"
              aria-label={`Effort for ${profile.name}`}
            >
              <span className="truncate flex-1 text-left">{effortLabel}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="" className="text-xs">
                agent default
              </SelectItem>
              {availableEfforts.map((effort) => (
                <SelectItem key={effort.value} value={effort.value} className="text-xs">
                  {effort.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Names the model, not the agent: effort is a per-model setting, and the probe now runs
              against the model this profile names, so "this agent has none" was both wrong and
              unactionable — the fix is to pick a different model. */}
          {noEffortToOffer && (
            <p className="text-[11px] text-muted-foreground">
              {profile.model
                ? `${modelName(profile.model)} exposes no effort setting.`
                : "This agent's default model exposes no effort setting."}
            </p>
          )}
        </div>
      </div>

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
