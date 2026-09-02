import { useEffect } from "react";
import { useNavigationActions } from "@/store/navigationStore";

/// Per project, per machine. `localStorage` rather than `.maestro/settings.json` because "has this
/// person seen the agent settings" is a fact about a person, not about a repository — recording it
/// in the project's shared file would suppress the introduction for the next teammate who opens it.
function seenKey(projectId: number): string {
  return `project:${projectId}:agentsIntroShown`;
}

interface IntroDecision {
  /** True to send the user to Settings → Agents. */
  show: boolean;
  /** True to record that they have now seen it, whether or not it was shown. */
  remember: boolean;
}

/**
 * Whether a newly opened project should land on its agent settings.
 *
 * Pure, so the precedence rules can be tested without a store. Two of them are load-bearing:
 *
 * - A project with an explicit `startup_tab` has been configured by someone, so it is neither new
 *   nor in need of an introduction, and the user's stated preference outranks ours. It is still
 *   recorded as seen, so turning the startup tab off later does not spring this on them.
 * - Nothing is decided until the settings query has resolved, because `undefined` there is "not
 *   yet known" and would be read as "no startup tab" one render too early.
 */
export function resolveAgentIntro(
  projectId: number | null,
  startupTab: string | null | undefined,
  settingsResolved: boolean,
  alreadySeen: boolean,
): IntroDecision {
  if (projectId == null || !settingsResolved || alreadySeen)
    return { show: false, remember: false };
  if (startupTab) return { show: false, remember: true };
  return { show: true, remember: true };
}

/**
 * Sends a project's first open to Settings → Agents.
 *
 * A new project's board looks ready and is not: until an agent is chosen, Execute fails. The
 * default is now filled in automatically (`useDefaultAgentFallback`), so this is no longer a
 * blocking step — it is where the user finds out that an agent was picked for them, that they can
 * change it, and that each stage of a task can have its own.
 *
 * Once per project per machine. Not once per install: someone who has used Maestro for a year
 * still has not seen *this* project's agents, and the page is where its pipeline is configured.
 */
export function useProjectAgentIntro(
  projectId: number | null,
  startupTab: string | null | undefined,
  settingsResolved: boolean,
) {
  const { setActiveTab, setPendingSettingsPage } = useNavigationActions();

  useEffect(() => {
    if (projectId == null) return;

    const key = seenKey(projectId);
    const decision = resolveAgentIntro(
      projectId,
      startupTab,
      settingsResolved,
      localStorage.getItem(key) != null,
    );
    if (!decision.remember) return;

    localStorage.setItem(key, "1");
    if (!decision.show) return;

    setActiveTab("settings");
    setPendingSettingsPage("agents");
  }, [projectId, startupTab, settingsResolved, setActiveTab, setPendingSettingsPage]);
}
