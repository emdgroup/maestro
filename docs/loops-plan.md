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
out. The agent never decides it is done. The checks do, and the agent never sees or touches them.

```
            ┌──────────────────────── next iteration (fresh session) ───────────────────────┐
            ▼                                                                               │
  Queue ─▶ Iterating ─▶ commit ─▶ Checking ─┬─ a command check fails, budget left ───────────┤
            │                  (sealed files├─ every command passes ─▶ Judging ─┬─ fails ───┘
            │ usage limit       in, no      │                                   └─ passes ─▶ Review
            ▼                   session)    ├─ a check is flaky ─▶ paused (you fix or remove it)
         gate closed until reset ───────────┤─ N iterations with no change ─▶ stalled (you)
                                            └─ budget spent ─▶ stopped (you)
                                                                     Review: digest, your checks,
                                                                     approval, pull request, merge
```

A loop is a **task**, not a new kind of object. It lives on the Tasks board, in the same five
columns, under the same capacity limit, the same Needs me filter, the same review sheet and the same
merge flow. What differs is how it runs while it is In Progress.

## Loop engineering, concept by concept

Checked against Addy Osmani's "Loop engineering" and the patterns it names, plus what reading the
pipeline code added (marked †). Every row is either built by a phase below, already in Maestro, or
left out on purpose.

| Concept                                        | Where it lives                                                                                          | Phase     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------- |
| `/goal`: stop when a written condition is true | "Done when" checklist, run by the daemon after every iteration                                          | 1         |
| Separate maker and checker                     | `judge` checks run by a separate agent session, optionally another agent                                | 2         |
| The worker never grades itself                 | Ending its turn is the agent's only claim. The daemon runs the checks with no agent session live        | 1         |
| † Sealed checks (a "dark factory")             | Test and check files are hidden from the worker's worktree and cannot be changed by it                  | 1         |
| Memory on disk, not in context                 | `.maestro/loop/PROGRESS.md` in the worktree, read first by every session, plus one commit per iteration | 1         |
| Fresh context per iteration                    | One new ACP session per iteration, the same mechanism the pipeline's stages use                         | 1         |
| Verifier output feeds the next turn            | The failing checks' output, cut to its last 200 lines, is in the next prompt                            | 1         |
| † Check timeouts                               | 10 minutes per check by default, configurable per loop; a timeout is a failure                          | 1         |
| † Flaky checks                                 | A failure is re-run once on the same commit; a different result pauses the loop for the user            | 1         |
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
| † Steering mid-run                             | "Add a note for the next iteration", put in the next prompt                                             | 2, 4      |
| Human escape hatch                             | Pause, Stop, Try now, Send back with a note, Answer and resume, Re-run checks                           | 2, 4      |
| Observability                                  | Iteration list, check output, per-iteration session reopenable, outcome thread                          | 4         |
| Tool abstraction                               | Any ACP agent can run a loop. Only the reset-time reading is Claude-specific; others back off           | 3         |
| Sub-agents to ideate                           | Left out: planner and executor loops are not in scope                                                   | none      |

## Decisions that span every phase

Locked while drafting. Do not reopen without the user.

