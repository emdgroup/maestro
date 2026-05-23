# Fix SSH Reconnection Backoff for Network Transitions

## Context

User switches from ethernet to wifi → SSH connection drops. The reconnection retries complete before the machine has time to connect to wifi (reported: all 5 retries in <10s). The backoff should wait long enough for the new network to come up.

## Analysis

The heartbeat retry loop (line 1014, `spawn_heartbeat_task`) has delays of 1s, 2s, 4s, 8s, 16s (31s total). The math looks correct, BUT:

**Root cause: `open_handle()` has NO connect timeout (line 240-253).**

`russh::client::connect()` calls TCP connect with no timeout wrapper. Behavior depends entirely on OS routing state during network transition:

- **Route removed instantly** (ENETUNREACH): `connect()` fails in microseconds → only the sleep delays matter → all 5 retries burn through in ~31s of sleeping. Each connect fails so fast it's barely noticeable.
- **Route lingers** (stale gateway): `connect()` hangs for OS TCP SYN timeout (20-127s per attempt).

In the user's case (ethernet→wifi), the OS likely drops the route immediately when the cable disconnects, so each connect attempt fails instantly. The sleep delays (1+2+4+8+16=31s) are all that separate the attempts. The wifi handover (association + DHCP + route) typically takes 15-60 seconds — the retry window might not be enough, or the user may have perceived 31s as "very fast" relative to their expectation.

**Secondary issue:** Even if total sleep = 31s, the first 3 attempts (1s+2s+4s = 7s total) are almost certainly wasted since wifi can't possibly be ready that fast. The backoff starts too short.

## Fix

### 1. Add connect timeout to `open_handle()` (critical)

Wrap `client::connect` in a 10-second timeout. Without this, behavior is unpredictable — could be instant or could be 2+ minutes per attempt.

```rust
async fn open_handle(host: &str, port: u16) -> Result<Handle<SshClientHandler>, SshError> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });
    let addr = format!("{}:{}", host, port);
    tokio::time::timeout(
        Duration::from_secs(10),
        client::connect(config, addr.as_str(), SshClientHandler),
    )
    .await
    .map_err(|_| SshError::ConnectionError(format!(
        "Connection to {}:{} timed out", host, port
    )))?
    .map_err(|e| SshError::ConnectionError(format!(
        "Failed to connect to {}:{}: {}", host, port, e
    )))
}
```

### 2. Increase backoff delays for network transitions

Change from `1s, 2s, 4s, 8s, 16s` (31s total) to `3s, 6s, 12s, 24s, 45s` (90s total). This gives wifi ample time to come up. The first attempt at 3s is still quick enough for transient blips; the total window of 90s covers even slow DHCP leases.

```rust
// In spawn_heartbeat_task retry loop:
let max_attempts: usize = 5;
const DELAYS_SECS: [u64; 5] = [3, 6, 12, 24, 45];

for attempt in 1..=max_attempts {
    // ... emit event ...
    let delay = Duration::from_secs(DELAYS_SECS[attempt - 1]);
    tokio::time::sleep(delay).await;
    // ... connect attempt ...
}
```

### 3. Clean up dead `Reconnecting` arm in `reconnect_if_needed` (minor)

The `Reconnecting` arm (lines 729-750) uses millisecond-scale delays (100ms-1600ms) and a shared `reconnect_attempts` counter, but this arm is only reachable if the heartbeat has already set state to `Reconnecting` and a concurrent IPC call enters `reconnect_if_needed` during the heartbeat's retry loop. This is a secondary path that can burn through attempts too fast. Remove it and let the heartbeat be the sole reconnection authority — on-demand callers seeing `Reconnecting` should wait (like the `Connecting` arm already does).

```rust
SshConnectionState::Reconnecting => {
    // Heartbeat is handling reconnection — wait for it
    drop(state);
    let mut attempts = 0;
    while {
        let s = *self.state.lock().await;
        s == SshConnectionState::Reconnecting || s == SshConnectionState::Connecting
    } && attempts < 100
    {
        tokio::time::sleep(Duration::from_millis(500)).await;
        attempts += 1;
    }
    if self.is_connected().await {
        Ok(())
    } else {
        Err(SshError::ConnectionError("Reconnection failed".to_string()))
    }
}
```

## Files to Modify

- `src-tauri/src/ssh/session.rs`:
  - `open_handle()` — add 10s connect timeout (line 240-253)
  - `spawn_heartbeat_task` retry loop — increase delays (line 1022)
  - `reconnect_if_needed()` `Reconnecting` arm — replace ms-backoff with wait-for-heartbeat (line 729-750)

## Verification

1. `cd src-tauri && cargo check` — compiles
2. `cargo test` — passes
3. Manual: connect SSH, unplug ethernet, observe retry timing in UI — should see ~3s, 6s, 12s, 24s, 45s gaps between attempts (90s total window)
