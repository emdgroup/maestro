---
status: partial
phase: 62-task-detail-screen
source: [62-VERIFICATION.md]
started: 2026-05-27T14:30:00Z
updated: 2026-05-27T14:30:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Locked banner text
expected: Banner text reads "Task is locked. Click Interrupt to unlock." (ROADMAP SC2) OR "Read-only — task is {status}" (implementation). Confirm which is acceptable.
result: [pending]

### 2. Interrupt button scope
expected: ROADMAP SC3 says visible when status ≠ Backlog. Implementation (CONTEXT.md D-02) shows visible only when status=InProgress. Confirm CONTEXT.md supersedes ROADMAP here.
result: [pending]

### 3. Navigate to full-screen detail
expected: Clicking a task card navigates to TaskDetailScreen (full-screen, not modal overlay); close button returns to board
result: [pending]

### 4. Inline editing (Backlog only)
expected: Title and description are contenteditable when status=Backlog; read-only with locked banner when status is anything else; saves on blur
result: [pending]

### 5. Attachment upload
expected: In Backlog status, drag-drop and file picker work; uploaded file appears in list; remove button calls remove_task_attachment
result: [pending]

### 6. Interrupt modal + ACP resume
expected: Interrupt button (InProgress) opens three-choice modal; Resume sends ACP prompt; Rework calls interrupt_task; Cancel Task calls cancel_task
result: [pending]

## Summary

total: 6
passed: 0
issues: 0
pending: 6
skipped: 0
blocked: 0

## Gaps