- **A loop is a task with `run_mode = Loop`.** It is created from New Task ("How it runs: Pipeline |
  Loop"), from an existing Planning task ("Make it a loop"), or by an agent through MCP. There is no
  Loops tab.
- **One fresh session per iteration.** Memory is `.maestro/loop/PROGRESS.md` in the worktree and the
  git history, never a continued conversation. `.maestro/` is in the repository's `info/exclude`
  (`project_storage::exclude_maestro_from_git`), which covers every worktree, so the notes are never
  committed.
- **Done criteria are a checklist.** Each check is one of:
  - `command`: a shell command, exit 0 passes.
  - `judge`: a sentence a separate agent judges against the diff, answering pass or fail with a
    reason.
  - `manual`: the user ticks it.
- **Every check is required.** There is no advisory flag. Soft concerns go in the digest under
  "Worth a look".
- **The checks are sealed from the worker (a dark factory).**
  - The worker cannot read or change the tests and scripts the checks use. The next section says how.
  - Ending its turn is its only way to ask for a verdict. There is no "run the checks" tool for it.
- **Regressions are caught.**
  - `command` checks all re-run after every iteration.
  - A `judge` check re-runs when the diff has changed since it last passed, and once more before the
    loop finishes.
  - `manual` checks are ticked at the end, and any later change clears them.
- **Flaky checks stop the loop for the user.**
  - A failing command check is run once more on the same commit, in the same state.
  - A different result marks it flaky. The loop pauses, ball User, and the user fixes the check or
    removes it, then presses Re-run checks.
  - A flaky result never counts as a pass, and the re-run is not an iteration.
- **Checks time out.** 10 minutes per check by default, configurable per loop. A timeout is a failure
  with "timed out after 10m", not a flake.
- **The agent proposes, the user disposes.**
  - A check the agent proposes appears as proposed. Accepting it makes it a full check whose kind the
    user picks, and seals whatever files it names.
  - An unanswered proposal does not hold iterations back, but it holds the loop at sign-off.
- **The user can steer.** A note added while the loop runs goes into the next iteration's prompt.
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
- **The usage-limit gate applies to every task**, pipeline and loop alike.

## Sealed checks

The worker builds the implementation. It does not get to see the tests that judge it, and it cannot
change them. Three mechanisms, all of them plain `git` on the daemon's machine.

**1. What is sealed.** Each loop has a list of **sealed paths**: test directories, check scripts,
fixtures.

- The editor prefills it from the files the command checks name. `scripts/check.sh` in a command seals
  `scripts/check.sh`, and `bun run test` offers the test globs the user confirms.
- The user can also write **hidden files**: acceptance tests that exist nowhere in the repository.
  The daemon stores them in `loop_hidden_files`. The worker never has them.

**2. The worker's worktree does not contain them.**

- The loop's worktree is created with a non-cone sparse checkout that excludes every sealed path:
  `git sparse-checkout set --no-cone '/*' '!/tests/' …`. The files are absent from disk, and git does
  not treat their absence as a deletion, so nothing the worker commits removes them.
- The prompt says the checks run separately, that their sources are not available, and that their
  failures arrive as output only.

**3. They are restored only while no session is live.** At the end of each iteration:

1. The iteration's session is closed. A loop session is never continued, and Join on a finished
   iteration reopens it read-only through `session/load`, like an automation run.
2. Anything the worker created at a sealed path is discarded, and the iteration is flagged "touched a
   sealed path".
3. The rest is committed.
4. The sealed paths are written into the worktree from the loop's **sealed snapshot**: their content at
   the base commit, plus the hidden files under `.maestro/loop/sealed/`, which `info/exclude` already
   keeps out of git.
5. The setup command, if any, then the checks, run in that state.
6. The sealed files are removed again before the next session starts.

The snapshot is taken from the base branch when the loop starts. **Re-run checks** takes it again,
which is how a test the user fixed on the base branch reaches the loop.

**Known limit: sealing hides, it does not sandbox.** A worker determined to read a sealed test can
still ask git for it (`git show <base>:tests/…`), and the agent process has the user's filesystem
permissions. Changes cannot get through: whatever the worker does, the checks run against the
snapshot. Real isolation needs an OS sandbox for the agent process, which is deferred. The judge's
digest lists any `git` command the worker ran that named a sealed path, from the session's tool calls.

## What exists, and what each phase reuses

From a survey of the pipeline (`maestro-server/AGENTS.md`, "The daemon drives the task pipeline").

| Need                                     | Already there                                                                          | File                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| Fresh session per stage, old one closed  | `task_runner::run` always issues `session/new`; `adopt` cancels the superseded session | `task_runner.rs`                        |
| Worktree kept across stages              | `prepare_task_workspace` reuses the worktree the task owns                             | `worktree.rs`                           |
| `.maestro/` out of git in every worktree | `exclude_maestro_from_git` writes `info/exclude` in the common git directory           | `src-tauri/src/core/project_storage.rs` |
| Turn end routed to the task              | Main loop `TurnEnd` arm, then `task_turn::spawn` and `resolve`                         | `main.rs`, `task_turn.rs`               |
| Next stage started by one driver         | `next_stage` (Waiting + ball Agent) and the scheduler's debounced drain                | `task_turn.rs`, `scheduler.rs`          |
| Guarded transitions                      | `transition::resolve` and `TransitionGuard`, one request each                          | `task_store/transition.rs`              |
| Per-stage prompt from comments           | `task_prompt::compose`, keyed on the prior phase and `latest_of_kind`                  | `task_prompt.rs`                        |
| Coder prompts answered unattended        | `task_gate::decide` allows a coder in a writing phase                                  | `session/task_gate.rs`                  |
| Restart recovery                         | `task_restart` reloads a mid-turn session and resumes it                               | `task_restart.rs`                       |
| Tokens per turn                          | `usage_turns` rows written at every `TurnEnd`                                          | `usage_store.rs`                        |
| A bounded loop today                     | The coder and reviewer rounds, capped by `REVIEW_ROUND_CAP`                            | `task_store.rs`, `turn.rs`              |
| Approval, PR, merge                      | `approve_task_and_merge`, `open_pull_request_for_task`                                 | `src-tauri/src/git/merge.rs`            |

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

| Phase | What                                                       | State       |
| ----- | ---------------------------------------------------------- | ----------- |
| 0     | Data model and protocol                                    | Done        |
| 1     | The iteration engine and sealed checks                     | Done        |
| 2     | Judge, digest, proposals, steering, sign-off, pull request | Not started |
| 3     | Usage-limit gate, for every task                           | Not started |
| 4     | The board: create, card, loop view                         | Not started |
| 5     | MCP tools, drafts from automations, the waiting cap        | Not started |
| 6     | Docs                                                       | Not started |

Phases 0 to 2 are the engine and can be exercised through MCP and tests before any UI exists. Phase 3
is independent of 2 and can go in either order. Phase 4 needs 0 to 2.

## Phase 0: data model and protocol

Storage, protocol fields and the row requests. No behaviour: nothing can put a task into a loop phase
yet, so nothing iterates.

`projects.db` gains one migration, a new frozen literal appended to `project_store::MIGRATIONS` the
way V8 added `claimed_from`.

**`tasks` columns:**

| Column            | Type                       | Meaning                                                                                                                        |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `run_mode`        | TEXT, default `'Pipeline'` | `Pipeline` or `Loop`                                                                                                           |
| `loop_config`     | TEXT, JSON                 | `max_iterations` (10), `max_agent_secs` (7200), `stall_limit` (3), `check_timeout_secs` (600), `setup_command`, `sealed_paths` |
| `loop_sealed_sha` | TEXT                       | The base commit the sealed snapshot was taken from                                                                             |

**New tables**, keyed by `(project_path, task_id, …)` like every task table:

- `loop_checks`: `id`, `position`, `kind` (`command`/`judge`/`manual`), `label`, `command`, `state`
  (`pending`/`pass`/`fail`/`flaky`), `detail` (last output tail or judge reason), `proposed` (bool),
  `accepted` (bool), `passed_at_sha` (the commit a judge last passed on), `updated_at`.
- `loop_iterations`: `n`, `attempt`, `acp_session_id`, `agent_id`, `started_at`, `ended_at`,
  `outcome` (`running`/`checked`/`interrupted`/`empty`/`failed`), `counted` (bool), `touched_sealed`
  (bool), `commit_sha`, `files`, `added`, `removed`, `summary` (the agent's final message),
  `check_output` (tail).
- `loop_hidden_files`: `path` (relative, under the sealed folder), `content`.
- `agent_gates` (daemon-wide, not per project): `agent_id`, `resume_at`, `reason`, `backoff_step`.

**Protocol.**

- `Task` gains `run_mode`, `loop_config` and `loop_sealed_sha`. `CreateTaskRequest` gains
  `run_mode` and `loop_config`, and `TaskUpdate` gains both too. A loop task created or switched
  without a config gets the defaults above.
- New requests, each answered from the store and pushing `TasksChanged` when it writes:
  - `ListLoopChecks`, and `SetLoopChecks` (the user's whole list, from the editor)
  - `AnswerLoopProposal`, `TickLoopCheck`
  - `ListLoopIterations`
  - `ListLoopHiddenFiles`, `SetLoopHiddenFiles`
- `PROTOCOL_VERSION` bumps once for the whole plan, in this phase. Requests added by later phases
  ride on that bump, since nothing releases in between.

**The app.** Its `Task` model and the generated bindings carry the new fields so they round-trip.
No new Tauri commands and no UI until phase 4.

### Decisions (locked)

- One migration for the whole feature. It may be rewritten until it ships, per the rule in
  `src-tauri/AGENTS.md`.
- A loop task's checks are rows, not JSON in `loop_config`. Their state changes every iteration, and
  each one is read, ticked and answered individually.
- Enum variants arrive with their behaviour, never as placeholder arms. `Iterating` and `Checking`
  land in phase 1 with the engine and its restart handling; `Judging` and `AgentRole::Judge` in
  phase 2 with the judge prompt. The phase column is TEXT, so the migration needs nothing for them.
- `RerunLoopChecks` and `ReadLoopNotes` need the worktree and the engine, so they are phase 1's.
- The judge is picked through the profile system, as the planner and reviewer are: a project default
  and a per-task override in `profile_overrides`. There is no `judge_agent_id`.
- `run_mode` changes only while the task has never started (no phase). The config, the checks and
  the hidden files can be edited at any time.
- `SetLoopChecks` writes the user's checks and leaves pending proposals alone; a proposal leaves that
  state only through `AnswerLoopProposal`. A check whose kind, label or command changed goes back to
  `pending`; an unchanged one keeps its state.
- Sealed paths and hidden file paths are relative, use `/`, and never contain `..`.

**Phases** the later phases add to `TaskPhase`, listed here so the model is in one place:

| Phase       | Session                        | Writes | Handoff when                              |
| ----------- | ------------------------------ | ------ | ----------------------------------------- |
| `Iterating` | Coder, fresh per iteration     | yes    | `Waiting` + ball `Agent` (next iteration) |
| `Checking`  | none, the daemon runs commands | no     | n/a, runs inside the turn end             |
| `Judging`   | `AgentRole::Judge`, read-only  | no     | `Waiting` + ball `Agent`                  |

A flaky check leaves the task in `Checking` with `Failed` and ball `User`. The existing `Approval` and
`AwaitingMerge` are reused unchanged for sign-off and the pull request.

## Phase 1: the iteration engine and sealed checks

**Creating the worktree.** `prepare_task_workspace` applies the sparse checkout for a loop task, as
described under "Sealed checks". It takes the sealed snapshot's base commit into `loop_sealed_sha` on
first creation.

**Starting an iteration.** The scheduler's drain already claims Queue candidates and `Waiting` +
`Agent` handoffs. For a loop task:

- `next_stage` returns `Coder` for `Iterating` and `Judge` for `Judging`.
- `SessionReady(Coder)` lands on `Iterating` instead of `Implementing` when `run_mode = Loop`.
- `task_prompt::compose` gets a loop branch for the coder, built from:
  - the goal (the task description),
  - the iteration number and the budget left,
  - the failing checks with their output tails,
  - the user's steering notes since the last iteration,
  - the loop protocol: "read and update `.maestro/loop/PROGRESS.md`. The checks run after you end
    your turn and their sources are not available to you. Propose a check with
    `loop_propose_check`. Call `loop_blocked` if you cannot proceed. Do not declare the loop done."
- The session's `ProjectBinding` meta carries the **iteration number**. `task_turn::resolve` ignores
  a turn end from any other iteration, which closes the stale-session gap.

**Ending an iteration**, in `task_turn::resolve`, when `run_mode = Loop`:

1. **Classify.**
   - Interrupted by a usage limit (phase 3)? Then go to the gate and stop here.
   - Ended by the user? Then stop here.
   - Any other agent error fails the iteration. Three failed iterations in a row stop the loop.
2. **Close the session**, then **discard** anything at a sealed path, then **commit** the rest:
   `git add -A` and `git commit -m "loop: iteration n"` in the worktree, with `--allow-empty` off. An
   empty diff makes the iteration `empty`.
3. **Check.** The phase becomes `Checking`. The daemon:
   1. writes the sealed snapshot in,
   2. runs `setup_command` if set,
   3. runs every `command` check, one at a time in list order, each with `check_timeout_secs` and
      killed past it, keeping its exit code and the last 200 lines of combined output,
   4. runs each failing check once more, and marks it `flaky` if the result changed,
   5. removes the sealed files.

   This runs off the main loop, as `launch` does: it is a process, and the loop's stack is 1 MB in a
   Windows debug build.

4. **Decide.**
   - A check is flaky: pause, `Checking` + `Failed` + ball User, and report which one.
   - Every command check passes, and judge checks remain: hand off to `Judging`.
   - Everything automatic passes: go to sign-off (phase 2).
   - The stall counter reaches `stall_limit`: stop with "stalled", ball User.
   - The budget is spent: stop with "budget", ball User.
   - Otherwise: `Iterating` + `Waiting` + `Agent`, and the drain starts the next iteration.
5. **Record.** Write the `loop_iterations` row, with tokens from that turn's `usage_turns` row and the
   agent's final message as `summary`. File a short outcome comment on the thread.

**Re-run checks** (`RerunLoopChecks`, offered when the loop is paused on a flaky check or after the
user edited the checks) takes a new sealed snapshot from the base branch and runs step 3 on the same
commit. It is not an iteration and costs no budget.

**Budgets.** `max_iterations` counts iterations with `counted = true`. Agent time is the sum of
counted iterations' `ended_at - started_at`. Both are checked before a handoff is written, never
mid-turn.

**Restart.** `task_restart` learns three loop states:

- `Iterating` mid-turn resumes like any coder.
- `Checking` re-runs step 3, since the process died with the daemon, after removing any sealed files a
  crash left in the worktree.
- `Judging` is restarted fresh: a judge is cheap and holds nothing.

**Capacity.** An iteration takes a slot like any coder session. A loop in `Checking` holds none,
since no session is live.

### Decisions (locked)

- The daemon commits each iteration. This is the first commit the daemon makes. The pipeline's own
  approval commit in the app still runs, and finds nothing left to stage.
- Checks run on the daemon's machine, in the loop's own worktree, with the user's shell: `sh -c` on
  Unix, `cmd /C` on Windows. They are the user's commands, run with the user's permissions, like the
  agent itself. Running them in that worktree rather than a separate checkout keeps its installed
  dependencies and build caches.
- A loop session is closed at the end of its iteration, not at the next one's start, because the
  sealed files must never be on disk while a session is live.
- A loop needs a git project and its own new worktree (`NewWorktree`). Sealing a shared checkout
  would hide the tests from the user too, so creating a loop or switching a task to Loop with
  another workspace mode is refused, and a loop started outside a git repository fails with a note.
- The next iteration respects the capacity limit. The drain claims it before Queue tasks, but only
  into a free slot, so a loop never runs past the limit and loops take turns.
- A loop never runs the planner. The goal and the checklist are its spec, and the first iteration
  can write its own plan into `PROGRESS.md`.
- **Stall.** An iteration makes no progress when it has nothing to commit, or when the same command
  checks fail with the same output as the iteration before. `stall_limit` such iterations in a row
  stop the loop. An empty iteration runs no checks.
- **The iteration commit runs the repository's hooks**, with the user's git identity. A hook that
  fails fails the iteration, and its output is fed to the next one like a failing check's. A missing
  identity fails it the same way, with git's message.
- The sealed snapshot comes from the local `base_branch` ref. The daemon fetches nothing.
- Until phase 2, a loop whose command checks all pass goes straight to the `Approval` gate, with any
  `judge` check still pending. Phase 2 puts the judge in between.
- The prompt names no Maestro tool until phase 5 adds them.

**As built** (`maestro-server/src/loop_engine.rs`, `task_store/loops.rs`):

- The states: `Iterating` Running is a live iteration; `Iterating` Waiting with ball Agent is the next
  one, waiting on the drain; with ball User it stalled or spent its budget, and Execute starts it
  again; `Iterating` Failed is three failed iterations, and Retry starts the next. `Checking`
  Running is the checks; `Checking` Failed is a flaky check or checks that could not run.
- At an iteration's end the sealed paths are removed **before** the sparse checkout is set again,
  then committed. Set first, a sealed file the worker changed after turning the sparse checkout off
  would stay, and its removal be staged.
- Re-run checks is offered on any stopped loop with a commit: paused, stalled, failed or at sign-off.
- "The same output" ignores digits, so timings and counters do not read as progress.
- A timeout is not re-run. A check that fails and then passes on its re-run is flaky; one that
  passes and then fails cannot happen, since only failures are re-run.
- **The daemon's main thread has almost no stack to spare.** `dispatch_message` sits near the 1 MB a
  Windows debug build gives it, and two more inline arms froze the daemon (a hang, not a crash).
  The loop requests are answered out of line in `loop_engine::answer`; do the same for anything
  new there.

## Phase 2: judge, digest, proposals, steering, sign-off, pull request

- **`AgentRole::Judge`.** Read-only, like the reviewer.
  - Its prompt is the goal, the diff against the base, and the judge checks to decide.
  - It answers each check `PASS` or `FAIL` with one line of reason, parsed like `classify_verdict`.
  - The agent comes from the Judge profile: the task's override in `profile_overrides`, else the
    project's default judge, else the worker's agent.
  - The sealed files stay out of its worktree too. The judge reads the diff, not the tests.
- **Re-judging.** A judge check whose `passed_at_sha` is the current commit is skipped. One final
  judge pass always runs before sign-off.
- **Digest.** On the last judge pass, the prompt also asks for the digest, filed as comment kind
  `digest`. It has three sections: what changed, what the loop decided on its own, and what deserves
  a look. "What deserves a look" includes any iteration flagged `touched_sealed`.
- **Proposals.** Accepting a proposed check adds the files it names to `sealed_paths`. The sparse
  checkout is updated before the next iteration.
- **Steering.** "Add a note for the next iteration" files a `steer` comment. The next prompt includes
  every `steer` comment newer than the previous iteration's start.
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

## Phase 3: usage-limit gate, for every task

- **Read the limit where it arrives.** `usage_store::note_update` (or `turn::note_update`) reads
  `_meta["_claude/rateLimit"]` from `usage_update`. On `status: "rejected"` it records `resetsAt` and
  the window against the session. `TurnEnd` carries it as a new `TurnFacts.limit`.
- **Close the gate.** A turn that ends with a limit recorded writes `agent_gates(agent_id,
resume_at)`. With no reset time, the gate backs off 5, 15, 30, then 60 minutes, capped at 2 hours.
- **Hold the work.** The scheduler skips candidates and handoffs whose agent's gate is closed, for
  pipeline and loop tasks alike. It reopens them on its one-minute tick once `resume_at` passes.
- **What happens to the interrupted turn.**
  - A loop iteration is committed as WIP, marked `interrupted` and not counted. The same iteration
    number runs again once the gate opens.
  - A pipeline stage goes back to waiting on its agent, and its stage starts again, as
    `SpawnInterrupted` already does for a hand-off.
- **No probe session.** The reset time is known, so the next real turn is the probe. If it is refused
  again, the gate closes again.
- **Try now** clears the gate for that agent.

### Decisions (locked)

- The gate is per agent and per daemon, because the limit belongs to the account the agent runs as,
  as `planLimitsKey` already treats it in the app.
- Reading the reset time is Claude-specific, since only `claude-agent-acp` reports it. Every other
  agent gets the backoff.
- The gate applies to every task, not only loops.

## Phase 4: the board

Visuals are the canvas mock `loops-app`.

- **Create Task** gets "How it runs: Pipeline | Loop". Loop shows:
  - Done when: rows of command, judge and manual checks.
  - **Sealed from the agent:** the sealed paths, prefilled from the commands, and the hidden files.
  - Setup command, check timeout (10 minutes), iterations, agent time, stall limit, judge.
  - A read-only line of the skills and MCP servers the agent gets.

  A Planning pipeline task's detail offers **Make it a loop**.

- **Card.** A `LOOP` badge, and a phase line per loop state:
  - `ITERATION 6/12` with the last note.
  - `5-HOUR LIMIT · resumes 15:00`, with a dashed amber border.
  - `FLAKY CHECK, NEEDS YOU`, with the blocked glow.
  - `STALLED, NEEDS YOUR ANSWER`, with the blocked glow.
  - `NEEDS YOUR CHECK`.
  - `QUEUED · 2 loops already wait on you`.
  - `DRAFT · from <automation> #n`.

  The check bar sits under the phase line.

- **Detail modal**, with Loop as the first tab:
  - Banner per state, and the three meters (iterations, agent time, no-change streak).
  - The flaky banner names the check and both results, with Re-run checks and Edit checks.
  - The digest.
  - Done when, with Accept and Reject on proposals and Mark done on manual checks.
  - The iteration list (files, lines, tokens, checks passed), with Join on the running one.
  - "Add a note for the next iteration".
  - The live column with the last check output.

  The other tabs are Details (the goal is the description, and the sealed paths), Changes, Agent notes
  (`PROGRESS.md`) and Outcome.

- **Action bar.** An All / Pipeline / Loops filter. Needs me already counts loops, since a loop
  waiting on the user has ball User.

## Phase 5: MCP tools, drafts from automations, the waiting cap

**Tools**, answered by the daemon beside the task tools in `mcp_gateway.rs`:

| Tool                      | For         | Notes                                                                                            |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `loop_status`             | the worker  | Goal, checks by label and state, iteration n of N, budget left. Never a check's command or files |
| `loop_propose_check`      | the worker  | Adds a proposed check                                                                            |
| `loop_blocked`            | the worker  | Ends the loop with a reason, ball User, instead of spinning                                      |
| `create_task`             | any session | Gains `run_mode`, `checks` and budget fields, so an automation can leave a draft loop            |
| `get_task`, `update_task` | any session | Gain the loop fields                                                                             |

`tools/list` is the same for every session, so the worker tools are listed everywhere and answer
"this session is not a loop iteration" outside one. That is the same shape as the task tools'
"not attached to a task".

`get_task` called from a loop's own worker session leaves out the loop's commands, sealed paths and
hidden files. They are for the user and the daemon only.

**Waiting cap.** A per-project setting in `pipeline_settings`, "at most N loops waiting on me",
default 2. The drain does not claim a Queue loop task while that many loop tasks have ball User. The
card says why.

**Drafts from automations.** No new mechanism. An automation's prompt calls `create_task` with
`run_mode: "Loop"`, and the task waits in Planning. Its thread records which automation run created
it.

### Decisions (locked)

- No tool lets the worker run a check. Ending the turn is the claim.
- No notes tool. The notes are a file in the worktree the agent edits like any other.
- `create_task` stays as it is: it never starts anything, so it needs no permission prompt.

## Phase 6: docs

- `maestro-server/AGENTS.md`: a "Loops" section next to the pipeline's, covering the phases, the
  sealed snapshot, the commit, the check runner and the gate.
- `src/AGENTS.md`: the loop card and view.
- The user docs on the website:
  - what a loop is, and when to use a pipeline instead,
  - how to write checks: seal them, keep them deterministic, give them a setup command,
  - what to do with a flaky check.

## Deferred, not scheduled

- An OS sandbox for the agent process, which would make sealed files unreadable rather than hidden.
- A cost budget. Usage is recorded per turn, so it is one comparison away when wanted.
- An advisory flag on checks.
- Planner and executor loops, and several loops racing on one goal.
- Rebasing a long-running loop onto a moved base branch. A conflict surfaces through the existing
  `MergeConflict` path.
- Applying a task's `skills_override` and `mcp_allowlist` to its sessions.
