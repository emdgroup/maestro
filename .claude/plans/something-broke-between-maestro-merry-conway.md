# Fix: ACP handshake failure + zombie cleanup loop

## Context

Commit `063f2b3` ("Add protocol handshake, extract RPC helpers, and clean up stores") introduced two bugs:

1. **Zombie cleanup infinite loop** — `cleanupZombiesMutation` added to useEffect deps in `App.tsx`. TanStack Query's `useMutation()` returns new object ref every render → effect re-fires → mutation triggers re-render → infinite loop.

2. **Handshake failure** — The handshake protocol was added to both `maestro` (client) and `maestro-server` in the same commit. The code itself is correct and symmetric (both use `maestro_protocol::write_message`/`read_message`). **Most likely cause: stale `maestro-server` binary on PATH** that predates the handshake. Old binary expects `Spawn` as first message, gets `Handshake` instead, sends `Error("expected Spawn...")` or crashes → client gets "did not respond with HandshakeOk".

## Fix 1: Zombie cleanup loop (code change)

**File:** `src/App.tsx` line 112

Remove `cleanupZombiesMutation` from useEffect deps:

```typescript
// Before (broken):
}, [currentProject?.id, cleanupZombiesMutation]);

// After (fixed):
// biome-ignore lint/correctness/useExhaustiveDependencies: mutation object is unstable ref
}, [currentProject?.id]);
```

## Fix 2: Handshake failure (rebuild)

Rebuild and reinstall `maestro-server`:

```bash
cd maestro-server && cargo build --release
# Then ensure the new binary is on PATH
```

No code fix needed — protocol implementation is correct. The old binary on PATH just doesn't have the handshake handler.

## Verification

1. Start app → zombie cleanup fires once (not looping). Check browser console for repeated `clean_up_zombie_worktrees` calls.
2. Spawn an agent → handshake succeeds → session starts normally.
