//! Generic one-shot RPC helpers for spawning maestro-server, sending a single
//! request, reading one framed response, and shutting down.

use crate::acp::manager::try_parse_acp_frame;
use crate::acp::transport::{
    HandshakeRequest, MaestroRpcMessage, PROTOCOL_VERSION, ServerRequest, ServerResponse,
    write_message,
};

async fn read_next_frame_local(
    stdout: &mut tokio::process::ChildStdout,
    buf: &mut Vec<u8>,
) -> Result<Option<MaestroRpcMessage>, String> {
    use tokio::io::AsyncReadExt;
    let mut tmp = [0u8; 4096];
    loop {
        let n = stdout
            .read(&mut tmp)
            .await
            .map_err(|e| format!("read error: {}", e))?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(rpc_msg) = try_parse_acp_frame(buf) {
            return Ok(Some(rpc_msg));
        }
    }
}

async fn read_next_frame_remote(
    read_half: &mut russh::ChannelReadHalf,
    buf: &mut Vec<u8>,
) -> Option<MaestroRpcMessage> {
    use russh::ChannelMsg;
    loop {
        match read_half.wait().await {
            Some(ChannelMsg::Data { data }) => {
                buf.extend_from_slice(&data);
                if let Some(rpc_msg) = try_parse_acp_frame(buf) {
                    return Some(rpc_msg);
                }
            }
            Some(ChannelMsg::Eof)
            | Some(ChannelMsg::Close)
            | Some(ChannelMsg::ExitStatus { .. })
            | None => return None,
            _ => {}
        }
    }
}

/// Spawn a local maestro-server, perform protocol handshake, send `request`,
/// return the first framed response.
///
/// The subprocess is killed on drop (`kill_on_drop(true)`). Fails if maestro-server
/// is not on PATH, if the handshake fails, or if no response arrives within `timeout_secs`.
pub async fn one_shot_rpc_local(
    request: &MaestroRpcMessage,
    timeout_secs: u64,
) -> Result<Option<MaestroRpcMessage>, String> {
    use tokio::io::{AsyncWriteExt, BufWriter};

    let server_path = which::which("maestro-server")
        .map_err(|e| format!("maestro-server not found: {}", e))?;

    let mut child = tokio::process::Command::new(server_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn local maestro-server: {}", e))?;

    let mut stdin = child.stdin.take().expect("stdin piped");
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut writer = BufWriter::new(&mut stdin);

    let handshake = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
        protocol_version: PROTOCOL_VERSION,
    }));
    write_message(&mut writer, &handshake)
        .await
        .map_err(|e| format!("handshake write failed: {}", e))?;
    writer.flush().await.map_err(|e| format!("handshake flush failed: {}", e))?;

    let mut buf = Vec::<u8>::new();
    let hs_resp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        read_next_frame_local(&mut stdout, &mut buf),
    )
    .await
    .map_err(|_| "handshake timed out".to_string())?
    .map_err(|e| format!("handshake read error: {}", e))?;

    match hs_resp {
        Some(MaestroRpcMessage::Response(ServerResponse::HandshakeOk(_))) => {}
        Some(MaestroRpcMessage::Response(ServerResponse::Error(e))) => {
            return Err(format!("maestro-server handshake rejected: {}", e.message));
        }
        _ => return Err("maestro-server did not respond with HandshakeOk".to_string()),
    }

    write_message(&mut writer, request)
        .await
        .map_err(|e| format!("one-shot write failed: {}", e))?;
    writer.flush().await.map_err(|e| format!("one-shot flush failed: {}", e))?;
    drop(writer);
    drop(stdin);

    tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        read_next_frame_local(&mut stdout, &mut buf),
    )
    .await
    .map_err(|_| format!("one-shot RPC timed out after {}s", timeout_secs))?
    .map_err(|e| format!("one-shot read error: {}", e))
}

/// Open a one-shot SSH exec channel to `maestro_server_path`, perform protocol
/// handshake, send `request`, return the first framed response.
///
/// Fails if the channel cannot be opened, if the handshake fails, or if no response
/// arrives within `timeout_secs`.
pub async fn one_shot_rpc_remote(
    ssh: &crate::ssh::RemoteSshSession,
    maestro_server_path: &str,
    request: &MaestroRpcMessage,
    timeout_secs: u64,
) -> Result<Option<MaestroRpcMessage>, String> {
    use tokio::io::AsyncWriteExt;

    let channel = ssh
        .open_exec_channel(maestro_server_path)
        .await
        .map_err(|e| format!("one-shot channel open failed: {}", e))?;

    let (mut read_half, write_half) = channel.split();
    let mut writer = write_half.make_writer();

    let handshake = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
        protocol_version: PROTOCOL_VERSION,
    }));
    write_message(&mut writer, &handshake)
        .await
        .map_err(|e| format!("handshake write failed: {}", e))?;
    writer.flush().await.map_err(|e| format!("handshake flush failed: {}", e))?;

    let mut buf = Vec::<u8>::new();
    let hs_resp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        read_next_frame_remote(&mut read_half, &mut buf),
    )
    .await
    .map_err(|_| "remote handshake timed out".to_string())?;

    match hs_resp {
        Some(MaestroRpcMessage::Response(ServerResponse::HandshakeOk(_))) => {}
        Some(MaestroRpcMessage::Response(ServerResponse::Error(e))) => {
            return Err(format!("maestro-server handshake rejected: {}", e.message));
        }
        _ => return Err("maestro-server did not respond with HandshakeOk".to_string()),
    }

    write_message(&mut writer, request)
        .await
        .map_err(|e| format!("one-shot write failed: {}", e))?;
    writer.flush().await.map_err(|e| format!("one-shot flush failed: {}", e))?;
    drop(writer);
    drop(write_half);

    tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        read_next_frame_remote(&mut read_half, &mut buf),
    )
    .await
    .map_err(|_| format!("one-shot RPC timed out after {}s", timeout_secs))
}
