# Home dashboard: implementation plan

The design is `design.md` (frozen 2026-10-04) and `mock.html`. This file records how it is built and
the technical decisions taken with the user on 2026-10-05. Phases are committed separately on
`maestro/project-dashboard-197`.

## Decisions

- **Which projects a panel lists:** the projects the connection's server has data for (tasks,
  sessions or automations), plus this app's recent projects on that connection. A project opened
  only from another machine therefore appears too; opening it registers it in this app's database.
- **A failed connect** (the server busy with another build, missing tools) is shown inside the
  connection's panel as one more state, with the actions `PreflightModal` offers today: `Update
anyway`, `Test and use path`, `Continue anyway`. `PreflightModal` goes away.
- **Rename is SSH only for now.** The pencil shows on SSH panels only, because WSL and container
  connections have no name of their own and giving them one needs a schema change. This narrows
  `design.md`, which shows the pencil on every connection but This computer.
- **Freshness:** the board refetches a connection's summary on the pushes the server already sends
  (`tasks-changed`, `automation-run-changed`, `project-locks-changed`) and every 5 seconds while Home
  is visible. There is no new push message.

## Phases

1. **Server summary.** A `ServerRequest::HomeSummary` answered in one round trip with the server's
   status (version, start time, running automations) and one entry per project: task counts by
   status, agents mid-turn, whether it needs the user and the text of the first blocking prompt,
   the running automations' names, and the lock holder. Answered from data the server already holds;
   no new table. `PROTOCOL_VERSION` goes from 11 to 12. On the app side a `get_home_summary`
   command maps entries back to this app's project ids by path.
2. **Connections stay attached.** Going back to Home releases the project lock but no longer drops
   the relays to the connections' servers; they live until the app closes. Home attaches to This
   computer on start, to the others on `Connect`. `Restart server` is stop, then attach.
3. **Home screen.** `src/views/home/` replaces `src/views/project-picker/` as what `App.tsx` shows with
   no project: hero, the Add a connection and Integrations panels, one panel per connection with its
   states, tiles, minimized chips, the connection menu and its confirmations. The glass recipes go
   into `src/index.css`. Opening a project (prime, startup tab, not-a-git-repo prompt, takeover) moves
   out of `ProjectList` into one hook every entry point shares. The dialogs are the existing ones
   restyled.
4. **Integrations panel.** Provider tiles, hover and pinned cards, details sheet, add flow, over the
   existing integration services and dialogs.
5. **Cleanup and checks.** The picker's leftovers are deleted, unit tests and the E2E smoke test are
   updated, and a dev instance is run against This computer and one SSH host.
