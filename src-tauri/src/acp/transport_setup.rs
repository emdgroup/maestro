//! Transport channel setup: open local, remote, and WSL connections to maestro-server.

use tokio::io::{AsyncWriteExt, BufWriter, BufReader};
use tokio::process::ChildStdin;
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest, HandshakeRequest, PROTOCOL_VERSION, write_message,
};
use crate::acp::transport_types::{AcpReadSource, write_to_acp_session_raw, perform_handshake};

/// Shared post-spawn logic for subprocess transports (local and WSL).
/// Takes an already-spawned child with stdin/stdout piped, sends the handshake, and returns
/// (stdin_writer, read_source, child) ready for the caller to use.
pub(crate) async fn handshake_local_child(
    mut child: tokio::process::Child,
) -> Result<(BufWriter<ChildStdin>, AcpReadSource, tokio::process::Child), String> {
    let child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "child stdin was not piped".to_string())?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child stdout was not piped".to_string())?;
    let mut stdin_writer = BufWriter::new(child_stdin);

    let handshake = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
        protocol_version: PROTOCOL_VERSION,
    }));
    write_to_acp_session_raw(&mut stdin_writer, &handshake).await?;

    let mut source = AcpReadSource::Local { reader: BufReader::new(child_stdout) };
    perform_handshake(&mut source).await?;

    Ok((stdin_writer, source, child))
}

/// Spawn a local maestro-server subprocess and perform handshake.
/// Returns (stdin_writer, read_source, child) ready for the caller to use.
pub(crate) async fn open_local_transport(
    app_state: &std::sync::Arc<crate::core::AppState>,
) -> Result<(BufWriter<ChildStdin>, AcpReadSource, tokio::process::Child), String> {
    use std::process::Stdio;
    // ensure_local_server downloads the binary if absent or outdated; returns cached path.
    // On the normal path (preflight already ran), this is a fast version-check hit.
    let server_path = crate::acp::deploy::ensure_local_server(&app_state.app_handle).await?;

    use crate::command_ext::NoConsoleWindow;
    let child = tokio::process::Command::new(server_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .no_console_window()
        .spawn()
        .map_err(|e| format!("Failed to spawn maestro-server: {}", e))?;

    handshake_local_child(child).await
}

/// Open an SSH exec channel to a remote maestro-server, perform handshake, and spawn
/// a writer task. Returns (mpsc_sender, read_source) ready for the caller to use.
pub(crate) async fn open_remote_transport(
    ssh_session: &crate::connectivity::ssh::RemoteSshSession,
    maestro_server_path: &str,
) -> Result<(tokio::sync::mpsc::Sender<Vec<u8>>, AcpReadSource), String> {
    let channel = ssh_session
        .open_exec_channel(maestro_server_path)
        .await
        .map_err(|e| format!("Failed to open remote maestro-server channel: {}", e))?;

    let (read_half, write_half) = channel.split();

    {
        let handshake = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
        }));
        let mut writer = write_half.make_writer();
        write_message(&mut writer, &handshake)
            .await
            .map_err(|e| format!("remote handshake write failed: {}", e))?;
        writer.flush().await.map_err(|e| format!("remote handshake flush failed: {}", e))?;
    }

    let mut source = AcpReadSource::Remote { read_half, msg_buf: Vec::new() };
    perform_handshake(&mut source).await?;

    let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    tokio::spawn(async move {
        let mut writer = write_half.make_writer();
        while let Some(bytes) = write_rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = writer.flush().await;
        }
    });

    Ok((write_tx, source))
}

/// Spawn a WSL subprocess and perform handshake.
/// Wraps server launch in `bash -lc` so login profile scripts run, giving
/// maestro-server (and its child processes) access to nvm/pyenv/etc. in PATH.
/// Returns (stdin_writer, read_source, child) — same types as `open_local_transport`.
#[cfg(windows)]
pub(crate) async fn open_wsl_transport(
    distro: &str,
    server_path: &str,
) -> Result<(BufWriter<ChildStdin>, AcpReadSource, tokio::process::Child), String> {
    use std::process::Stdio;
    use crate::command_ext::NoConsoleWindow;
    let child = tokio::process::Command::new("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", server_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .no_console_window()
        .spawn()
        .map_err(|e| format!("Failed to spawn WSL maestro-server in {}: {}", distro, e))?;

    handshake_local_child(child).await
}

/// Spawn a container exec subprocess running maestro-server and perform handshake.
/// Uses `bash -lc` so login profile scripts run, giving maestro-server access to PATH tools.
/// Returns (stdin_writer, read_source, child) — same types as `open_local_transport`.
pub(crate) async fn open_container_transport(
    cli: &crate::connectivity::docker::ContainerCli,
    container_name: &str,
    server_path: &str,
) -> Result<(BufWriter<ChildStdin>, AcpReadSource, tokio::process::Child), String> {
    use std::process::Stdio;
    let child = tokio::process::Command::new(cli.binary())
        .args(["exec", "-i", container_name, "bash", "-lc", server_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn container maestro-server in {}: {}", container_name, e))?;

    handshake_local_child(child).await
}

/// Wrap a subprocess's stdin in an mpsc channel so multiple senders can write to it.
/// Returns the sender end; the write task runs until the channel is dropped.
pub(crate) fn spawn_stdin_writer_task(mut stdin_writer: BufWriter<ChildStdin>) -> tokio::sync::mpsc::Sender<Vec<u8>> {
    let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    tokio::spawn(async move {
        while let Some(bytes) = write_rx.recv().await {
            if stdin_writer.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = stdin_writer.flush().await;
        }
    });
    write_tx
}
