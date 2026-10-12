# Loops: tasks that iterate until their checks pass

Working plan for the Loop run mode. Written to be updated in place, like `automations-plan.md`: each
phase records the decisions that are locked, so a later session does not re-litigate them.

**Nothing in this plan ships in a release until the last phase is done.** Intermediate phases land on
`main` but are not part of a release build.

**Before starting any phase, ask as many questions as needed to eliminate doubt.** Questions come
first, implementation second, one phase at a time with review in between.

The design was drafted on the Maestro canvas `loops-app` (session-195, September to October 2026).
The mock is the reference for visuals; this file is the reference for behaviour.

## Where it is going

A task gets a second way of running. The **pipeline** is what exists today: plan, implement, self
review, the user's approval, a pull request. A **loop** gives the coder a goal and a checklist, and
runs it in fresh sessions, one iteration after another, until every check passes or a budget runs
out. The agent never decides it is done. The checks do.

```
            ┌──────────────────────── next iteration (fresh session) ───────────────────────┐
            ▼                                                                               │
  Queue ─▶ Iterating ─▶ commit ─▶ Checking ─┬─ a command check fails, budget left ───────────┤
            │                               ├─ every command passes ─▶ Judging ─┬─ fails ───┘
            │ usage limit                   │                                   └─ passes ─▶ Review
            ▼                               ├─ N iterations with no change ─▶ stalled (you)
         gate closed until reset ───────────┘   budget spent ─▶ stopped (you)
                                                                     Review: digest, your checks,
                                                                     approval, pull request, merge
```

A loop is a **task**, not a new kind of object. It lives on the Tasks board, in the same five
columns, under the same capacity limit, the same Needs me filter, the same review sheet and the same
merge flow. What differs is how it runs while it is In Progress.

## Loop engineering, concept by concept

Checked against Addy Osmani's "Loop engineering" and the patterns it names. Every row is either built
by a phase below, already in Maestro, or left out on purpose.

| Concept                                        | Where it lives                                                                                          | Phase     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------- |
| `/goal`: stop when a written condition is true | "Done when" checklist, run by the daemon after every iteration                                          | 1         |
| Separate maker and checker                     | `judge` checks run by a separate agent session, optionally another agent                                | 2         |
| The worker never grades itself                 | The agent can only _claim_ a check, which runs it. Nothing it says passes one                           | 1, 5      |
| Memory on disk, not in context                 | Loop notes stored by the daemon and put in every prompt, plus one commit per iteration                  | 1         |
| Fresh context per iteration                    | One new ACP session per iteration, the same mechanism the pipeline's stages use                         | 1         |
| Verifier output feeds the next turn            | The failing checks' output, cut to its last 200 lines, is in the next prompt                            | 1         |
| Worktrees                                      | One worktree per loop task, kept across iterations (already true of every task)                         | exists    |
| Skills (write intent once)                     | Sessions get the connection's skills; the loop view lists them read-only                                | exists, 4 |
| Plugins and connectors (MCP)                   | Managed MCP servers are injected into every session, loop sessions included                             | exists    |
| `/loop`: re-run on a cadence                   | Automations. Not part of this plan                                                                      | exists    |
| Automations feed a triage inbox                | An automation's agent creates a draft loop task in Planning                                             | 5         |
| Budgets                                        | Iterations, agent time, stall limit. Tokens are shown per iteration, not budgeted                       | 1         |
| Stall detection                                | N iterations in a row whose commit is empty stop the loop                                               | 1         |
| Regressions                                    | Every command check re-runs after every iteration, passed or not                                        | 1         |
| Usage limits without polluting context         | The daemon reads the reset time from the refused reply and waits; the next session never sees the error | 3         |
| Comprehension debt                             | Review digest written by the judge: what changed, what it decided alone, what deserves a look           | 2         |
| Cognitive surrender                            | Manual checks, the digest, the existing review sheet and approval gate. Nothing forces reading          | 2         |
| Orchestration tax ("you are the ceiling")      | A cap on loops waiting on the user; past it, new loops queue                                            | 5         |
| Token cost vigilance                           | Tokens per iteration from `usage_turns`. No cost budget, by decision                                    | 4         |
| Human escape hatch                             | Pause, Stop, Try now, Send back with a note, Answer and resume                                          | 2, 4      |
| Observability                                  | Iteration list, check output, per-iteration session reopenable, outcome thread                          | 4         |
| Tool abstraction                               | Any ACP agent can run a loop. Only the reset-time reading is Claude-specific; others back off           | 3         |
| Sub-agents to ideate                           | Left out: planner and executor loops are not in scope                                                   | none      |

