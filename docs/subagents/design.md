# Native subagents: approved design

ACP schema 1.20 made subagent sessions stable. A client opts in with
`clientCapabilities.subagents: {}` at initialize; the agent then runs each subagent as a child
session of its own and reports it on the parent with `subagent_update` and `session_message`.
Maestro adopts that and drops the Claude-only path it uses today.

`mock.html` beside this file is the approved mock: a standalone copy of the canvas the design was
settled on. Where this document and the mock disagree, the mock wins on visuals and this document
wins on behaviour.

Approved on 2026-11-24.

## What the agents send

Observed with claude-agent-acp 0.108.1 and codex-acp 2.8.0 (probe script in `.maestro/probe/`).

|                         | Claude                                                    | Codex                                                  |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| Card source             | `subagent_update` on the parent, no `Task` tool call      | same                                                   |
| Title, description      | title, and the agent type as description                  | neither                                                |
| Prompt                  | `session_message` parent to child, in both transcripts    | `session_message` parent to child                      |
| Report                  | hand-back `session_message` child to parent               | the child's `agent_message_chunk` text                 |
| Child tool calls        | under the child session id                                | same                                                   |
| Child config            | agent type, model, mode as `config_option_update`         | model and effort                                       |
| Child usage             | none                                                      | `usage_update` (child context only)                    |
| Cancel capability       | granted while running                                     | granted while running, `cancel: null` once idle        |
| After the subagent ends | `idle`                                                    | `idle`, then `unknown` after the parent's `closeAgent` |
| Background subagent     | outlives the parent turn                                  | not observed                                           |
| `session/load`          | replays each child transcript, then a fresh idle snapshot | not probed                                             |

Without the capability Claude keeps today's shape (a `Task` tool call, child tool calls flattened
into the parent with `_meta.claudeCode.parentToolUseId`, a `SubagentHandback` tool call) and Codex
shows three bare `spawnAgent`, `wait`, `closeAgent` rows.

## Rules from the spec Maestro must keep

- Never load, prompt, close, set the mode of or set a config option on a child. `session/cancel`
  is the only request sent to a child, and only while its latest state grants `cancel`.
- Answer a child's permission requests, elicitations and terminal requests.
- A child's `config_option_update`, `current_mode_update` and `usage_update` describe the child
  only. They never change the parent's model picker, mode, context gauge or recorded usage.
- The root session's cost already includes its descendants; never add a child's cost to it.
- Capabilities and state replace the stored value whole; the other `subagent_update` fields are
  patches.
- After `session/load`, discard child capabilities and state. A replayed snapshot grants nothing.
- Tool call ids are unique per session only, so a child tool call is keyed by its session id and
  its tool call id.

## maestro-server

- Declare `subagents: {}` next to `plan` in `connection.rs`.
- Record each child session id from `subagent_update` against its parent's Maestro session
  (nested children against the same root). Notifications, permission requests, elicitations and
  terminal requests on a child id go to the root's Maestro session with the child id kept in the
  payload, instead of today's `session_not_found`.
- Child `usage_update` and config updates are forwarded for the card but kept out of
  `usage_store` and the turn tracker.
- A cancel command takes an optional child session id and sends `session/cancel` to it.

## Busy while subagents work

A session counts as working while its parent turn runs or any child is `running` or
`requires_action`. That one rule drives:

- the idle reaper, which leaves the session alone (closing it would cancel the children);
- the board and session list, which show the session as working;
- the task pipeline, which treats a turn as ended only once the parent turn has ended and every
  child is idle.

**The composer stays usable.** While only children work, the parent turn is over, so the user can
send a prompt at once. It starts a normal new turn; it is not queued behind the children. The
header reads `Working · 1 subagent` and the composer's send button is enabled.

## The card

`SubagentCard` keeps its layout and sections. What feeds each part:

- **Name.** The update's `title`. Codex sends none: the first line of the prompt, cut to 60
  characters. Last resort `Subagent`.
- **Pills.** Model from the child's `model` config option; agent type from its `agent` option,
  omitted when it is `default`.
- **Status pill.**

  | State                         | Pill                                                                     |
  | ----------------------------- | ------------------------------------------------------------------------ |
  | `running`                     | Running (accent). Turns into Stop on card hover when `cancel` is granted |
  | `requires_action`             | Needs you (amber); the card border turns amber                           |
  | `idle`, `cancelled`           | Stopped (warning)                                                        |
  | `idle` with `error`           | Failed (destructive), the error message as the sub line                  |
  | `idle`, any other stop reason | Done (success)                                                           |
  | `unknown`                     | The last outcome Maestro saw; `Unknown` (muted) only when it saw none    |

- **Stop.** Sends `session/cancel` to the child. The sub line reads `Stopping…` until the child
  reports `idle`. Shown for foreground and background subagents alike; never after a reload until
  a live update grants `cancel` again.
- **Sub line while running.** Checklist progress (`2/4 Reading token refresh path`) when the child
  has a plan, typing dots otherwise.
- **Stats once ended.** `1m 12s · 6 tool calls`, and under it the breakdown by kind
  (`3 reads · 2 searches · 1 bash · 1 edit`). The elapsed time is shown only when Maestro saw the
  run start and end live. No tokens: Claude sends none per subagent, and Codex's context figure is
  not shown.
- **Sections.** Prompt, Checklist, Tool Calls (the child's), Report.
- **Nesting.** A subagent started by a subagent is a card inside its parent's card, below the
  sections.
- **Approvals.** A child's permission request takes the composer's place like any other, labelled
  `Subagent · <name>` above the question. See "Several requests at once".

## Several requests at once

Today the panel holds one pending request and a new one replaces it: the daemon keeps them all,
but the agent behind a replaced request stays blocked, unseen, until the session is reattached.
Parallel Claude subagents already reach this; native subagents make it common. Approved on
2026-11-24: a queue.

- Permission requests and elicitations form one list per session, oldest first.
- One request is shown at a time, in the composer's place as today. Every request names who asked:
  `Main agent` or `Subagent · <name>`.
- With more than one waiting, the source line ends in a pager: `‹ 1 of 3 ›`. The arrows change
  which request is shown; answering one shows the next.
- Clicking a `Needs you` card shows that subagent's request.
- A request whose subagent stops or finishes leaves the list, answered `cancelled` by the daemon.
- The composer stays hidden while the list is not empty, as today.
- Plan reviews and the plan-revision path (`useMessageSender`) act on the request shown.

Codex's `wait` and `closeAgent` rows stay in the stream and carry a chip with the subagent's
name (`⇢ Count lines in all files`) that scrolls to and expands its card.

## Removed

The Claude-only path goes: `parentToolUseId` flattening, the `SubagentHandback` tool, the
`TaskStop` prompt (`subagent-stop.ts`), and the held-turn handling for background subagents in
`AgentActivityPanel` (`backgroundRunning`). Claude replays old sessions natively once the flag is
on, so nothing is left that needs it.

## Boolean config options

Separate commit. Declare `session.configOptions.boolean: {}`. Claude then reports Fast mode as a
`boolean` option rather than an off/on select. The compose bar shows a boolean option as a small
switch with its name; clicking it sends `session/set_config_option` with `type: "boolean"`.
Config values in the frontend become `string | boolean`.
