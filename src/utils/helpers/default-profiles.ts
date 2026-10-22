import type { AgentProfile, AgentRole, ProfilesDocument } from "@/types/bindings";

/** Each role's stage as a verb, as the workflow row in Settings and a session's chip name it. */
export const STAGE_NAMES: Record<AgentRole, string> = {
  Refiner: "Refine",
  Planner: "Plan",
  Coder: "Implement",
  Reviewer: "Review",
  Preparer: "Prepare",
  Worker: "Build",
  Judge: "Judge",
};

/** Each role's stage, as Settings titles its panel and a task's Agents dialog labels its row. */
export const STAGE_TITLES: Record<AgentRole, string> = {
  Refiner: "Refinement",
  Planner: "Planning",
  Coder: "Implementation",
  Reviewer: "Review",
  Preparer: "Preparation",
  Worker: "Building",
  Judge: "Judging",
};

/**
 * The text a new profile of each role starts with.
 *
 * Copied into the profile on creation rather than applied as a fallback at resolution time,
 * because the user has to be able to read it, edit it and delete it, none of which is true of a
 * prompt that only exists as a hidden default. The cost of that choice is that editing the text
 * here does not reach profiles already written, which is the right way round. Deliberately
 * project-neutral, since the project-specific half is what the user adds.
 */
export const ROLE_PROMPTS: Record<AgentRole, string> = {
  Refiner:
    "Sharpen this task's description so it can be implemented without coming back to ask what it " +
    "meant. Read enough of the codebase to ground it: name the files and functions involved, say " +
    "what done looks like, and say what is out of scope. Where the task is genuinely ambiguous, " +
    "write the ambiguity down rather than resolving it silently. Do not change any code.",
  Planner:
    "Produce a plan for this task, not an implementation. Read the code paths it touches first, " +
    "then give ordered steps naming the file and function each one changes. Call out the risky " +
    "parts and anything you had to assume, and say how the result will be verified. Do not " +
    "change any code.",
  Coder:
    "Implement this task. Follow the conventions of the surrounding code rather than introducing " +
    "your own, and keep the change to what was asked, with no speculative extras. Verify before " +
    "you finish by running the project's tests, lint and build, and report plainly what passed, " +
    "what failed, and anything you left undone.",
  Reviewer:
    "Review this diff against the task it claims to implement. Look for correctness bugs, " +
    "unhandled cases, and changes that go beyond the task; judge style against the project's own " +
    "conventions, not your preferences. Report findings with a file and line and a concrete " +
    "failure case. Send the work back only for problems worth another run.",
  Preparer:
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
  Worker:
    "Move this loop toward its goal in this iteration. Start from the failing checks and the " +
    "notes earlier iterations left, then make the smallest change that gets a failing check " +
    "closer to passing. Follow the conventions of the surrounding code. Never edit a test or a " +
    "check script to make it pass. Run the checks before you finish, and leave a short note on " +
    "what you changed and what the next iteration should try.",
  Judge:
    "Judge each check against the loop's diff and the code it touches, as a reviewer who has to " +
    "sign it off. Pass a check only when the work plainly meets it; when you fail one, say what " +
    "is missing and where, because that reason is all the next iteration gets.",
};

/**
 * What a project with no `profiles.json` starts with: one profile per role, each on `agentId`
 * with its role's prompt, and each its role's default.
 */
export function starterProfiles(agentId: string): ProfilesDocument {
  const roles = Object.keys(STAGE_TITLES) as AgentRole[];
  const profiles: AgentProfile[] = roles.map((role) => ({
    id: role.toLowerCase(),
    name: STAGE_TITLES[role],
    role,
    agent_id: agentId,
    skills: [],
    mcp_servers: [],
    role_prompt: ROLE_PROMPTS[role],
    fallback_behaviour: "Warn",
  }));
  return {
    profiles,
    defaults: Object.fromEntries(profiles.map((p) => [p.role, p.id])),
  };
}
