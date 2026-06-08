# Add pending state to review confirm buttons

## Context

The review approval modal (`ApproveModal`) has no loading/pending state on its confirm button. Users can double-click during async operations. The same issue exists in `ReworkModal` and `DiscardModal`. Established codebase pattern (e.g., `DeleteWorktreeDialog`, `SpawnSessionDialog`, `CreateTaskModal`) uses `isPending` from TanStack Query mutations to disable buttons and show loading text.

## Plan

### 1. TaskReviewPanel — extract `isPending` from mutations

**File:** `src/components/execution/diff/TaskReviewPanel.tsx` (lines 111-114)

Extract `isPending` from each mutation hook and pass to modals:

```tsx
const { mutate: approveAndMerge, isPending: isApproving } = useApproveTaskAndMergeMutation();
const { mutate: rejectReview, isPending: isRejecting } = useRejectReviewMutation();
const { mutate: requestChanges, isPending: isRequestingChanges } = useRequestChangesMutation();
const { mutate: saveReview, isPending: isSaving } = useSaveTaskReviewMutation();
```

Combine for approve flow (save + merge are chained): `const isApproveFlowPending = isSaving || isApproving`

Pass `isPending` prop to each modal component.

### 2. ReviewConfirmModals — add `isPending` prop to all three modals

**File:** `src/components/execution/diff/ReviewConfirmModals.tsx`

For each modal:
- Add `isPending?: boolean` to props interface
- Disable confirm/action button: `disabled={isPending}`
- Show loading text: `{isPending ? "Approving..." : "Confirm"}` (adjust label per modal)
- Disable cancel button while pending
- Prevent dialog close while pending (onOpenChange guard)

Specific labels:
- ApproveModal: "Approving..." 
- ReworkModal: "Submitting..."
- DiscardModal: "Discarding..."

### Files to modify

1. `src/components/execution/diff/TaskReviewPanel.tsx` — extract isPending, pass to modals
2. `src/components/execution/diff/ReviewConfirmModals.tsx` — consume isPending in all three modals

### Verification

1. `pnpm build` — type check passes
2. `pnpm tauri:dev` — open a task review, click approve, verify button shows "Approving..." and is disabled during the operation
3. Test rework and discard flows similarly
