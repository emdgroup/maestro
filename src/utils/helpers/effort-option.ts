import type { ConfigOption } from "@/components/execution/activity/types";

/**
 * The ACP config-option categories that mean "how hard should the model think about this".
 *
 * Two names for one idea: harnesses that expose a reasoning budget call it either, and the compose
 * bar already renders both through the same slider. Matched on the category rather than the id,
 * because the id is the agent's own and is what has to be sent back to set the value.
 */
const EFFORT_CATEGORIES = ["effort", "thought_level"];

/**
 * The effort setting among an agent's config options, or `null` when it exposes none.
 *
 * Shared by the Settings probe and the spawn path on purpose: the list a profile is chosen from has
 * to be the list the spawn will honour, and the option's `id` is the only thing
 * `set_acp_config_option` can address it by.
 */
export function findEffortOption(configOptions: ConfigOption[]): ConfigOption | null {
  return configOptions.find((o) => o.category && EFFORT_CATEGORIES.includes(o.category)) ?? null;
}
