//! Resident mode, and the relay that reaches it.
//!
//! `maestro-server daemon` is one server per machine, distro or container, outliving the app that
//! started it so an agent session survives the window closing. `maestro-server attach` is what the
//! app actually spawns: a byte relay from its own stdin and stdout to the daemon's loopback socket,
//! which is why none of the four transports the host already has — local child, SSH exec channel,
//! `wsl.exe`, `docker exec` — needed changing to reach it.
//!
//! ```text
//! app ──spawns child──▶ maestro-server attach ──TCP loopback + token──▶ maestro-server daemon
//!                       (dies with the app)                             (resident)
//! ```
//!
//! Two files in the daemon directory decide whether a daemon is alive here. `lock` is held open by
//! the running daemon for its whole life, so the OS releases it on death; `runtime.json` says how
//! to reach it. The lock is the authority: a killed daemon leaves its runtime file behind pointing
//! at a dead port, and only the lock can tell that apart from a live one.

use fs2::FileExt;
use maestro_protocol::{
    DaemonRuntime, DAEMON_DIR_DEFAULT, DAEMON_DIR_ENV, DAEMON_LOCK_FILE, DAEMON_RUNTIME_FILE,
    PROTOCOL_VERSION,
};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// Sent by a client after its token to say what it wants. Read as plain lines before any framing,
/// so it keeps working against a daemon speaking a protocol version this binary does not.
const MODE_ATTACH: &str = "ATTACH";
const MODE_SHUTDOWN: &str = "SHUTDOWN";

/// How long to wait for a daemon we asked to exit to release its lock.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(5);
/// How long to wait for a daemon we just started to publish its runtime file.
const STARTUP_WAIT: Duration = Duration::from_secs(10);

/// Where the lock and runtime files live.
///
/// The host sets `MAESTRO_DAEMON_DIR` for a local connection so a development build pointed at its
/// own `MAESTRO_DATA_DIR` gets its own daemon instead of contending with the installed app. On a
/// remote machine there is no such directory and the home-relative default applies, which means
/// one daemon per machine whichever build reached it.
pub(crate) fn dir() -> Result<PathBuf, String> {
    if let Some(custom) = std::env::var(DAEMON_DIR_ENV)
        .ok()
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return Ok(custom);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "cannot resolve home directory".to_string())?;
    Ok(Path::new(&home).join(DAEMON_DIR_DEFAULT))
}

