# Fix: Compose bar resize observer not set up for existing sessions

## Context

When a user types multiline input in the compose bar while auto-scroll is active, the stream tail should stay visible. A ResizeObserver on the compose bar wrapper was added to handle this, but it only works for new sessions (that go through centered compose → docked transition). For existing sessions loaded with messages, the observer is never created because the `useEffect` dependency `[isCenteredCompose]` never changes (stays `false` throughout).

## Fix

**File:** `src/components/execution/AgentActivityPanel.tsx` (~line 481)

Change:
```tsx
}, [isCenteredCompose]);
```

To:
```tsx
}, [isReady, isCenteredCompose]);
```

This ensures the effect re-runs when `isReady` transitions from `false` to `true` (initialization completes → full DOM rendered → refs are set → observer created).

The `isReady` variable is already defined earlier in the component (`const isReady = !liveState.isInitializing`).

## Verification

1. `pnpm build` — type check passes
2. Run dev server, open an existing agent session with stream content
3. Click compose bar textarea, type Enter repeatedly to add lines
4. Stream tail should stay visible as compose bar grows (auto-scroll adjusts)
5. Also test: scroll up first, then type multiline — should NOT auto-scroll (respects user's scroll-up)
