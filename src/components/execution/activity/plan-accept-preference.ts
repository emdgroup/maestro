import type { PermissionOption } from "./permission-prompt-utils";

/**
 * The accept the plan card offers first, remembered per model.
 *
 * Per model because the option set is the model's: Claude Code sends `default`/`acceptEdits`/
 * `bypassPermissions`, another harness sends its own ids, and one global preference would mean a
 * model inheriting a default it never offers. Per machine rather than per project, in
 * `localStorage` — this is "how I like to approve", not something a checkout should carry.
 */
const KEY_PREFIX = "plan:acceptOption:";

/** An agent that reports no models still gets a remembered choice, under one shared key. */
const NO_MODEL = "<none>";

function key(modelId: string | null): string {
  return `${KEY_PREFIX}${modelId || NO_MODEL}`;
}

// Storage can throw (private mode, disabled cookies). A remembered button is never worth taking
// the plan card down for.
export function readLastAccept(modelId: string | null): string | null {
  try {
    return localStorage.getItem(key(modelId));
  } catch {
    return null;
  }
}

export function writeLastAccept(modelId: string | null, optionId: string) {
  try {
    localStorage.setItem(key(modelId), optionId);
  } catch {
    /* preference is best-effort */
  }
}

/**
 * The option the primary button answers with: the one last used for this model, or the agent's
 * own first choice when nothing is stored or the stored id is not on offer this time — which is
 * what happens when the agent changes its option set, or the model changed since.
 */
export function pickDefaultAccept(
  acceptOptions: PermissionOption[],
  lastAcceptId: string | null,
): PermissionOption | null {
  if (lastAcceptId) {
    const remembered = acceptOptions.find((o) => o.optionId === lastAcceptId);
    if (remembered) return remembered;
  }
  return acceptOptions[0] ?? null;
}