### What the article does not name, and this plan still has to decide

These came out of reading the pipeline code rather than the article. Each is an **open question**
below, with a recommendation.

- **Gaming the checks.** A check that runs `bun run test` passes when the agent deletes the failing
  test, or edits the script a check calls. Nothing in the article covers it.
- **Check timeouts and flaky checks.** A hanging command stalls the loop forever; a flaky one buys
  iterations that fix nothing.
- **Steering mid-run.** Send back exists at sign-off, but there is no way to add a hint while a loop
  is iterating, short of joining the session.
- **Where the notes live.** The mock shows `.maestro/loop/PROGRESS.md` in the worktree. Written there,
  it is committed with every iteration and lands in the pull request.

## Decisions that span every phase

Locked while drafting. Do not reopen without the user.

- **A loop is a task with `run_mode = Loop`.** It is created from New Task ("How it runs: Pipeline |
  Loop"), from an existing Planning task ("Make it a loop"), or by an agent through MCP. There is no
  Loops tab.
- **One fresh session per iteration.** Memory is the loop notes and the git history, never a
  continued conversation.
- **Done criteria are a checklist.** Each check is one of:
  - `command`: a shell command run in the worktree. Exit 0 passes.
  - `judge`: a sentence a separate agent judges against the diff, answering pass or fail with a
    reason.
  - `manual`: the user ticks it.
- **Every check is required.** There is no advisory flag. Soft concerns go in the digest under
  "Worth a look".
- **Regressions are caught.**
  - `command` checks all re-run after every iteration.
  - A `judge` check re-runs when the diff has changed since it last passed, and once more before the
    loop finishes.
  - `manual` checks are ticked at the end, and any later change clears them.
- **The agent proposes, the user disposes.**
  - A check the agent proposes appears as proposed. Accepting it makes it a full check whose kind the
    user picks.
  - An unanswered proposal does not hold iterations back, but it holds the loop at sign-off.
- **Success goes through the existing Review.**
  - When every automatic check passes, the judge writes the review digest. The task moves to Review,
    to the Approval gate, with the manual checks still to tick.
  - Approval, the pull request, CI polling and merging are the pipeline's own. The forge token stays
    in the app, as it does today.
- **The daemon owns the loop.** It runs with every window closed, survives a restart through the
  existing startup pass, and is driven by the existing scheduler.
- **No cost budget.** Iterations, agent time and the stall limit are the budget. Tokens are reported
  per iteration.
- **Waiting is free.** Time spent waiting for a usage limit to reset is not agent time, and an
  iteration a limit cut off runs again without counting.

## What exists, and what each phase reuses

From a survey of the pipeline (`maestro-server/AGENTS.md`, "The daemon drives the task pipeline").

| Need                                    | Already there                                                                          | File                           |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| Fresh session per stage, old one closed | `task_runner::run` always issues `session/new`; `adopt` cancels the superseded session | `task_runner.rs`               |
| Worktree kept across stages             | `prepare_task_workspace` reuses the worktree the task owns                             | `worktree.rs`                  |
| Turn end routed to the task             | Main loop `TurnEnd` arm, then `task_turn::spawn` and `resolve`                         | `main.rs`, `task_turn.rs`      |
| Next stage started by one driver        | `next_stage` (Waiting + ball Agent) and the scheduler's debounced drain                | `task_turn.rs`, `scheduler.rs` |
| Guarded transitions                     | `transition::resolve` and `TransitionGuard`, one request each                          | `task_store/transition.rs`     |
| Per-stage prompt from comments          | `task_prompt::compose`, keyed on the prior phase and `latest_of_kind`                  | `task_prompt.rs`               |
| Coder prompts answered unattended       | `task_gate::decide` allows a coder in a writing phase                                  | `session/task_gate.rs`         |
| Restart recovery                        | `task_restart` reloads a mid-turn session and resumes it                               | `task_restart.rs`              |
| Tokens per turn                         | `usage_turns` rows written at every `TurnEnd`                                          | `usage_store.rs`               |
| A bounded loop today                    | The coder and reviewer rounds, capped by `REVIEW_ROUND_CAP`                            | `task_store.rs`, `turn.rs`     |
| Approval, PR, merge                     | `approve_task_and_merge`, `open_pull_request_for_task`                                 | `src-tauri/src/git/merge.rs`   |

Gaps the survey found, which the phases below close:

- **Nothing in the daemon reads `_claude/rateLimit`.** A refused prompt reaches `TurnEnd` as the word
  `"error"`, with the reason only in a diagnostic.
- **Nothing in the daemon commits.** Commits happen in the app at approval.
- **No per-project or per-task check command exists anywhere.**
- **The superseded-session guard compares roles only.** A stale coder session that ends a turn during
  the next coder iteration would be read as the new iteration's turn end.
- **`tools/list` is the same for every session.** There is no per-session tool filtering.
- **The pull request body is the task description verbatim.**
- **The task's `skills`, `mcp_allowlist` and `skills_override` columns are applied by nothing.** This
  is out of scope here, noted so nobody assumes otherwise.

## Phase status

| Phase | What                                                | State       |
| ----- | --------------------------------------------------- | ----------- |
| 0     | Data model and protocol                             | Not started |
| 1     | The iteration engine in the daemon                  | Not started |
| 2     | Judge, digest, proposals, sign-off, pull request    | Not started |
| 3     | Usage-limit gate                                    | Not started |
| 4     | The board: create, card, loop view                  | Not started |
| 5     | MCP tools, drafts from automations, the waiting cap | Not started |
| 6     | Docs                                                | Not started |

Phases 0 to 2 are the engine and can be exercised through MCP and tests before any UI exists. Phase 3
is independent of 2 and can go in either order. Phase 4 needs 0 to 2.

## Phase 0: data model and protocol

`projects.db` gains one migration, a new frozen literal appended to `project_store::MIGRATIONS` the
way V8 added `claimed_from`.

**`tasks` columns:**

| Column        | Type                       | Meaning                                                                                   |
| ------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `run_mode`    | TEXT, default `'Pipeline'` | `Pipeline` or `Loop`                                                                      |
| `loop_config` | TEXT, JSON                 | `max_iterations`, `max_agent_secs`, `stall_limit`, `judge_agent_id`, `check_timeout_secs` |
| `loop_notes`  | TEXT                       | The agent's notes, carried from one iteration to the next                                 |

**New tables**, keyed by `(project_path, task_id, …)` like every task table:

- `loop_checks`: `id`, `position`, `kind` (`command`/`judge`/`manual`), `label`, `command`, `state`
  (`pending`/`pass`/`fail`), `detail` (last output tail or judge reason), `proposed` (bool),
  `accepted` (bool), `passed_at_sha` (the commit a judge last passed on), `updated_at`.
- `loop_iterations`: `n`, `attempt`, `acp_session_id`, `agent_id`, `started_at`, `ended_at`,
  `outcome` (`running`/`checked`/`interrupted`/`empty`/`failed`), `counted` (bool), `commit_sha`,
  `files`, `added`, `removed`, `summary` (the agent's final message), `check_output` (tail).
- `agent_gates` (daemon-wide, not per project): `agent_id`, `resume_at`, `reason`, `backoff_step`.

**Phases.** New `TaskPhase` variants, so the compiler forces every label and every `match`:

| Phase       | Session                           | Writes | Handoff when                              |
| ----------- | --------------------------------- | ------ | ----------------------------------------- |
| `Iterating` | Coder, fresh per iteration        | yes    | `Waiting` + ball `Agent` (next iteration) |
| `Checking`  | none, the daemon runs commands    | no     | n/a, runs inside the turn end             |
| `Judging`   | new `AgentRole::Judge`, read-only | no     | `Waiting` + ball `Agent`                  |

The existing `Approval` and `AwaitingMerge` are reused unchanged for sign-off and the pull request.

**Protocol.** `Task` gains `run_mode`, `loop_config`, `loop_notes`. New requests: `ListLoopChecks`,
`SetLoopChecks` (whole list, from the editor), `AnswerLoopProposal`, `TickLoopCheck`,
`ListLoopIterations`. `CreateTaskRequest` and `TaskUpdate` gain the loop fields. `PROTOCOL_VERSION`
bumps once for the whole plan, in this phase.

### Decisions (locked)

- One migration for the whole feature. It may be rewritten until it ships, per the rule in
  `src-tauri/AGENTS.md`.
- A loop task's checks are rows, not JSON in `loop_config`. Their state changes every iteration, and
  each one is read, ticked and answered individually.

## Phase 1: the iteration engine

**Starting an iteration.** The scheduler's drain already claims Queue candidates and `Waiting` +
`Agent` handoffs. For a loop task:

- `next_stage` returns `Coder` for `Iterating` and `Judge` for `Judging`.
- `SessionReady(Coder)` lands on `Iterating` instead of `Implementing` when `run_mode = Loop`.
- `task_prompt::compose` gets a loop branch for the coder, built from:
  - the goal (the task description),
  - the iteration number and the budget left,
  - the failing checks with their output tails,
  - the loop notes,
  - any steering notes (see the open questions),
  - the loop protocol: "make progress, update your notes with `loop_note`, claim a check with
    `loop_claim_check` when you believe it passes, call `loop_blocked` if you cannot proceed. Do not
    declare the loop done."
- The session's `ProjectBinding` meta carries the **iteration number**. `task_turn::resolve` ignores
  a turn end from any other iteration, which closes the stale-session gap.

**Ending an iteration**, in `task_turn::resolve`, when `run_mode = Loop`:

1. **Classify.** Interrupted by a usage limit (phase 3)? Ended by the user? Failed? An agent error
   that is not a limit fails the iteration. Three failed iterations in a row stop the loop.
2. **Commit.** `git add -A` then `git commit -m "loop: iteration n"` in the worktree, with
   `--allow-empty` off. An empty diff makes the iteration `empty`.
3. **Check.** The phase becomes `Checking`. The daemon runs every `command` check in the worktree:
   - Each runs with a timeout from `check_timeout_secs` (default 10 minutes), killed past it.
   - Commands run one at a time, in list order.
   - Each keeps its exit code and the last 200 lines of combined output.

   This runs off the main loop, as `launch` does: it is a process, and the loop's stack is 1 MB in a
   Windows debug build.

4. **Decide.**
   - Every command check passes, and judge checks remain: hand off to `Judging`.
   - Everything automatic passes: go to sign-off (phase 2).
   - The stall counter reaches `stall_limit`: stop with "stalled", ball User.
   - The budget is spent: stop with "budget", ball User.
   - Otherwise: `Iterating` + `Waiting` + `Agent`, and the drain starts the next iteration.
5. **Record.** Write the `loop_iterations` row, with tokens from that turn's `usage_turns` row and the
   agent's final message as `summary`. File a short outcome comment on the thread.

**Budgets.** `max_iterations` counts iterations with `counted = true`. Agent time is the sum of
counted iterations' `ended_at - started_at`. Both are checked before a handoff is written, never
mid-turn.

**Restart.** `task_restart` learns three loop states:

- `Iterating` mid-turn resumes like any coder.
- `Checking` re-runs the checks, since the process died with the daemon.
- `Judging` is restarted fresh: a judge is cheap and holds nothing.

**Capacity.** An iteration takes a slot like any coder session. A loop in `Checking` holds none,
since no session is live.

### Decisions (locked)

- The daemon commits each iteration. This is the first commit the daemon makes. The pipeline's own
  approval commit in the app still runs, and finds nothing left to stage.
- Checks run on the daemon's machine, in the worktree, with the user's shell: `sh -c` on Unix,
  `cmd /C` on Windows. They are the user's commands, run with the user's permissions, like the agent
  itself.

## Phase 2: judge, digest, proposals, sign-off, pull request

- **`AgentRole::Judge`.** Read-only, like the reviewer. Its prompt is the goal, the diff against the
  base, and the judge checks to decide. It answers per check `PASS` or `FAIL` with one line of reason,
  parsed like `classify_verdict`. The agent comes from `loop_config.judge_agent_id`, else the worker's.
- **Re-judging.** A judge check whose `passed_at_sha` is the current commit is skipped. One final judge
  pass always runs before sign-off.
- **Digest.** On the last judge pass, the prompt also asks for the digest in three sections: what
  changed, what the loop decided on its own, what deserves a look. It is filed as comment kind
  `digest`.
- **Sign-off** is the existing `Approval` gate (Review, Waiting, User). The approve action is refused
  while a `manual` check is unticked or a proposal is unanswered. A tick is cleared by any later
  commit.
- **Send back.** A note becomes a `steer` comment, and the task returns to `Iterating` + `Waiting` +
  `Agent`. It goes through a new `TaskTransition::LoopResumed`.
- **Pull request.** `open_pull_request_for_task` uses the `digest` comment as the body when the task
  is a loop, with the checklist and the iteration count appended. Otherwise it uses the description,
  as today.

### Decisions (locked)

- The judge decides `judge` checks only. It never re-runs commands.
- Proposed checks follow the rule in "Decisions that span every phase".

## Phase 3: usage-limit gate

- **Read the limit where it arrives.** `usage_store::note_update` (or `turn::note_update`) reads
  `_meta["_claude/rateLimit"]` from `usage_update`. On `status: "rejected"` it records `resetsAt` and
  the window against the session. `TurnEnd` carries it as a new `TurnFacts.limit`.
- **Close the gate.** A turn that ends with a limit recorded writes `agent_gates(agent_id,
resume_at)`. With no reset time, the gate backs off 5, 15, 30, then 60 minutes, capped at 2 hours.
- **Hold the work.** The scheduler skips candidates and handoffs whose agent's gate is closed, and
  reopens them on its one-minute tick once `resume_at` passes.
- **Retry the iteration.** A loop iteration cut off by a limit is committed as WIP, marked
  `interrupted` and not counted, and the same iteration number runs again once the gate opens.
- **No probe session.** The reset time is known, so the next real iteration is the probe. If it is
  refused again, the gate closes again. This drops the "reply ok" probe from the draft.
- **Try now** clears the gate for that agent.

### Decisions (locked)

- The gate is per agent and per daemon, because the limit belongs to the account the agent runs as,
  as `planLimitsKey` already treats it in the app.
- Reading the reset time is Claude-specific, since only `claude-agent-acp` reports it. Every other
  agent gets the backoff.

## Phase 4: the board

Visuals are the canvas mock `loops-app`.

- **Create Task** gets "How it runs: Pipeline | Loop". Loop shows:
  - Done when: rows of command, judge and manual checks.
  - Iterations, agent time, stall limit, judge.
  - A read-only line of the skills and MCP servers the agent gets.

  A Planning pipeline task's detail offers **Make it a loop**.

- **Card.** A `LOOP` badge, and a phase line per loop state:
  - `ITERATION 6/12` with the last note.
  - `5-HOUR LIMIT · resumes 15:00`, with a dashed amber border.
  - `STALLED, NEEDS YOUR ANSWER`, with the blocked glow.
  - `NEEDS YOUR CHECK`.
  - `QUEUED · 2 loops already wait on you`.
  - `DRAFT · from <automation> #n`.

  The check bar sits under the phase line.

- **Detail modal**, with Loop as the first tab:
  - Banner per state, and the three meters (iterations, agent time, no-change streak).
  - The digest.
  - Done when, with Accept and Reject on proposals and Mark done on manual checks.
  - The iteration list (files, lines, tokens, checks passed), with Join on the running one.
  - The live column with the last check output.

  The other tabs are Details (the goal is the description), Changes, Agent notes and Outcome.

- **Action bar.** An All / Pipeline / Loops filter. Needs me already counts loops, since a loop
  waiting on the user has ball User.

## Phase 5: MCP tools, drafts from automations, the waiting cap

**Tools**, answered by the daemon beside the task tools in `mcp_gateway.rs`:

| Tool                      | For         | Notes                                                                                 |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `loop_status`             | the worker  | Goal, checks and their state, iteration n of N, budget left                           |
| `loop_note`               | the worker  | Replaces the loop notes                                                               |
| `loop_claim_check`        | the worker  | Runs one command check now and returns its result. Never ticks it                     |
| `loop_propose_check`      | the worker  | Adds a proposed check                                                                 |
| `loop_blocked`            | the worker  | Ends the loop with a reason, ball User, instead of spinning                           |
| `create_task`             | any session | Gains `run_mode`, `checks` and budget fields, so an automation can leave a draft loop |
| `get_task`, `update_task` | any session | Gain the loop fields                                                                  |

`tools/list` is the same for every session, so the worker tools are listed everywhere and answer
"this session is not a loop iteration" outside one. That is the same shape as the task tools'
"not attached to a task".

**Waiting cap.** A per-project setting in `pipeline_settings`, "at most N loops waiting on me",
default 2. The drain does not claim a Queue loop task while that many loop tasks have ball User. The
card says why.

**Drafts from automations.** No new mechanism. An automation's prompt calls `create_task` with
`run_mode: "Loop"`, and the task waits in Planning. Its thread records which automation run created
it.

### Decisions (locked)

- No new loop-specific MCP tools for any session beyond the five worker tools. A loop is a task, so
  the task tools manage it.
- `create_task` stays as it is: it never starts anything, so it needs no permission prompt.

## Phase 6: docs

- `maestro-server/AGENTS.md`: a "Loops" section next to the pipeline's, covering the phases, the
  commit, the check runner and the gate.
- `src/AGENTS.md`: the loop card and view.
- The user docs on the website: what a loop is, how to write checks that cannot be gamed, and when to
  use a pipeline instead.

## Open questions

Each has a recommendation. None blocks phase 0.

1. **Gaming the checks.** _Recommendation:_ a per-loop list of protected paths, prefilled with the
   files the command checks name (a script, a test directory). An iteration that changes one fails
   with "touched a protected path" and is reverted. The judge's digest lists any change to tests.
   _Alternative:_ no protection, only the digest flag.
2. **Check timeouts and flakes.** _Recommendation:_ a per-loop timeout (default 10 minutes) and no
   automatic retry. A check that flips from pass to fail on an iteration that changed none of the
   files it ran is shown as "possibly flaky" on the card.
3. **Steering mid-run.** _Recommendation:_ "Add a note for the next iteration" on the loop view, filed
   as a `steer` comment and put in the next prompt. It is cheap, and the alternative is joining a
   session that will be thrown away.
4. **Where the notes live.** _Recommendation:_ in the daemon (`tasks.loop_notes`), written through
   `loop_note` and shown on the Agent notes tab, rather than `.maestro/loop/PROGRESS.md` in the
   worktree. A file there would be committed on every iteration and land in the pull request, unless
   every project's `.gitignore` excluded it.
5. **The gate for pipeline tasks.** _Recommendation:_ yes. A pipeline coder hitting the limit is the
   same problem, and the scheduler change is the same one.
6. **Dropping the probe.** _Recommendation:_ drop it, as phase 3 says, since the reset time is
   reported.

## Deferred, not scheduled

- A cost budget. Usage is recorded per turn, so it is one comparison away when wanted.
- An advisory flag on checks.
- Planner and executor loops, and several loops racing on one goal.
- Rebasing a long-running loop onto a moved base branch. A conflict surfaces through the existing
  `MergeConflict` path.
- Applying a task's `skills_override` and `mcp_allowlist` to its sessions.
