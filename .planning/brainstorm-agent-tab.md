# Agent Tab Brainstorm
_Started: 2026-03-26 — not yet discussed_

---

## Context

The Agent Tab is a dedicated view for monitoring and interacting with active agents.
It is referenced from the Tasks tab in two ways:
- "⚠ Waiting for input" on an InProgress card links to the specific waiting agent here
- Max concurrent agents is configured here

---

## Still To Discuss

### Agent List
- [ ] What does each row show? (task name, agent status, elapsed time, …)
- [ ] Click row → opens terminal/detail panel?

### Terminal / Chat Panel
- [ ] Pure terminal stream, or split with chat input at bottom for waiting agents?
- [ ] How is input submitted when agent is waiting?

### Waiting Agent Highlight
- [ ] Badge on list row only, or waiting agents sorted to top, or both?
- [ ] How does the deep-link from the Kanban card navigate to the specific agent?

### Max Concurrent Agents
- [ ] Number input in Agent Tab action bar, or in Settings with display here?

---

## Open Questions

- Does the Agent Tab show only active agents (InProgress), or also recently finished/failed ones?
- Can the user send a message to a running (non-waiting) agent, or only when it's in waiting state?

---

## Ideas for Later (not core, deferred)

- Agent history log per task — replay output from a previous run
