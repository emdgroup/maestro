---
created: 2026-02-15T22:48
title: Fix SSH connection password prompt workflow
area: ui
files:
  - src/components/RemoteConnectionForm.tsx
  - src/components/PasswordModal.tsx
  - src/components/RemoteProjectsList.tsx
---

## Problem

When adding a new SSH connection that requires password authentication, the app exhibits incorrect flow behavior:

1. User initiates SSH connection addition
2. Connection requires password input (should show password modal)
3. **BUG**: App immediately shows the recent project list instead of waiting for password input
4. Connection fails silently because password was never provided
5. User must close and restart the app
6. User selects the previously added (but incomplete) SSH connection
7. Only then does the password modal appear correctly

This broken flow creates a confusing UX where the user thinks the connection succeeded (because the project list appeared), but it actually failed. The password prompt should appear immediately during the connection flow, not after a restart.

**Secondary issue**: The "reveal password" icon in the password modal should use `text-accent` color for visual consistency with the rest of the app's accent color theming.

## Solution

1. **Fix async flow**: Investigate the connection initiation logic in `RemoteConnectionForm.tsx`
   - Ensure the password modal is awaited before proceeding to project list
   - Connection flow should be: initiate → password prompt (if needed) → validate → show projects
   - Likely issue: Promise not being awaited or password check happening after UI transition

2. **Password modal improvements**:
   - Update the "reveal password" icon/button to use `text-accent` class
   - Verify modal appears before any navigation to project list
   - Check if modal state is properly managed during connection flow

3. **Investigation areas**:
   - Check IPC calls for SSH connection (`add_ssh_connection` or similar)
   - Review state management between RemoteConnectionForm and PasswordModal
   - Verify password requirement detection happens before showing project list
   - Look for race conditions in async connection handling
