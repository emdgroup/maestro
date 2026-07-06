//! Low-level ACP transport primitives: frame parsing, serialization, and read/write sources.

use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use tokio::process::ChildStdin;
use russh::ChannelMsg;
use crate::acp::transport::{
    MaestroRpcMessage, ServerResponse, ServerRequest,
    read_message, write_message,
};
use crate::acp::manager::append_debug_log;

pub(crate) fn serialize_message(msg: &MaestroRpcMessage) -> Result<Vec<u8>, String> {
    let json_bytes = serde_json::to_vec(msg)
        .map_err(|e| format!("Failed to serialize ACP message: {}", e))?;
    if !matches!(msg, MaestroRpcMessage::Request(ServerRequest::Pong { .. })) {
        if let Ok(json) = std::str::from_utf8(&json_bytes) {
            append_debug_log(&format!("[acp] >> {json}"));
        }
    }
    let len = json_bytes.len() as u32;
    let mut frame = Vec::with_capacity(4 + json_bytes.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(&json_bytes);
    Ok(frame)
}

/// Read source abstraction used for both local (subprocess stdout) and remote (SSH channel)
/// ACP sessions. Encapsulates the per-transport framing differences so the handshake and
/// reader task can share a single implementation.
pub(crate) enum AcpReadSource {
    Local { reader: BufReader<tokio::process::ChildStdout> },
    Remote { read_half: russh::ChannelReadHalf, msg_buf: Vec<u8> },
}

impl AcpReadSource {
    pub(crate) async fn next_message(&mut self) -> Option<MaestroRpcMessage> {
        match self {
            AcpReadSource::Local { reader } => loop {
                match read_message(reader).await {
                    Ok(msg) => {
                        return Some(msg);
                    }
                    Err(e) => {
                        // Only EOF is terminal. Parse errors are recoverable: read_message
                        // consumed the frame bytes via read_exact before failing to deserialize,
                        // so the stream is correctly positioned for the next frame.
                        let is_eof = e
                            .downcast_ref::<std::io::Error>()
                            .map(|io| io.kind() == std::io::ErrorKind::UnexpectedEof)
                            .unwrap_or(false);
                        if is_eof {
                            return None;
                        }
                        // Loop and try next frame
                    }
                }
            },
            AcpReadSource::Remote { read_half, msg_buf } => loop {
                if let Some(msg) = try_parse_acp_frame(msg_buf) {
                    return Some(msg);
                }
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        msg_buf.extend_from_slice(&data);
                        if let Some(msg) = try_parse_acp_frame(msg_buf) {
                            return Some(msg);
                        }
                    }
                    Some(ChannelMsg::ExtendedData { .. })
                    | Some(ChannelMsg::WindowAdjusted { .. }) => {}
                    Some(ChannelMsg::Eof)
                    | Some(ChannelMsg::Close)
                    | Some(ChannelMsg::ExitStatus { .. })
                    | None => return None,
                    _ => {}
                }
            },
        }
    }
}

/// Read one framed response and verify it is HandshakeOk. Times out after 10 seconds.
pub(crate) async fn perform_handshake(source: &mut AcpReadSource) -> Result<(), String> {
    let hs_resp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        source.next_message(),
    )
    .await
    .map_err(|_| "maestro-server handshake timed out".to_string())?;

    match hs_resp {
        Some(MaestroRpcMessage::Response(ServerResponse::HandshakeOk(_))) => Ok(()),
        Some(MaestroRpcMessage::Response(ServerResponse::Error(error))) => {
            Err(format!("maestro-server handshake rejected: {}", error.message))
        }
        _ => Err("maestro-server did not respond with HandshakeOk".to_string()),
    }
}

/// Parse one complete framed message from `buf`, always consuming its bytes.
/// Returns None on parse failure (corrupt frame skipped) or incomplete frame.
pub(crate) fn try_parse_acp_frame(buf: &mut Vec<u8>) -> Option<MaestroRpcMessage> {
    if buf.len() < 4 {
        return None;
    }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if buf.len() < 4 + len {
        return None;
    }
    // Drain first so a corrupt frame never loops — caller retries with the next frame.
    let frame_bytes = buf[4..4 + len].to_vec();
    buf.drain(..4 + len);
    match serde_json::from_slice::<MaestroRpcMessage>(&frame_bytes) {
        Ok(msg) => Some(msg),
        Err(_) => None,
    }
}

/// Low-level write + flush to a `BufWriter<ChildStdin>`.
pub(crate) async fn write_to_acp_session_raw(
    stdin_writer: &mut BufWriter<ChildStdin>,
    msg: &MaestroRpcMessage,
) -> Result<(), String> {
    write_message(stdin_writer, msg)
        .await
        .map_err(|e| format!("write failed: {}", e))?;
    stdin_writer
        .flush()
        .await
        .map_err(|e| format!("flush failed: {}", e))?;
    Ok(())
}