fn read_runtime(dir: &Path) -> Option<DaemonRuntime> {
    let bytes = std::fs::read(dir.join(DAEMON_RUNTIME_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Open the lock file, creating the directory if needed.
fn open_lock(dir: &Path) -> Result<std::fs::File, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{} is unusable: {e}", dir.display()))?;
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(DAEMON_LOCK_FILE))
        .map_err(|e| format!("cannot open daemon lock: {e}"))
}

/// True while a daemon holds the lock.
///
/// Taking the lock and immediately dropping it is the only portable way to ask, and it is safe:
/// a caller that wins the race here is about to start a daemon that takes it properly, and one
/// that loses learns exactly what it needed to know.
fn daemon_is_running(lock: &std::fs::File) -> bool {
    match lock.try_lock_exclusive() {
        Ok(()) => {
            if let Err(e) = fs2::FileExt::unlock(lock) {
                crate::send_diag(
                    "warn",
                    format!("[daemon] could not release the probe lock: {e}"),
                );
            }
            false
        }
        Err(_) => true,
    }
}

// --- daemon mode ---

/// Run as the resident server. Returns as soon as another daemon already holds the lock.
pub(crate) async fn run_daemon() -> Result<(), String> {
    let dir = dir()?;
    let lock = open_lock(&dir)?;
    if lock.try_lock_exclusive().is_err() {
        // Lost the race. The winner's runtime file is what clients will use.
        return Ok(());
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("cannot bind daemon listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("cannot read daemon port: {e}"))?
        .port();
    let token = uuid::Uuid::new_v4().to_string();

    write_runtime(
        &dir,
        &DaemonRuntime {
            port,
            token: token.clone(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: PROTOCOL_VERSION,
            pid: std::process::id(),
        },
    )?;

    let result = crate::run_resident(listener, token).await;

    // Best effort: a crash leaves this behind, which is exactly why the lock and not this file is
    // what says whether a daemon is alive.
    if let Err(e) = std::fs::remove_file(dir.join(DAEMON_RUNTIME_FILE)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            crate::send_diag(
                "warn",
                format!("[daemon] could not clear the runtime file: {e}"),
            );
        }
    }
    drop(lock);
    result
}

/// Publish the runtime file, writing beside it and renaming so a client never reads half of one.
fn write_runtime(dir: &Path, runtime: &DaemonRuntime) -> Result<(), String> {
    let body =
        serde_json::to_vec_pretty(runtime).map_err(|e| format!("cannot encode runtime: {e}"))?;
    let tmp = dir.join(format!("{DAEMON_RUNTIME_FILE}.{}", std::process::id()));
    std::fs::write(&tmp, &body).map_err(|e| format!("cannot write runtime file: {e}"))?;
    std::fs::rename(&tmp, dir.join(DAEMON_RUNTIME_FILE))
        .map_err(|e| format!("cannot publish runtime file: {e}"))
}

/// Serve one client for as long as it stays connected.
///
/// Returns `true` when the client asked the daemon to shut down. Everything else — a bad token, a
/// protocol mismatch, a dropped connection — returns `false`, because none of them is a reason for
/// a resident server to stop serving the sessions it is already running.
pub(crate) async fn serve_client(
    stream: TcpStream,
    token: &str,
    sink: &crate::ClientOut,
    msg_tx: &tokio::sync::mpsc::Sender<Result<maestro_protocol::MaestroRpcMessage, String>>,
) -> bool {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    let mut line = String::new();
    if reader.read_line(&mut line).await.is_err() || line.trim() != token {
        crate::send_diag("warn", "[daemon] rejected a client with a bad token");
        return false;
    }
    line.clear();
    if reader.read_line(&mut line).await.is_err() {
        return false;
    }
    match line.trim() {
        MODE_SHUTDOWN => {
            crate::send_diag("info", "[daemon] shutdown requested by a client");
            return true;
        }
        MODE_ATTACH => {}
        other => {
            crate::send_diag("warn", format!("[daemon] unknown client mode {other:?}"));
            return false;
        }
    }

    // Handshake before the sink is attached, so a client of the wrong protocol version never
    // receives a byte of session traffic.
    let first = match read_framed(&mut reader).await {
        Ok(msg) => msg,
        Err(_) => return false,
    };
    let client_version = match first {
        maestro_protocol::MaestroRpcMessage::Request(
            maestro_protocol::ServerRequest::Handshake(req),
        ) => req.protocol_version,
        _ => {
            reject(
                &mut write_half,
                "expected Handshake as first message".to_string(),
            )
            .await;
            return false;
        }
    };
    if client_version != PROTOCOL_VERSION {
        reject(
            &mut write_half,
            format!(
                "protocol version mismatch: server={PROTOCOL_VERSION}, client={client_version}"
            ),
        )
        .await;
        return false;
    }
    if write_framed(
        &mut write_half,
        &maestro_protocol::MaestroRpcMessage::Response(
            maestro_protocol::ServerResponse::HandshakeOk(maestro_protocol::HandshakeResponse {
                protocol_version: PROTOCOL_VERSION,
            }),
        ),
    )
    .await
    .is_err()
    {
        return false;
    }

    sink.lock().await.attach(Box::new(write_half));
    crate::send_diag("info", "[daemon] client attached");

    loop {
        // Converted before the match so nothing from the protocol's boxed error, which is not
        // `Send`, is alive across the send below — this whole loop runs in a spawned task.
        let read = read_framed(&mut reader).await;
        match read {
            Ok(msg) => {
                if msg_tx.send(Ok(msg)).await.is_err() {
                    return false;
                }
            }
            // The client is gone, or sent something unreadable. Either way this connection is
            // over; the sessions it started are not.
            Err(_) => return false,
        }
    }
}

/// Tell a client why it is being turned away, then let the caller drop the connection.
///
/// A client that cannot even be told this is one that has already gone, so the failure is
/// recorded and nothing else is done about it.
async fn reject<W: tokio::io::AsyncWrite + Unpin>(writer: &mut W, message: String) {
    crate::send_diag("warn", format!("[daemon] rejected a client: {message}"));
    if let Err(e) = write_framed(writer, &crate::helpers::error_response(message)).await {
        crate::send_diag(
            "debug",
            format!("[daemon] could not send the rejection: {e}"),
        );
    }
}

/// `read_message` with its boxed error flattened to a `String`.
///
/// The protocol's error type is not `Send`, and every caller here runs inside a spawned task, so
/// it must not survive the call.
async fn read_framed<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<maestro_protocol::MaestroRpcMessage, String> {
    maestro_protocol::read_message(reader)
        .await
        .map_err(|e| e.to_string())
}

async fn write_framed<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    msg: &maestro_protocol::MaestroRpcMessage,
) -> Result<(), String> {
    let mut buf: Vec<u8> = Vec::new();
    maestro_protocol::write_message(&mut buf, msg)
        .await
        .map_err(|e| e.to_string())?;
    writer.write_all(&buf).await.map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())
}

// --- attach mode ---

/// Relay this process's stdin and stdout to the daemon, starting it if it is not running.
///
/// Reconnects with backoff when the daemon dies under us: a resident process that goes away is a
/// failure the app should survive, and the next connection starts a fresh daemon. Ends when our
/// own stdin closes, which is the app telling us it is done.
pub(crate) async fn run_attach() -> Result<(), String> {
    let dir = dir()?;
    let mut backoff = Duration::from_secs(1);

    loop {
        let stream = connect(&dir).await?;
        let (mut read_half, mut write_half) = stream.into_split();
        let mut stdin = tokio::io::stdin();
        let mut stdout = tokio::io::stdout();

        let up = async {
            tokio::io::copy(&mut stdin, &mut write_half).await.ok();
        };
        let down = async {
            tokio::io::copy(&mut read_half, &mut stdout).await.ok();
        };

        tokio::select! {
            // Our stdin closed: the app is gone and so are we. The daemon keeps running.
            _ = up => return Ok(()),
            // The daemon went away. Reconnect, which starts a new one if needed.
            _ = down => {}
        }

        if stopped_on_purpose(&dir).await {
            // Asked to stop, by the user or by an update. Starting another would undo exactly
            // that, so the app is told the way it is told of any server ending: the pipe closes.
            return Ok(());
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

/// Whether a daemon that just dropped us exited cleanly rather than crashed.
///
/// A clean exit clears its runtime file before releasing the lock; a crash releases the lock and
/// leaves the file. A daemon still holding the lock after the wait is alive and merely dropped
/// this connection, which is a reason to reconnect, not to stop.
async fn stopped_on_purpose(dir: &Path) -> bool {
    let Ok(lock) = open_lock(dir) else {
        return false;
    };
    wait_for(SHUTDOWN_WAIT, || !daemon_is_running(&lock))
        .await
        .is_ok()
        && read_runtime(dir).is_none()
}

/// Connect to the daemon for this environment, starting or replacing it as needed.
async fn connect(dir: &Path) -> Result<TcpStream, String> {
    let lock = open_lock(dir)?;

    if daemon_is_running(&lock) {
        match read_runtime(dir) {
            Some(runtime)
                if runtime.version == env!("CARGO_PKG_VERSION")
                    && runtime.protocol_version == PROTOCOL_VERSION =>
            {
                return open(runtime.port, &runtime.token, MODE_ATTACH).await;
            }
            // A daemon from another build of Maestro. Retire it and start ours: two servers on one
            // machine cannot both hold the lock, and the sessions it carries are not ours to
            // resume across a protocol change anyway.
            Some(runtime) => {
                // A daemon whose port no longer answers is one already on its way out, so the
                // wait below is the real test either way.
                if let Err(e) = open(runtime.port, &runtime.token, MODE_SHUTDOWN).await {
                    crate::send_diag(
                        "debug",
                        format!("[attach] could not ask the old daemon to stop: {e}"),
                    );
                }
                wait_for(SHUTDOWN_WAIT, || !daemon_is_running(&lock))
                    .await
                    .map_err(|_| {
                        format!(
                            "a maestro-server {} is running and did not stop when asked",
                            runtime.version
                        )
                    })?;
            }
            // The lock is held but nothing published a runtime file. A daemon is mid-startup;
            // waiting is cheaper than fighting it.
            None => {
                wait_for(STARTUP_WAIT, || read_runtime(dir).is_some())
                    .await
                    .map_err(|_| {
                        "a maestro-server started but never became reachable".to_string()
                    })?;
            }
        }
    }

    // A daemon that was killed rather than stopped leaves its runtime file behind, and a file that
    // already exists satisfies the wait below at once — pointing at a port nobody listens on. The
    // app's handshake timed out on that every time a daemon had been killed, and the retry then
    // found the file the new daemon had written meanwhile. Waiting for a different token rather
    // than deleting the stale file: another attach may have started a daemon since the lock check.
    let stale = read_runtime(dir).map(|runtime| runtime.token);
    drop(lock);
    start_daemon().await?;
    let runtime = wait_for_runtime(dir, stale.as_deref()).await?;
    open(runtime.port, &runtime.token, MODE_ATTACH).await
}

/// Start a daemon that outlives us.
///
/// Deliberately not `kill_on_drop`: the whole point is a server that survives the process that
/// started it. Its standard streams go nowhere, so it holds no pipe belonging to the app.
async fn start_daemon() -> Result<(), String> {
    use crate::command_ext::NoConsoleWindow;
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate this binary: {e}"))?;
    tokio::process::Command::new(exe)
        .arg("daemon")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .no_console_window()
        .spawn()
        .map(|_child| ())
        .map_err(|e| format!("cannot start maestro-server daemon: {e}"))
}

/// Wait for a runtime file other than the one left behind by a daemon that is gone.
fn fresh_runtime(dir: &Path, stale_token: Option<&str>) -> Option<DaemonRuntime> {
    read_runtime(dir).filter(|runtime| Some(runtime.token.as_str()) != stale_token)
}

async fn wait_for_runtime(dir: &Path, stale_token: Option<&str>) -> Result<DaemonRuntime, String> {
    wait_for(STARTUP_WAIT, || fresh_runtime(dir, stale_token).is_some())
        .await
        .map_err(|_| "maestro-server daemon did not start".to_string())?;
    fresh_runtime(dir, stale_token).ok_or_else(|| "maestro-server daemon did not start".to_string())
}

/// Poll `ready` every 50ms until it holds or `limit` elapses.
async fn wait_for(limit: Duration, mut ready: impl FnMut() -> bool) -> Result<(), ()> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if ready() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Open a connection and announce the token and mode.
async fn open(port: u16, token: &str, mode: &str) -> Result<TcpStream, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|e| format!("cannot reach maestro-server daemon on port {port}: {e}"))?;
    stream
        .write_all(format!("{token}\n{mode}\n").as_bytes())
        .await
        .map_err(|e| format!("cannot greet maestro-server daemon: {e}"))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("cannot greet maestro-server daemon: {e}"))?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_at(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        write_runtime(
            dir,
            &DaemonRuntime {
                port: 1234,
                token: "t".to_string(),
                version: version.to_string(),
                protocol_version: PROTOCOL_VERSION,
                pid: 1,
            },
        )
        .unwrap();
    }

    #[test]
    fn dir_prefers_the_environment_over_home() {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var(DAEMON_DIR_ENV, tmp.path());
        assert_eq!(dir().unwrap(), tmp.path());
        // A blank value is not a path to the process working directory.
        std::env::set_var(DAEMON_DIR_ENV, "   ");
        assert!(dir().unwrap().ends_with(DAEMON_DIR_DEFAULT));
        std::env::remove_var(DAEMON_DIR_ENV);
    }

    #[test]
    fn a_published_runtime_file_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        runtime_at(tmp.path(), "9.9.9");
        let runtime = read_runtime(tmp.path()).unwrap();
        assert_eq!(runtime.port, 1234);
        assert_eq!(runtime.version, "9.9.9");
        // The temporary file it was written through is not left behind.
        let strays: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name != DAEMON_RUNTIME_FILE)
            .collect();
        assert!(strays.is_empty(), "left behind {strays:?}");
    }

    #[test]
    fn a_truncated_runtime_file_is_not_a_daemon() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(DAEMON_RUNTIME_FILE), b"{\"port\":").unwrap();
        assert!(read_runtime(tmp.path()).is_none());
    }

    #[test]
    fn the_lock_and_not_the_runtime_file_says_a_daemon_is_alive() {
        let tmp = tempfile::tempdir().unwrap();
        // A runtime file left behind by a daemon that died.
        runtime_at(tmp.path(), env!("CARGO_PKG_VERSION"));
        let lock = open_lock(tmp.path()).unwrap();
        assert!(!daemon_is_running(&lock));

        // A second handle on the same file, held the way a running daemon holds it.
        let held = open_lock(tmp.path()).unwrap();
        held.try_lock_exclusive().unwrap();
        assert!(daemon_is_running(&lock));
        fs2::FileExt::unlock(&held).unwrap();
        assert!(!daemon_is_running(&lock));
    }

    #[test]
    fn a_runtime_file_left_by_a_killed_daemon_is_not_the_new_one() {
        let tmp = tempfile::tempdir().unwrap();
        // Token "t", left behind by a daemon that was killed rather than stopped.
        runtime_at(tmp.path(), env!("CARGO_PKG_VERSION"));
        let stale = read_runtime(tmp.path()).map(|runtime| runtime.token);
        assert!(fresh_runtime(tmp.path(), stale.as_deref()).is_none());

        write_runtime(
            tmp.path(),
            &DaemonRuntime {
                port: 5678,
                token: "new".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                protocol_version: PROTOCOL_VERSION,
                pid: 2,
            },
        )
        .unwrap();
        let fresh = fresh_runtime(tmp.path(), stale.as_deref()).expect("the new daemon's file");
        assert_eq!(fresh.port, 5678);
        // With nothing stale to begin with, any file is the new one.
        assert!(fresh_runtime(tmp.path(), None).is_some());
    }

    #[tokio::test]
    async fn a_daemon_that_cleaned_up_stopped_on_purpose_and_one_that_did_not_crashed() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path()).unwrap();
        assert!(stopped_on_purpose(tmp.path()).await);
        // A crash releases the lock but leaves the runtime file behind.
        runtime_at(tmp.path(), env!("CARGO_PKG_VERSION"));
        assert!(!stopped_on_purpose(tmp.path()).await);
    }

    #[tokio::test]
    async fn wait_for_gives_up() {
        assert!(wait_for(Duration::from_millis(80), || false).await.is_err());
        assert!(wait_for(Duration::from_millis(80), || true).await.is_ok());
    }
}
