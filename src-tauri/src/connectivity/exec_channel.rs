//! Runs commands on a connection's host through a long-lived `maestro-server exec-channel`
//! process instead of starting one per command.
//!
//! On WSL a command used to cost a `wsl.exe` start — 264ms measured, against 2.5ms for the git
//! invocation itself; Docker paid the same for `docker exec`, and SSH two round trips per command.
//! One channel per connection turns all of that into a frame on an open pipe.
//!
//! The channel is a different process from the ACP connection server on purpose: commands run
//! concurrently here and can produce megabytes, and neither belongs on the pipe carrying live
//! agent output.
//!
//! If a channel cannot be established the command falls back to the cold spawn this module
//! replaced, so the worst case is exactly the old behaviour.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use maestro_protocol::exec::{
    ExecCommand, ExecEvent, ExecStream, RequestId, EXEC_CHANNEL_ARG,
};
use maestro_protocol::write_frame;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::acp::transport_types::try_parse_acp_frame;
use crate::command_ext::NoConsoleWindow;
use crate::connectivity::docker::ContainerCli;
use crate::connectivity::ssh::RemoteSshSession;
use crate::git::remote::shell_quote;

pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

impl CommandOutput {
    pub fn success(&self) -> bool {
        self.exit_code == 0
    }

    pub fn stdout_string(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_string(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// Where to run a command. Carries what starting a channel needs, which for SSH is the live
/// session itself.
///
/// Local is a target like any other so callers have one path instead of a local arm beside three
/// remote ones — but it is served by a direct spawn, not a channel. See [`channel_for`].
pub enum ExecTarget<'a> {
    Local,
    Wsl { distro: &'a str },
    Docker { cli: ContainerCli, container: &'a str },
    Ssh { connection_id: i32, session: &'a RemoteSshSession },
}

/// Identifies the host a channel serves, without the SSH session an [`ExecTarget`] carries, so it
/// can be used as a map key and by callers that only know where the server was deployed.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ExecHost {
    Local,
    Wsl(String),
    Docker(String),
    Ssh(i32),
}

impl<'a> ExecTarget<'a> {
    /// The one mapping from a resolved connection to where its commands run. Everything that
    /// holds a [`GitConnection`] goes through this instead of matching on it again.
    pub fn of(conn: &'a crate::models::GitConnection) -> Self {
        use crate::models::GitConnection;
        match conn {
            GitConnection::Local { .. } => ExecTarget::Local,
            GitConnection::Remote { ssh, .. } => {
                ExecTarget::Ssh { connection_id: ssh.connection_id(), session: ssh }
            }
            GitConnection::Wsl { distro, .. } => ExecTarget::Wsl { distro },
            GitConnection::Docker { container_name, .. } => ExecTarget::Docker {
                cli: ContainerCli::detect().unwrap_or(ContainerCli::Docker),
                container: container_name,
            },
        }
    }
}

impl ExecTarget<'_> {
    fn key(&self) -> ExecHost {
        match self {
            ExecTarget::Local => ExecHost::Local,
            ExecTarget::Wsl { distro } => ExecHost::Wsl((*distro).to_string()),
            ExecTarget::Docker { container, .. } => ExecHost::Docker((*container).to_string()),
            ExecTarget::Ssh { connection_id, .. } => ExecHost::Ssh(*connection_id),
        }
    }
}

/// Path to the deployed `maestro-server` on each host.
///
/// Recorded by the ACP layer when it starts a connection server, rather than resolved here:
/// deploying needs an `AppHandle` that the command call sites — free functions like
/// `run_wsl_git` — do not have. Preflight runs before any project opens, so by the time a command
/// runs the path is known. When it is not, commands take the cold-spawn path.
fn server_paths() -> &'static Mutex<HashMap<ExecHost, String>> {
    static PATHS: OnceLock<Mutex<HashMap<ExecHost, String>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn channels() -> &'static tokio::sync::Mutex<HashMap<ExecHost, Arc<Channel>>> {
    static CHANNELS: OnceLock<tokio::sync::Mutex<HashMap<ExecHost, Arc<Channel>>>> =
        OnceLock::new();
    CHANNELS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// Tell this module where `maestro-server` lives on a host, from the places that already deploy
/// or locate it.
pub fn remember_server_path(host: ExecHost, path: &str) {
    if let Ok(mut paths) = server_paths().lock() {
        paths.insert(host, path.to_string());
    }
}

fn server_path_for(key: &ExecHost) -> Option<String> {
    server_paths().lock().ok()?.get(key).cloned()
}

type Pending = Arc<Mutex<HashMap<RequestId, mpsc::UnboundedSender<ExecEvent>>>>;

struct Channel {
    /// Serialized frames headed for the channel's stdin.
    outgoing: mpsc::Sender<Vec<u8>>,
    /// Where to deliver each running command's events, shared with the reader task. Emptied when
    /// the channel dies, which is what tells every waiting command to give up.
    pending: Pending,
    /// Cleared when the reader task stops. Without it a command registered just after the channel
    /// died would sit in a map nobody reads again and wait forever.
    alive: Arc<AtomicBool>,
    next_id: AtomicU64,
}

/// Run a command on whichever machine a connection points at.
pub async fn run_on(
    conn: &crate::models::GitConnection,
    cwd: Option<&str>,
    program: &str,
    args: &[&str],
) -> Result<CommandOutput, String> {
    run(&ExecTarget::of(conn), cwd, program, args).await
}

/// Run a command, preferring the connection's channel and falling back to a cold spawn.
pub async fn run(
    target: &ExecTarget<'_>,
    cwd: Option<&str>,
    program: &str,
    args: &[&str],
) -> Result<CommandOutput, String> {
    run_with_stdin(target, cwd, program, args, None).await
}

pub async fn run_with_stdin(
    target: &ExecTarget<'_>,
    cwd: Option<&str>,
    program: &str,
    args: &[&str],
    stdin: Option<Vec<u8>>,
) -> Result<CommandOutput, String> {
    let channel = match channel_for(target).await {
        Some(channel) => channel,
        None => return cold_spawn(target, cwd, program, args, stdin).await,
    };

    let id = channel.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel();
    {
        let mut pending = channel
            .pending
            .lock()
            .map_err(|_| "exec channel state poisoned".to_string())?;
        pending.insert(id, tx);
    }
    // Re-check after registering: the reader task may have cleared the map in between, and this
    // entry would then never be delivered to or dropped. Nothing was sent yet, so falling back to
    // a cold spawn cannot run the command twice.
    if !channel.alive.load(Ordering::Acquire) {
        forget(&channel, id);
        drop_channel(&target.key()).await;
        return cold_spawn(target, cwd, program, args, stdin).await;
    }

    let command = ExecCommand {
        id,
        cwd: cwd.map(str::to_string),
        program: program.to_string(),
        args: args.iter().map(|a| (*a).to_string()).collect(),
        env: Vec::new(),
        stdin,
    };
    let mut frame = Vec::new();
    if let Err(e) = write_frame(&mut frame, &command).await {
        forget(&channel, id);
        return Err(format!("failed to encode command: {}", e));
    }
    if channel.outgoing.send(frame).await.is_err() {
        // Nothing was written, so re-running is safe.
        forget(&channel, id);
        drop_channel(&target.key()).await;
        return cold_spawn(target, cwd, program, args, command.stdin).await;
    }

    let mut output = CommandOutput { stdout: Vec::new(), stderr: Vec::new(), exit_code: -1 };
    let result = loop {
        match rx.recv().await {
            Some(ExecEvent::Chunk { stream, bytes, .. }) => match stream {
                ExecStream::Stdout => output.stdout.extend_from_slice(&bytes),
                ExecStream::Stderr => output.stderr.extend_from_slice(&bytes),
            },
            Some(ExecEvent::Exit { code, .. }) => {
                output.exit_code = code;
                break Ok(output);
            }
            Some(ExecEvent::Failed { message, .. }) => break Err(message),
            // The channel died mid-command. Not retried: the command may already have run, and
            // several of them are not safe to repeat.
            None => break Err(format!("exec channel closed while running {}", program)),
        }
    };
    forget(&channel, id);
    result
}

fn forget(channel: &Channel, id: RequestId) {
    if let Ok(mut pending) = channel.pending.lock() {
        pending.remove(&id);
    }
}

async fn drop_channel(key: &ExecHost) {
    channels().lock().await.remove(key);
}

async fn channel_for(target: &ExecTarget<'_>) -> Option<Arc<Channel>> {
    // Local has no interop boundary to amortise: the command's own process start happens either
    // way, so routing it through a channel only adds a pipe and framing on top. Measured at
    // 16.4ms spawned directly against 28.6ms through a channel, so it takes the direct path.
    // Callers still go through `run`, which is the point — the choice lives here, once.
    if matches!(target, ExecTarget::Local) {
        return None;
    }

    let key = target.key();
    {
        let mut channels = channels().lock().await;
        match channels.get(&key) {
            Some(channel) if channel.alive.load(Ordering::Acquire) => {
                return Some(Arc::clone(channel));
            }
            // Its process died. Drop it so the next command starts a fresh one.
            Some(_) => {
                channels.remove(&key);
            }
            None => {}
        }
    }

    let server_path = match server_path_for(&key) {
        Some(path) => path,
        None => {
            log::debug!("[exec] no maestro-server path for {key:?} yet — spawning cold");
            return None;
        }
    };

    let channel = match start(target, &server_path).await {
        Ok(channel) => Arc::new(channel),
        Err(e) => {
            log::debug!("[exec] channel for {key:?} unavailable ({e}) — spawning cold");
            return None;
        }
    };
    // Another task may have started one meanwhile; keep whichever landed first so both sides
    // agree on which process is serving this connection.
    let mut channels = channels().lock().await;
    Some(Arc::clone(channels.entry(key).or_insert(channel)))
}

async fn start(target: &ExecTarget<'_>, server_path: &str) -> Result<Channel, String> {
    // A login shell so commands see the same PATH the user's own shell would give them — nvm,
    // pyenv and friends. The ACP transport already starts its server this way.
    let launch = format!("{} {}", shell_quote(server_path), EXEC_CHANNEL_ARG);

    match target {
        ExecTarget::Ssh { session, .. } => start_over_ssh(session, &launch).await,
        ExecTarget::Local => Err("local commands do not use a channel".to_string()),
        ExecTarget::Wsl { distro } => {
            let mut command = tokio::process::Command::new("wsl.exe");
            command.args(["-d", distro, "--", "bash", "-lc", &launch]);
            start_child(command).await
        }
        ExecTarget::Docker { cli, container } => {
            let mut command = tokio::process::Command::new(cli.binary());
            command.args(["exec", "-i", container, "bash", "-lc", &launch]);
            start_child(command).await
        }
    }
}

async fn start_child(mut command: tokio::process::Command) -> Result<Channel, String> {
    use std::process::Stdio;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .no_console_window()
        .spawn()
        .map_err(|e| format!("failed to start exec channel: {}", e))?;

    let mut stdin = child.stdin.take().ok_or("exec channel stdin was not piped")?;
    let stdout = child.stdout.take().ok_or("exec channel stdout was not piped")?;

    let (outgoing, mut to_send) = mpsc::channel::<Vec<u8>>(32);
    tokio::spawn(async move {
        while let Some(bytes) = to_send.recv().await {
            if stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
        // Hold the child until its stdin closes, so `kill_on_drop` reaps it.
        let _ = child.wait().await;
    });

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let channel = Channel {
        outgoing,
        pending: Arc::clone(&pending),
        alive: Arc::clone(&alive),
        next_id: AtomicU64::new(1),
    };
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut buffer = Vec::new();
        let mut scratch = [0u8; 64 * 1024];
        loop {
            while let Some(event) = try_parse_acp_frame::<ExecEvent>(&mut buffer) {
                deliver(&pending, event);
            }
            match reader.read(&mut scratch).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buffer.extend_from_slice(&scratch[..n]),
            }
        }
        abandon(&pending, &alive);
    });

    Ok(channel)
}

async fn start_over_ssh(session: &RemoteSshSession, launch: &str) -> Result<Channel, String> {
    let ssh_channel = session
        .open_exec_channel(launch)
        .await
        .map_err(|e| format!("failed to start remote exec channel: {:?}", e))?;
    let (mut read_half, write_half) = ssh_channel.split();

    let (outgoing, mut to_send) = mpsc::channel::<Vec<u8>>(32);
    tokio::spawn(async move {
        let mut writer = write_half.make_writer();
        while let Some(bytes) = to_send.recv().await {
            if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
    });

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let channel = Channel {
        outgoing,
        pending: Arc::clone(&pending),
        alive: Arc::clone(&alive),
        next_id: AtomicU64::new(1),
    };
    tokio::spawn(async move {
        use russh::ChannelMsg;
        let mut buffer = Vec::new();
        loop {
            while let Some(event) = try_parse_acp_frame::<ExecEvent>(&mut buffer) {
                deliver(&pending, event);
            }
            match read_half.wait().await {
                Some(ChannelMsg::Data { data }) => buffer.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { .. }) | Some(ChannelMsg::WindowAdjusted { .. }) => {}
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | Some(ChannelMsg::ExitStatus { .. })
                | None => break,
                _ => {}
            }
        }
        abandon(&pending, &alive);
    });

    Ok(channel)
}

fn deliver(pending: &Pending, event: ExecEvent) {
    let id = match &event {
        ExecEvent::Chunk { id, .. } | ExecEvent::Exit { id, .. } | ExecEvent::Failed { id, .. } => *id,
    };
    if let Ok(pending) = pending.lock() {
        if let Some(sink) = pending.get(&id) {
            let _ = sink.send(event);
        }
    }
}

/// The channel is gone: mark it so no new command waits on it, then drop every sink, which wakes
/// the commands still waiting.
fn abandon(pending: &Pending, alive: &AtomicBool) {
    alive.store(false, Ordering::Release);
    if let Ok(mut pending) = pending.lock() {
        pending.clear();
    }
}

/// The behaviour this module replaces: one process per command.
async fn cold_spawn(
    target: &ExecTarget<'_>,
    cwd: Option<&str>,
    program: &str,
    args: &[&str],
    stdin: Option<Vec<u8>>,
) -> Result<CommandOutput, String> {
    use std::process::Stdio;

    if let ExecTarget::Ssh { session, .. } = target {
        let mut line = format!("exec {}", shell_quote(program));
        for arg in args {
            line.push(' ');
            line.push_str(&shell_quote(arg));
        }
        if let Some(cwd) = cwd {
            line = format!("cd {} && {}", shell_quote(cwd), line);
        }
        let result = match stdin {
            Some(bytes) => session.execute_command_direct_with_stdin(&line, &bytes).await,
            None => session.execute_command_direct(&line).await,
        };
        return match result {
            Ok(stdout) => {
                Ok(CommandOutput { stdout: stdout.into_bytes(), stderr: Vec::new(), exit_code: 0 })
            }
            // A non-zero exit is a result, not a transport failure — keep it shaped like one so
            // callers see the same thing on both paths.
            Err(crate::connectivity::ssh::SshError::CommandExecutionError { exit_code, stderr })
                if exit_code != -1 =>
            {
                Ok(CommandOutput { stdout: Vec::new(), stderr: stderr.into_bytes(), exit_code })
            }
            Err(e) => Err(format!("{:?}", e)),
        };
    }

    // A cwd on the far side is not a directory this process can chdir into, so it has to be
    // applied over there. `exec` keeps the exit code and streams as the command's own.
    let remote_line = cwd.map(|cwd| {
        let mut line = format!("cd {} && exec {}", shell_quote(cwd), shell_quote(program));
        for arg in args {
            line.push(' ');
            line.push_str(&shell_quote(arg));
        }
        line
    });

    let mut command = match target {
        ExecTarget::Local => {
            let mut command = tokio::process::Command::new(program);
            command.args(args);
            if let Some(cwd) = cwd {
                command.current_dir(cwd);
            }
            command
        }
        ExecTarget::Wsl { distro } => {
            let mut command = tokio::process::Command::new("wsl.exe");
            match remote_line {
                Some(ref line) => command.args(["-d", distro, "--", "sh", "-c", line]),
                None => command.args(["-d", distro, "--", program]).args(args),
            };
            command
        }
        ExecTarget::Docker { cli, container } => {
            let mut command = tokio::process::Command::new(cli.binary());
            match remote_line {
                Some(ref line) => command.args(["exec", "-i", container, "sh", "-c", line]),
                None => command.args(["exec", "-i", container, program]).args(args),
            };
            command
        }
        ExecTarget::Ssh { .. } => unreachable!("handled above"),
    };
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).no_console_window();
    command.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to run {}: {}", program, e))?;
    if let (Some(bytes), Some(mut sink)) = (stdin.as_ref(), child.stdin.take()) {
        sink.write_all(bytes).await.map_err(|e| format!("failed to write stdin: {}", e))?;
        sink.flush().await.map_err(|e| format!("failed to flush stdin: {}", e))?;
        drop(sink);
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("failed to run {}: {}", program, e))?;

    Ok(CommandOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: output.status.code().unwrap_or(-1),
    })
}
