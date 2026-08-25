import { useState, forwardRef, useImperativeHandle } from "react";
import { Bot, Plus, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { useAgentProfilesQuery, useSaveAgentProfilesMutation } from "@/services/project.service";
import type { AgentProfile, AgentRole, ProfilesDocument } from "@/types/bindings";
import { cn } from "@/lib/utils";

/// The four roles, in the order a task passes through them.
///
/// Each line says what the role costs the user rather than what it is called: a project with no
/// profile for a role simply skips that stage, and "no Reviewer" being the difference between a
/// task stopping at your gate and going straight to it is not obvious from the word "Reviewer".
const ROLES: Array<{ role: AgentRole; title: string; blurb: string }> = [
  {
    role: "Refiner",
    title: "Refinement",
    blurb:
      "Sharpens a task's description before anyone implements it. Without one, Planning has no Refine.",
  },
  {
    role: "Planner",
    title: "Planning",
    blurb:
      "Writes a plan and stops at a gate for you. Without one, work starts straight from the description.",
  },
  {
    role: "Coder",
    title: "Implementation",
    blurb: "The only role allowed to write. Without one, nothing runs.",
  },
  {
    role: "Reviewer",
    title: "Review",
    blurb:
      "Reviews the diff and can send it back. Without one, finished work waits for you instead.",
  },
];

export interface AgentProfilesSectionHandle {
  save: () => Promise<void>;
}

interface AgentProfilesSectionProps {
  projectId: number;
  agents: Array<{ id: string; name: string }>;
}

/// A profile id the user never has to see or type.
///
/// The id is what a task's override stores and what `defaults` points at, so it has to be stable
/// and unique — but asking for one would be asking about a foreign key. Derived from the role and
/// a timestamp rather than the name, because renaming a profile must not orphan the tasks pointing
/// at it.
function newProfileId(role: AgentRole): string {
  return `${role.toLowerCase()}-${Date.now().toString(36)}`;
}

export const AgentProfilesSection = forwardRef<
  AgentProfilesSectionHandle,
  AgentProfilesSectionProps
>(({ projectId, agents }, ref) => {
  const profilesQuery = useAgentProfilesQuery(projectId);
  const saveProfiles = useSaveAgentProfilesMutation();

  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string>>({});

  // Adopted from the query during render rather than from an effect, which would paint an empty
  // list over profiles already fetched. Latched on the object identity so the user's edits are not
  // overwritten by a refetch that returned the same document.
  const stored = profilesQuery.data ?? null;
  const [loaded, setLoaded] = useState<ProfilesDocument | null>(null);
  if (stored && loaded !== stored) {
    setLoaded(stored);
    // Both are `#[serde(default)]` on the Rust side, so a `profiles.json` that omits either — or
    // has never been written at all — arrives with them undefined rather than empty.
    setProfiles(stored.profiles ?? []);
    setDefaults(
      Object.fromEntries(
        Object.entries(stored.defaults ?? {}).filter(
          (entry): entry is [string, string] => entry[1] != null,
        ),
      ),
    );
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

  useImperativeHandle(ref, () => ({
    save: async () => {
      await saveProfiles.mutateAsync({
        projectId,
        document: { profiles, defaults },
      });
    },
  }));

  function updateProfile(id: string, patch: Partial<AgentProfile>) {
    setProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function addProfile(role: AgentRole) {
    const id = newProfileId(role);
    setProfiles((prev) => [
      ...prev,
      {
        id,
        name: `${role} profile`,
        role,
        agent_id: agents[0]?.id ?? "",
        skills: [],
        mcp_servers: [],
        fallback_behaviour: "Warn",
      },
    ]);
    // The first profile for a role becomes its default, because a role with profiles and no
    // default resolves to "the first one declaring the role" anyway — better to say so.
    setDefaults((prev) => (prev[role] ? prev : { ...prev, [role]: id }));
  }

  function removeProfile(id: string, role: AgentRole) {
    const remaining = profiles.filter((p) => p.id !== id);
    setProfiles(remaining);
    setDefaults((prev) => {
      if (prev[role] !== id) return prev;
      const next = { ...prev };
      const fallback = remaining.find((p) => p.role === role);
      if (fallback) next[role] = fallback.id;
      else delete next[role];
      return next;
    });
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
          same pipeline. A role with no profile is skipped.
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
                No profile — stage skipped.
              </p>
            ) : (
              forRole.map((profile) => {
                const isDefault = defaults[role] === profile.id;
                return (
                  <div
                    key={profile.id}
                    className={cn(
                      "rounded-md border p-3 space-y-2",
                      isDefault ? "border-accent/60 bg-accent/5" : "border-border",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {/* Radio rather than a toggle: exactly one profile per role is the default,
                          and a toggle would let the user turn the last one off. */}
                      <input
                        type="radio"
                        name={`default-${role}`}
                        checked={isDefault}
                        onChange={() => setDefaults((prev) => ({ ...prev, [role]: profile.id }))}
                        aria-label={`Use ${profile.name} by default for ${title}`}
                        className="accent-accent"
                      />
                      <Input
                        value={profile.name}
                        onChange={(e) => updateProfile(profile.id, { name: e.target.value })}
                        placeholder="Name"
                        className="h-7 text-xs"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeProfile(profile.id, role)}
                        aria-label={`Remove ${profile.name}`}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-[11px] text-muted-foreground space-y-1">
                        Agent
                        <select
                          value={profile.agent_id}
                          onChange={(e) => updateProfile(profile.id, { agent_id: e.target.value })}
                          className="w-full h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                        >
                          {/* Kept even when discovery has not found it: a profile naming an agent
                              this machine lacks is still the team's choice, and silently
                              re-pointing it at another agent would be worse than showing it. */}
                          {!agents.some((a) => a.id === profile.agent_id) && profile.agent_id && (
                            <option value={profile.agent_id}>{profile.agent_id} (not found)</option>
                          )}
                          {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-[11px] text-muted-foreground space-y-1">
                        Model
                        <Input
                          value={profile.model ?? ""}
                          onChange={(e) =>
                            updateProfile(profile.id, { model: e.target.value || null })
                          }
                          placeholder="agent default"
                          className="h-7 text-xs"
                        />
                      </label>
                    </div>

                    {/* Free text because mode ids differ per harness and the set is not known
                        until the agent is running. Left empty, Maestro picks the first mode the
                        agent offers from its own list — read-only for the three roles that must
                        not write, autonomous for the coder — which is what makes the workflow run
                        without a person. Naming one here overrides that. */}
                    <label className="text-[11px] text-muted-foreground space-y-1 block">
                      Permission mode
                      <Input
                        value={profile.permission_mode ?? ""}
                        onChange={(e) =>
                          updateProfile(profile.id, { permission_mode: e.target.value || null })
                        }
                        placeholder={
                          role === "Coder"
                            ? "chosen automatically"
                            : "read-only, chosen automatically"
                        }
                        className="h-7 text-xs"
                      />
                    </label>

                    <label className="text-[11px] text-muted-foreground space-y-1 block">
                      Instructions for this role
                      <Textarea
                        value={profile.role_prompt ?? ""}
                        onChange={(e) =>
                          updateProfile(profile.id, { role_prompt: e.target.value || null })
                        }
                        placeholder="What this role means in this project. Sent ahead of the task."
                        className="min-h-16 text-xs"
                      />
                    </label>
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
});

AgentProfilesSection.displayName = "AgentProfilesSection";
