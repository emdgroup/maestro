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
| Budgets                                        | Iterations, time per Build, stall limit. Tokens are shown per iteration, not budgeted                   | 1         |
| Stall detection                                | N iterations in a row whose commit is empty stop the loop                                               | 1         |
| Regressions                                    | Every command check re-runs after every iteration, passed or not                                        | 1         |
| Usage limits without polluting context         | The daemon reads the reset time from the refused reply and waits; the next session never sees the error | 3         |
| Comprehension debt                             | Review digest written by the judge: what changed, what it decided alone, what deserves a look           | 2         |
| Cognitive surrender                            | Manual checks, the digest, the existing review sheet and approval gate. Nothing forces reading          | 2         |
| Orchestration tax ("you are the ceiling")      | A cap on loops waiting on the user; past it, new loops queue                                            | 5         |
| Token cost vigilance                           | Tokens per iteration from `usage_turns`. No cost budget, by decision                                    | 4         |
| † Steering mid-run                             | "Add a note for the next iteration", put in the next prompt                                             | 2, 4      |
| Human escape hatch                             | Halt (pause or stop), Try now, Send back with a note, Answer and resume, Re-run checks                  | 2, 4      |
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
- **No cost budget.** Iterations, the time per Build and the stall limit are the budget. Tokens are
  reported per iteration.
- **Time is per Build, not per loop.** `max_build_secs` (2 hours) caps one iteration's Build
  session. A total across the loop stopped a loop whose Builds take 30 minutes long before its
  iterations ran out; the iteration count already bounds the total.
- **Waiting is free.** An iteration a usage limit cut off runs again without counting, on a fresh
  clock.
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
| 2     | Judge, digest, proposals, steering, sign-off, pull request | Done        |
| 3     | Usage-limit gate, for every task                           | Done        |
| 4     | The board: create, card, loop view                         | Done        |
| 5     | MCP tools, drafts from automations, the waiting cap        | Done        |
| 5b    | Context and sandbox worktrees, Prepare loop                | Done        |
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
| `loop_config`     | TEXT, JSON                 | `max_iterations` (10), `max_build_secs` (7200), `stall_limit` (3), `check_timeout_secs` (600), `setup_command`, `sealed_paths` |
| `loop_sealed_sha` | TEXT                       | The base commit the sealed snapshot was taken from                                                                             |

**New tables**, keyed by `(project_path, task_id, …)` like every task table:

- `loop_checks`: `id`, `position`, `kind` (`command`/`judge`/`manual`), `label`, `command`, `state`
  (`pending`/`pass`/`fail`/`flaky`), `detail` (last output tail or judge reason), `proposed` (bool),
  `accepted` (bool), `passed_at_sha` (the commit a judge last passed on), `updated_at`.
