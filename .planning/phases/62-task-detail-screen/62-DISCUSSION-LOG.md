# Phase 62: Task Detail Screen - Discussion Log

**Date:** 2026-05-27

## Areas Discussed

### 1. Editable Fields Scope
**Q:** Which fields are shown/editable in the detail screen, and when?
**A:** All fields editable when status = Backlog. All fields read-only for any other status. No exceptions.

### 2. Screen Layout
**Q:** How does the full-screen compose — action bar, main content, sidebar?
**A:** (User provided full layout spec)
- Action bar: title (truncated) + Improve (stub) + Interrupt (InProgress only) + Execution (InProgress/Review) + Delete/Archive + ✕
- Main content: seamless contenteditable title, seamless contenteditable description, attachments list + dropzone (dropzone hidden when locked)
- Right sidebar: status dropdown + Priority, Agent, Base Branch, Labels, Auto-approve, Worktree type

### 3. Status Change Restrictions
**Q:** All transitions free, or enforce state-machine flows?
**A:** User can only toggle Backlog ↔ Ready. All other transitions are automatic via system events.

### 4. Interrupt Confirmation
**Q:** Confirm dialog first, or immediate? What do the post-interrupt choices do?
**A:** InProgress only. Confirmation modal with three choices:
- Resume: sends "resume" prompt to agent (un-interrupts)
- Rework: moves task to Backlog
- Cancel: archives task as cancelled

**Clarification on Interrupt visibility:** Layout spec said "status ≠ Backlog"; user clarified → InProgress only.

### 5. Agent Required Gate (deferred from Phase 61 D-04)
**Q:** Enforce agent_id before Backlog→Ready?
**A:** Yes. Must have agent assigned (agent + model) before marking Ready.
