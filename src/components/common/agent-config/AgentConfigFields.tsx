import { useEffect, useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/ui/select";
import { useAgentConfigQuery, type AgentModel } from "@/services/execution.service";
import { resolveAutomaticMode } from "@/lib/permission-modes";
import type { ConnectionKey } from "@/types/bindings";

/** The four settings that say *how* an agent runs, wherever they are stored. */
export interface AgentConfigValue {
  agent_id: string;
  model?: string | null;
  permission_mode?: string | null;
  effort?: string | null;
}

/**
 * Agent, model, permission mode and effort, backed by a probe of the agent itself.
 *
 * Shared because the fields are not a form — they are a negotiation with a subprocess. The models
 * an agent offers, the modes it names and whether it exposes effort at all are only knowable by
 * asking it, the answer differs per model, and every field here clears a stored value the probe
 * does not confirm. Two copies of that would drift in ways nobody would notice until a spawn
 * silently ignored a setting.
 *
 * Owned by whoever stores the values — an agent profile in `profiles.json`, an automation in
 * `automations.json` — which is why this takes a value and a patch callback rather than either.
 */
export function AgentConfigFields({
  value,
  label,
  agents,
  projectId,
  projectPath,
  connection,
  readOnly,
  onChange,
}: {
  value: AgentConfigValue;
  /** What the aria-labels call this thing: a profile's name, or an automation's. */
  label: string;
  agents: Array<{ id: string; name: string }>;
  projectId: number;
  projectPath: string | null;
  connection: ConnectionKey;
  /** Whether the mode filled in for an empty field should be one that cannot write. */
  readOnly: boolean;
  /** `commit` persists the patch straight away; callers that batch leave it to their own save. */
  onChange: (patch: Partial<AgentConfigValue>, commit?: boolean) => void;
}) {
  const agentMissing = !!value.agent_id && !agents.some((a) => a.id === value.agent_id);
  const agentLabel = agentMissing
    ? `${value.agent_id} (not found)`
    : (agents.find((a) => a.id === value.agent_id)?.name ?? "Select an agent");

  // An agent this machine does not have cannot answer, and every field below clears what the probe
  // does not confirm — so probing one would wipe a profile written on a machine that has it. The
  // agent itself is still shown as `(not found)`, which is the honest thing to say about it.
  const probeEnabled = !!value.agent_id && !agentMissing;

  const {
    data: config,
    isLoading: probeLoading,
    isSuccess: probeAnswered,
    isError: probeFailed,
  } = useAgentConfigQuery(
    value.agent_id || null,
    projectPath,
    projectId,
    connection,
    // Effort is per-model, so the probe has to run against the model this one names rather than
    // whichever one the agent opens on.
    value.model ?? null,
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
  const [namedFor, setNamedFor] = useState(value.agent_id);
  if (namedFor !== value.agent_id) {
    setNamedFor(value.agent_id);
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
  // here that is not in question. Only the unchosen case defers to the probe, because "agent
  // default" is genuinely a name nobody knows yet.
  const modelLabel = value.model ? modelName(value.model) : defaultModelLabel;

  const automaticMode = resolveAutomaticMode(
    availableModes.map((m) => m.mode_id),
    readOnly,
  );

  // No field ever shows a value the agent did not offer. A stored value this machine cannot
  // confirm is treated the same as one it confirmed absent, because the two are indistinguishable
  // from here and the alternative — labelling it `(not offered)` — put a selection on screen that
  // the spawn then silently ignored. The cost is real and deliberate: an unreachable agent clears
  // the fields naming it.
  //
  // Each write makes its own condition false, so none of these re-fire.
  useEffect(() => {
    if (!probeSettled || !value.model) return;
    if (available.some((m) => m.model_id === value.model)) return;
    onChange({ model: null }, true);
  }, [probeSettled, value.model, available, onChange]);

  // The mode carries the fill-in case too: one that names none gets the mode it would have been
  // given as soon as the agent says what it offers, rather than leaving the spawn to resolve it
  // every time into a field that stays blank. Both cases are "replace what is stored with what
  // would be picked", which is why they are one effect.
  useEffect(() => {
    if (!probeSettled) return;
    const stored = value.permission_mode ?? null;
    if (stored && availableModes.some((m) => m.mode_id === stored)) return;
    if (stored === automaticMode) return;
    onChange({ permission_mode: automaticMode }, true);
  }, [probeSettled, value.permission_mode, availableModes, automaticMode, onChange]);

  // Nothing to fill in here, unlike the mode: an unset effort is a real answer and the common one.
  useEffect(() => {
    if (!probeSettled || !value.effort) return;
    if (availableEfforts.some((e) => e.value === value.effort)) return;
    onChange({ effort: null }, true);
  }, [probeSettled, value.effort, availableEfforts, onChange]);

  // An agent that offers no modes has nothing to pick from, and nothing stored has nothing to
  // show, so the dropdown would open onto an empty list.
  const noModesToOffer = !probeLoading && availableModes.length === 0 && !value.permission_mode;

  // Only ever the name of a real mode. The unselected states are the transient ones — the probe
  // still running, or an agent offering modes but none usable — and they say what is happening
  // rather than naming a choice that was never made.
  const modeLabel = value.permission_mode
    ? (availableModes.find((m) => m.mode_id === value.permission_mode)?.name ??
      value.permission_mode)
    : probeLoading
      ? "asking the agent…"
      : noModesToOffer
        ? "Not available"
        : "Select a permission mode";

  // Unlike the mode, an unset effort is a real and common answer — most agents have no such
  // setting, and those that do have a default of their own worth deferring to. So there is nothing
  // to fill in, and "Not available" is reserved for an agent that offers none at all.
  const noEffortToOffer = !probeLoading && availableEfforts.length === 0 && !value.effort;
  const effortLabel = value.effort
    ? (availableEfforts.find((e) => e.value === value.effort)?.name ?? value.effort)
    : probeLoading
      ? "asking the agent…"
      : noEffortToOffer
        ? "Not available"
        : "agent default";

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Agent</span>
          {/* `?? ""` because base-ui hands back null when a selection is cleared, which a native
              select could not do. An empty agent id is "not chosen yet". */}
          {/* The other three fields belong to the agent, so they go with it — in one patch, not as
              a reset the probe works out afterwards. A model id is only meaningful to the harness
              that issued it, and carrying one across meant the next probe asked the new agent to
              select a model it had never heard of, which it answers with an error the user sees. */}
          <Select
            value={value.agent_id}
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
              {/* Kept even when discovery has not found it: naming an agent this machine lacks is
                  still the team's choice, and silently re-pointing it at another agent would be
                  worse than showing it. */}
              {agentMissing && (
                <SelectItem value={value.agent_id} className="text-xs">
                  {value.agent_id} (not found)
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
            value={value.model ?? ""}
            disabled={probeLoading && modelOptions.length === 0}
            onValueChange={(v) => onChange({ model: v || null }, true)}
          >
            <SelectTrigger size="sm" className="w-full text-xs" aria-label={`Model for ${label}`}>
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
            the automatic choice is one of them, already selected, rather than a synthetic
            "automatic" entry standing in for a choice nobody can see. */}
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Permission mode</span>
          <Select
            value={value.permission_mode ?? ""}
            disabled={probeLoading || noModesToOffer}
            onValueChange={(v) => onChange({ permission_mode: v || null }, true)}
          >
            <SelectTrigger
              size="sm"
              className="w-full text-xs"
              aria-label={`Permission mode for ${label}`}
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
            hiding it, so a setting written against an agent that has it still shows what it asks
            for on a machine whose agent does not. */}
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Effort</span>
          <Select
            value={value.effort ?? ""}
            disabled={probeLoading || noEffortToOffer}
            onValueChange={(v) => onChange({ effort: v || null }, true)}
          >
            <SelectTrigger size="sm" className="w-full text-xs" aria-label={`Effort for ${label}`}>
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
          {/* Names the model, not the agent: effort is a per-model setting, and the probe runs
              against the model named here, so "this agent has none" was both wrong and
              unactionable — the fix is to pick a different model. */}
          {noEffortToOffer && (
            <p className="text-[11px] text-muted-foreground">
              {value.model
                ? `${modelName(value.model)} exposes no effort setting.`
                : "This agent's default model exposes no effort setting."}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