- `loop_iterations`: `n`, `attempt`, `acp_session_id`, `agent_id`, `started_at`, `ended_at`,
  `outcome` (`running`/`checked`/`interrupted`/`empty`/`failed`), `counted` (bool), `commit_sha`,
  `files`, `added`, `removed`, `summary` (the agent's final message), `check_output` (the failing
  checks' tail).
- `loop_check_results`: `n`, `check_id`, `state`, `detail`, `command`. Every check's result after
  iteration `n`, passing ones and judge verdicts included, replaced when the checks run again on
  the same iteration. The Loop tab's iteration rows read it; the engine never does.
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
   `git add -A` and `git commit -m "chore(loop): iteration n"` in the worktree, with `--allow-empty` off. An
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

**Budgets.** `max_iterations` counts iterations with `counted = true`, checked before a handoff is
written, never mid-turn. `max_build_secs` is checked on the scheduler's minute tick against the
running iteration's `started_at`: a Build past it has its session closed and is finished as if its
turn had ended, with "Closed after 2 hours" as its closing note, so its work is committed and
checked and the loop goes on. Whichever of that close and the turn's own end comes first finishes
the iteration; the other finds it claimed.

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
  identity fails it the same way, with git's message. The message is a conventional commit, so a
  `commit-msg` hook such as commitlint's accepts it: one that refused `loop: iteration n` failed
  every iteration that left anything to commit, and the worker could do nothing about it.
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
  a look.
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
- **The judge reads the diff itself.** Its prompt gives the base commit and `git diff --stat`; it
  runs `git diff` as the reviewer does. Nothing is cut to a size limit.
- **The digest comes in the judge's own turn.** The prompt asks for it after the verdicts, only when
  every check passed. There is no second turn or session for it.
- **No judge checks, no digest.** A loop whose checklist has no `judge` check goes straight from its
  commands to `Approval`, and its pull request body is the description, the checklist and the
  iteration count.
- **A check the judge gives no readable verdict counts as a fail.** The loop iterates, and the
  worker is told the judge gave no verdict, with the judge's reply.
- **A resume restarts the stall streak only.** Sending a loop back, or starting a stalled or
  stopped one again, counts stalls from the resume. Iterations stay cumulative, so a
  spent budget is raised before a resume can run.
- **Accepting a proposal names the paths to seal.** `AnswerLoopProposal` carries them; the editor
  prefills them in phase 4. A path that does not exist on the base branch is refused: the snapshot
  comes from there, so the user commits the test to the base branch or adds it as a hidden file.
- **Judge time is not Build time.** The limit closes the worker's session only.
- **Hidden-file writes are discarded, not reported.** Whatever the worker wrote at a sealed path is
  deleted before the checks run. Reporting it, and the `git` commands that named one, was dropped
  with the Loop tab redesign: a substring scan of commands flagged too much to be worth a look.

**As built** (`loop_engine.rs`, `task_store/loops.rs`, `task_prompt.rs`, `src-tauri/src/git/merge.rs`):

- The states: `Judging` Waiting with ball Agent is the judge waiting on the drain, which claims it
  into a free slot like a next iteration; `Judging` Running is the judge's session; `Judging` Failed
  is a judge session that ended badly, retried by the judge or by Re-run checks.
- A judge session's role meta carries the check ids it was given, in its prompt's order, and the
  commit they were judged at, so a check edited or added meanwhile cannot shift the numbering. Its
  answer is read by number (`1. PASS: reason`), decorations ignored; the first line for a number
  wins. A pass is recorded with that commit in `passed_at_sha`.
- The digest is a `digest` comment, one per task like a plan: a new one replaces the last.
- A failed judge check reaches the next prompt as "The judge on ...", with the reason. Its failures
  never count as a stall: the judge's wording changes every time, so the budget is what ends a
  loop the judge keeps failing.
- Steering is a `steer` comment. The prompt shows every one written after the previous iteration
  started, so a note added while an iteration runs reaches the next one.
- A resume is stamped in `tasks.loop_resumed_at` by `LoopResumed`, and by a start of an `Iterating`
  task whose ball was the user's (Execute on a stalled loop, Retry on a failing one). The failure
  streak restarts with the stall streak.
- Accepting a proposal checks each path with `git ls-tree` on the base branch, retakes the sealed
  snapshot from the branch's tip so the new path is in it, and applies the sparse checkout at once,
  unless the checks are running in the worktree; then the next iteration's start applies it.
- A peek is a substring match of a sealed path in a shell command that contains `git`, read from
  the turn's `tool_call` and `tool_call_update` raw input.
- Sign-off is refused in `approve_task_and_merge` before anything is committed: every check must
  pass and no proposal may wait. Any commit an iteration makes clears the manual ticks.
- The Settings page lists the Judge role. With no Judge profile, the judge runs on the worker's
  agent, not the project's default.

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

Settled before phase 3 started:

- **A refused turn rarely carries its reset time.** `claude-agent-acp` 0.86 fails the prompt with a
  JSON-RPC error whose data is `{errorKind: "rate_limit"}` and whose message is the CLI's "You've hit
  your limit · resets 8pm". It sends `_claude/rateLimit` only once the turn has had a real model
  reply, so a fresh session refused on its first prompt, which is every new iteration and stage,
  gets none. The daemon therefore keeps the latest reading per agent from any of its sessions, and
  on a refusal uses that reading's `resetsAt` for a rejected or full window. With none usable, it
  backs off. The text is not parsed: it has no date and the daemon may run in another time zone.
- **What closes the gate.** For Claude, an error whose `errorKind` is `rate_limit` or
  `billing_error`; a transient 429 matches too, and the first 5-minute backoff absorbs it. For any
  agent, an error whose message names a usage limit, a rate limit, a quota or a 429. Any other
  error fails the stage as before. Any session's refusal closes the gate, tasks or not.
- **A refused pipeline stage starts again in a fresh session.** It goes back to waiting on its
  agent in the same phase, `Implementing`, `Drafting` and `Refining` included, and the drain starts
  it once the gate opens. The worktree keeps what the cut-off session wrote.
- **Tasks only.** Automation runs on a gated agent fail as they do today.
- **The user sees one note** in the task's thread when its turn is refused, saying when it goes on.
  Nothing is written when the gate opens.
- **Try now** is a daemon request in this phase. The app command and its button come with phase 4.
- **The backoff steps up**, 5, 15, 30, 60, then 120 minutes for each refusal in a row with no reset
  time, and any turn of that agent that ends normally resets it.
- **The gate survives a restart**, in phase 0's `agent_gates`, whose `reason` is `reset` or
  `backoff`, so a restart does not start a burst of refused sessions.

**As built** (`maestro-server/src/agent_gate.rs`, `task_turn.rs`, `loop_engine.rs`, `task_runner.rs`):

- A refusal is noted where the prompt fails (`session/command_loop.rs`) and reaches the turn end as
  `TurnFacts.usage_limited`; the turn's last reading is `TurnFacts.plan_reading`. The main loop's
  turn end keeps the reading per agent, in memory, and closes or opens the gate for every session.
- A gate closed by one refusal is not moved by another session's refusal while it is still
  closed, so several sessions cut off at once count as one step of the backoff.
- `task_runner::begin` holds only unattended starts (`Begun::Gated`): the drain and a turn's
  next stage. A user's own Execute goes ahead, as the probe they asked for.
- `UsageLimited` puts a running stage back to `Waiting` with ball Agent in its own phase, and
  `next_stage` now asks for the role of any working phase waiting on an agent. A first stage
  (`Implementing`, `Drafting`, `Refining`) cut off this way waits for a free slot, like a loop's
  next iteration, since its session is closed.
- A cut-off iteration is committed as `chore(loop): iteration N, cut off (WIP)`, recorded `Interrupted`
  and uncounted, and runs again as the next attempt of the same number. A cut-off judge judges
  again; nothing is recorded against its checks.
- The note reads "The agent hit its usage limit, so this task waits until Tue 20:00 and then goes
  on.", in the daemon's local time.
- `OpenAgentGate` is answered from `loop_engine::answer`: a new arm in `dispatch_message`, even a
  boxed one, overflows the main thread's stack in a debug build.

## Phase 4: the board

Visuals are the canvas mock `loops-app`.

- **Create Task** gets "How it runs: Pipeline | Loop", below the workspace. Choosing Loop turns the
  footer into **Set up the loop**, which opens a second screen with a way back, ending in the usual
  Create another and Create. (Phase 5b drops that screen: a loop is created bare and set up from its
  card.) That screen shows:
  - Done when: rows of command, judge and manual checks.
  - **Sealed from the agent:** the sealed paths, prefilled from the commands, and the hidden files.
  - Setup command, check timeout (10 minutes), iterations, time per Build, stall limit, judge.
  - A read-only line of the skills and MCP servers the agent gets.

  A Planning pipeline task's detail offers **Make it a loop**, which opens on the second screen.

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
  - No banners. The head of the iteration timeline carries the state: the iteration at work, or
    the one the loop stopped after, with a status word, the ring, step tiles ending on a **You**
    or **Merge** tile when the turn is someone else's, and one line on why it waits. It explains
    and does not ask; the footer holds the actions. A finished loop's head is one line.
  - A flaky check shows its card under the head, with Re-run checks and Edit the check. A merge
    conflict shows git's reason, kept on the iteration's `check_output`.
  - The digest.
  - Done when, with Accept and Reject on proposals and Mark done on manual checks.
  - The iteration list (files, lines, tokens, checks passed), with Join on the running one.
  - "Add a note for the next iteration".
  - The live column with the last check output.

  The other tabs are Details (the goal is the description, and the sealed paths), Changes, Agent notes
  (`PROGRESS.md`) and Outcome.

  As built after the test campaign (2026-10-16): the Loop tab is the loop's whole setup too, and the
  Setup tab and the live column are gone. The three limits are cards whose limit is edited in place,
  with the meter under it once the loop has started. Done when is one list: the pencil opens a check
  in place, a failing check's output opens under it, and a bare loop shows Prepare loop there. The
  running iteration's row carries what its agent is doing and Join. Below sit "Running the checks"
  (the setup command, now "Run first", and the timeout) and "Hidden from the agent" (the sealed
  paths and hidden files). The judge is picked only in the card's Agents dialog.

- **Action bar.** An All / Pipeline / Loops filter. Needs me already counts loops, since a loop
  waiting on the user has ball User.

### Decisions (locked)

Settled before phase 4 started:

- **The board reads one summary per loop.** The daemon fills `Task.loop_summary` on every loop task
  it lists: the iteration number, counted iterations and agent time, the no-change streak, the last
  summary, the check states, open proposals and why the loop halted (`tasks.loop_halt`). No card
  queries the loop's checks or iterations itself.
- **The limit line names the window.** The gate keeps the window the reading named (5-hour or
  weekly), so a card reads `5-HOUR LIMIT · resumes 15:00`, or `USAGE LIMIT · tries again 14:35` on a
  backoff. A task records the agent that refused it, and any task, pipeline or loop, waiting on a
  gated agent shows the line.
- **Pause is built.** It lets the running iteration finish and its checks run, then holds the loop
  for the user instead of starting the next one. Execute or Send back goes on.
- **Stop halts a loop in place.** It cuts the session, keeps its work as an uncounted WIP commit,
  and leaves the loop In Progress with ball User, its iterations and checks intact. Dragging the
  card to Planning still parks it.
- **Budgets change any time.** Iterations, time per Build, stall limit, check timeout and the setup
  command may be edited after the start; the checks already could. Sealed paths change only before
  the start or through an accepted proposal.
- **Make it a loop** is the mock's "Run as a loop instead" banner on a Planning pipeline task's
  Details tab. It opens Create Task in Loop mode, prefilled. No check is guessed for it.
- **A loop is edited on its Details tab**, with the same loop editor Create Task uses. "Edit checks"
  on the Loop tab goes there.
- **Phase 5's pieces wait for phase 5**: the `QUEUED · N loops already wait on you` line and Start
  anyway, and the automation draft line and banner.
- **The daemon's loop runs on an 8 MB thread.** Every task-path change had started to overflow the
  1 MB main thread of a Windows debug build, so `main` now runs everything on a spawned thread with
  room (`STACK_BYTES`).

**As built** (`src/components/kanban/loop/`, `src/services/loop.service.ts`,
`src-tauri/src/task/loops.rs`):

- The app has a command per loop request, plus `resume_loop` (`LoopResumed` with an optional
  `steer` note, which is Send back and Answer and resume), `add_loop_note`, `pause_loop`,
  `stop_loop`, `open_agent_gate` and `loop_sealable_paths`. Its loop types mirror the protocol's
  through one JSON round trip (`loops::mirror`) rather than a `From` per field. `interrupt_task`
  on a loop stops it in place instead of discarding its run.
- `Task.loop_summary` and `Task.gate` are boxed in the protocol: a `Task` rides in many of the
  daemon's futures. A task records the agent that refused it in `tasks.gated_agent_id`, and the
  gate's `reason` holds the window (`five_hour`, `seven_day...`), `reset` or `backoff`.
- Pause sets `tasks.loop_hold`; the next verdict that would start another iteration, or the judge,
  halts instead. `tasks.loop_halt` says why a loop stopped for the user. Stop on a running
  iteration halts it first, then closes the session and commits its work as an uncounted WIP on a
  task of its own: the request is answered inside the main loop's dispatch, which also settles the
  close.
- Each iteration's tokens are summed from `usage_turns` by its ACP session id.
- The sealed paths are prefilled from each command's tokens that look like paths and exist on the
  base branch. That can include a file the agent must edit; the user removes its chip.
- The card's footer for a loop in progress is Halt and Join. Halt asks whether to pause once the
  running step ends or to interrupt it now, offering only what the step allows (checks cannot be
  cut, a loop between steps halts at once); the detail's footer has the same button. A halted loop offers Resume,
  or Re-run checks when flaky; a task a gate holds offers Try now.
- The detail's side column shows the live session's activity line, not the agent's prose, and the
  last failing check output, or the passing commands once nothing fails. The digest shows only from
  sign-off on. The usage-limit head names the agent by its id.
- The Changes tab lists files and line counts parsed from the worktree's diff against its base;
  Review changes opens the review sheet.
- The judge is a per-task `Judge` profile override, picked in the loop editor. The agents dialog
  shows Iterations and Judging for a loop.
- The skills and MCP line counts the connection's library and the project's entries, not per agent.

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

Settled before phase 5 started:

- **`loop_blocked` halts after the turn.** The call records the reason. When the turn ends the
  daemon commits the work as a counted iteration, skips the checks, and halts the loop as
  `Blocked` with ball User and the reason in the thread. Answer and resume runs the next iteration
  with the user's answer as its steering note.
- **A loop's worker cannot edit its own task.** `get_task` from the worker leaves out the commands,
  sealed paths and hidden files, whatever id it names, and `update_task` on its own loop is
  refused, since it could move the card or edit the checks. `comment_task` still works.
- **`loop_propose_check` takes a label, a reason and an optional command.** The reason shows under
  the proposal, and the command prefills the Accept form. The user still picks the kind. A loop
  holds at most 3 pending proposals.
- **`loop_status` returns** the goal, the checks by label and state, iteration n of N, the budget
  left, the last failing output (cut as the prompt's is), and each judge check's last reason.
- **The MCP task tools carry** `run_mode`, the checks, the budgets, the setup command and the sealed
  paths, each sealed path checked against the base branch. The judge and the hidden files stay in
  the app. On a started loop `update_task` changes the budgets only, as in the app.
- **The waiting cap** is a number on the project's Agents settings page, default 2, 0 for no cap.
  It counts loop tasks with ball User; a gated loop has ball Agent and does not count. Only the
  drain obeys it: Start anyway on the queued card starts that loop now.
- **Drafts.** A task stores the name of the automation that created it and the run's number,
  which runs already keep frozen (`ordinal`). The card reads `DRAFT · from <automation> #n` while
  the task is in Planning, for any task an automation created, pipeline tasks too. The thread gets
  a note.

**As built** (`mcp_gateway.rs`, `assets/mcp-tools.json`, `scheduler.rs`, `pipeline_settings.rs`,
`loop_engine.rs`; the board in `src/components/kanban/loop/` and the task card):

- The three worker tools are task tools in the gateway, answered from the store with no window.
  A session is a loop's worker when its role meta says `LoopSession::Iteration(n)`, and the tools
  answer only while iteration `n` is the one running, so a session the loop has moved on from gets
  "iteration n is over". Any session of a loop, the judge's included, is that loop's own for
  `get_task` and `update_task`.
- `loop_blocked` writes its reason on the running iteration's row (`loop_iterations.blocked`).
  `finish` reads it: the work is committed as `chore(loop): iteration n`, the iteration's outcome is
  `Blocked` (counted, and neither a failure nor a stall), the loop halts as `LoopHalt::Blocked`, and
  the thread gets the question. A stop by the user still wins over it; a usage limit after the call
  does not. The next iteration's prompt carries the question above the user's answer.
- `loop_propose_check` stores the reason in the check's `detail` and the command in `command`; the
  kind is a guess (`Command` with a command, else `Judge`) that the Accept form lets the user
  change. The LOOP_PROTOCOL prompt names all three tools.
- The MCP loop fields take minutes, not seconds: `max_agent_minutes`, `check_timeout_minutes`.
  Checks given to `create_task` or `update_task` replace the list, pending proposals kept. A
  pipeline task becomes a loop through `update_task` with `run_mode: "Loop"`, which also sets its
  workspace to a new worktree.
- The daemon looks a creating session up in `automations.db` (`run_for_session`), so
  `handle_host_tool_call` takes the automation store too. The task records the automation's name
  and run number in `tasks.drafted_by` and `tasks.drafted_run`.
- The cap is `project_settings.loop_wait_cap` (default 2), read and written through
  `GetLoopWaitCap` and `SetLoopWaitCap`. While that many loops wait on the user, the drain drops
  queued loops without `execute_requested_at`; Execute, labelled Start anyway on such a card,
  stamps it or starts it at once. The board works out the same condition from the task list, auto
  mode and the cap (`loopsHeldBack` in `BoardActionsContext`), so the card's line needs no
  protocol field.
- The draft banner sits above the detail's tabs, so a loop draft, which opens on Loop, shows it
  too.

## Phase 5b: context and sandbox worktrees, Prepare loop

Decided on 2026-10-14, after phase 5, from trying loops in a dev instance. It replaces how a loop
uses git: the worker no longer works in the loop's own worktree, and the sealed files no longer go in
and out of it. The sections above describe phases 0 to 5 as built; this one supersedes them where
they differ, and "Sealed checks" is rewritten to match once it is built.

### Decisions (locked)

**Two worktrees per loop.**

- The **context** is the task's worktree, made by `prepare_task_workspace` like any task's. It holds
  the real branch, sealed files included, and is what is approved, merged or opened as a pull
  request.
- The **sandbox** is a second worktree the loop owns, with a non-cone sparse checkout that leaves the
  sealed paths out. The worker works only there. It is hidden from the Workspaces view and deleted
  when the loop ends.
- Each iteration resets the sandbox to the context's HEAD, the worker commits there, and the commit
  is fast-forwarded into the context. A reset keeps what git ignores, so build caches,
  `node_modules` and `.maestro/loop/PROGRESS.md` survive from one iteration to the next.
- The checks run in the context, where the sealed files simply exist. There is no sealed snapshot
  any more: the tests are the context's. Hidden files stay in the context, out of git.
- A merge back that fails (the context moved, or holds edits in the way) halts the loop with a new
  halt, `Conflict`, naming the files. The iteration's commit stays on the sandbox's branch.
- The peek check stays as it is: `git` commands naming a sealed path. The worker is never told the
  context exists, so every shell command is not scanned.

**A loop is new-worktree only, and its run mode is fixed at creation.**

- Create Task asks "How it runs" first, then the workspace. A loop offers only "Create new worktree",
  from a base branch or by checking out an existing branch. The repository directory and an
  existing worktree are not offered.
- "Make it a loop" goes away from pipeline tasks, and so does `update_task` with `run_mode` through
  MCP. A task's run mode is the one it was created with.

**Where the tests come from: a branch.**

- The normal way is to prepare the tests on a branch first, then create the loop from it, as its
  base branch or by checking it out. The checks run against that branch's files.
- Sealed paths that do not exist on the chosen branch are flagged in the loop editor.

**Prepare loop replaces Refine on a Planning loop.**

- An interactive session, like Refine, on the Refiner profile with a loop-specific prompt. No new
  role. (Changed after testing: it became the `Preparer` role, below.)
- It creates the loop's context worktree on demand and works in it, where the tests are visible. It
  may write and commit test files there, and it sets the checks, sealed paths and budgets through
  MCP `update_task`.
- The context it prepared is the loop's: iteration 1 starts from it, with its tests sealed out of
  the sandbox.
- The user ends it, reviews the loop editor, and queues the loop.

**As built** (`worktree.rs`, `loop_engine.rs`, `profiles.rs`, `task_prompt.rs`, the create dialog and
the card):

- The sandbox is `.maestro/worktrees/loop-<id>`, a detached worktree with no row, so the app's
  sweeps never take it and the Workspaces view filters it out (`is_loop_sandbox`).
  `prepare_task_workspace` brings it to the context's HEAD for the worker and the judge: work it
  holds that the context lacks is merged back first, then it is reset and sealed.
- `merge_back` tries a fast-forward, then a merge, and aborts a merge that fails. The iteration that
  hits one is recorded `Failed` with git's reason, and the loop halts as `Conflict`.
- The checks run in the context with the hidden files written under `.maestro/loop/sealed/` for the
  run. `loop_sealed_sha` and its column are gone; Re-run checks reads the context as it is.
- A sealed path, from the app, MCP or an accepted proposal, has to be committed in the context, or
  on the base branch before the context exists. The editor flags one that is not.
- The scheduler's one-minute tick removes every sandbox whose loop is not In Progress, which covers
  a loop that passed, was moved, or was deleted.
- Prepare loop is its own role, `Preparer`, with its own profiles in Settings (Preparation) and its
  own row in a loop's Agents dialog. It works a loop's `Refining` phase, which the refiner works on
  a pipeline task, so `task_restart::role` reads the phase with the run mode, and starting the other
  one of the two is refused. With no Preparation profile it runs on the project's default agent.
  It writes, in the context, with `PREPARE_PROTOCOL` and the loop as it stands. Its summary is the
  refinement's proposal, closed with Done preparing, which leaves the description alone.
- Iterations are their own role too, `Worker` (changed after testing, 2026-10-16), so a loop no
  longer shares Implementation profiles with pipeline tasks. It works `Iterating`; `begin` turns a
  loop started as the coder into its worker, since the app and the queue start every task as the
  coder, and refuses a worker on a pipeline task. It writes and gets the task's own agent and
  overrides, as the coder does; with no Building profile it runs on the project's default agent, and
  a judge with no profile runs on the worker's agent. Settings shows the profiles in two tabs,
  Pipeline (Refine, Plan, Implement, Review) and Loops (Prepare, then Build, the worker, and
  Judge in an Iteration box with an arrow looping out of it and back in). Each stage says what runs it, and
  opens below the row with one profile editor at a time.
- `TaskUpdate.run_mode` is gone from the protocol and the app; MCP `update_task` refuses a different
  run mode.
- Create Task sets nothing up for a loop: choosing Loop only locks the workspace to a new worktree,
  shown as a plain field with the reason rather than a dropdown with one choice. The loop is created
  with the default budgets and no checks, and is set up from its card, with Prepare loop or by hand
  in its details.

## Phase 6: docs

- `maestro-server/AGENTS.md`: a "Loops" section next to the pipeline's, covering the phases, the
  context and the sandbox, the merge back, the check runner and the gate.
- `src/AGENTS.md`: the loop card and view.
- The user docs on the website:
  - what a loop is, and when to use a pipeline instead,
  - where its tests come from: prepare them on a branch and start the loop from it, or use Prepare
    loop,
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
