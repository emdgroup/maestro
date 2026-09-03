import type { AgentRole } from "@/types/bindings";

/// Modes that let an agent write, and the read-only ones for the three roles that must not. Used
/// only when no profile names a mode.
///
/// A fallback list, not a ladder: harnesses disagree about what these are called, so this is read
/// in order and the first one *this* agent advertises wins. Every name past the first exists
/// because some harness uses it and no other — the list is expected to grow as harnesses are tried,
/// which is why the resolved mode is logged.
///
/// `acceptEdits` is deliberately absent. It silences prompts for edits but still asks before
/// running a command, and a task in this pipeline is meant to run without a person: stopping on
/// every test run is the failure mode, not a safeguard. `bypassPermissions` is last for the
/// opposite reason — it is the right answer only when a harness offers nothing better.
const WRITABLE_MODES = ["auto", "agent", "build", "full-access", "bypassPermissions"];
const READ_ONLY_MODES = ["readonly", "plan"];

/// The three roles that exist because they do not write. Only the coder implements.
export function isReadOnlyRole(role: AgentRole): boolean {
  return role !== "Coder";
}

/// The mode every harness that has one calls its default: writes become a permission prompt
/// rather than being allowed or refused outright.
const DEFAULT_MODE = "default";

/**
 * The mode a profile that names none should run in, given what its agent offers.
 *
 * Shared by the spawn path and the Settings dropdown on purpose: the mode a profile is preselected
 * with is only worth showing if it is the same code that would otherwise pick it at spawn. Two
 * copies of the preference order would drift, and the drift would be silent.
 *
 * Falls back to `default` when nothing in the role's list is offered — the one mode that is a
 * reasonable answer for either kind of role, since it neither hands over write access nor refuses
 * the role its tools, it just asks. `null` means the agent offered nothing to choose from.
 */
export function resolveAutomaticMode(modeIds: string[], readOnly: boolean): string | null {
  const priorities = readOnly ? READ_ONLY_MODES : WRITABLE_MODES;
  return (
    priorities.find((mode) => modeIds.includes(mode)) ??
    modeIds.find((mode) => mode === DEFAULT_MODE) ??
    null
  );
}
