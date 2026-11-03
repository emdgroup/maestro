//! Low-level ACP transport primitives: frame parsing, serialization, and read/write sources.

use maestro_protocol::{
    decode_message, encode_message, read_message_with_id, take_frame, write_message, RequestId,
    ServerRequest, ServerResponse,
};
use russh::ChannelMsg;
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use tokio::process::ChildStdin;

pub(crate) fn serialize_message(msg: &ServerRequest) -> Result<Vec<u8>, String> {
    serialize_message_with_id(None, msg)
}

/// Frame `msg` under `id`, which the server echoes on the reply so it can be told apart from
/// every other reply of its type.
pub(crate) fn serialize_message_with_id(
    id: Option<RequestId>,
    msg: &ServerRequest,
) -> Result<Vec<u8>, String> {
    let frame =
        encode_message(id, msg).map_err(|e| format!("Failed to serialize ACP message: {}", e))?;
    if !matches!(msg, ServerRequest::Pong { .. }) {
        if let Some(Ok(json)) = frame.get(4..).map(std::str::from_utf8) {
            log::trace!("[acp] >> {json}");
        }
    }
    Ok(frame)
}

/// Read source abstraction used for both local (subprocess stdout) and remote (SSH channel)
/// ACP sessions. Encapsulates the per-transport framing differences so the handshake and
/// reader task can share a single implementation.
pub(crate) enum AcpReadSource {
    Local {
        reader: BufReader<tokio::process::ChildStdout>,
    },
    Remote {
        read_half: russh::ChannelReadHalf,
        msg_buf: Vec<u8>,
    },
}

impl AcpReadSource {
    pub(crate) async fn next_message(&mut self) -> Option<ServerResponse> {
        self.next_message_with_id()
            .await
            .map(|(_, message)| message)
    }

    /// The next message, with the request id its frame carried when it answers a request.
    pub(crate) async fn next_message_with_id(
        &mut self,
    ) -> Option<(Option<RequestId>, ServerResponse)> {
        match self {
            AcpReadSource::Local { reader } => loop {
                match read_message_with_id(reader).await {
                    Ok(msg) => {
                        return Some(msg);
                    }
                    // Only a parse error is recoverable: read_message consumed the frame bytes
                    // before failing to deserialize, so the stream is positioned at the next
                    // frame. EOF, a read failure, or an oversized length prefix leaves nothing
                    // to resynchronize on.
                    Err(e) if e.is::<serde_json::Error>() => {}
                    Err(e) => {
                        log::debug!("[acp] read failed, closing: {e}");
                        return None;
                    }
                }
            },
            AcpReadSource::Remote { read_half, msg_buf } => loop {
                match try_parse_message(msg_buf) {
                    Ok(Some(msg)) => return Some(msg),
                    Ok(None) => {}
                    Err(e) => {
                        log::warn!("[acp] {e}, closing the connection");
                        return None;
                    }
                }
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data }) => msg_buf.extend_from_slice(&data),
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
    let hs_resp = tokio::time::timeout(std::time::Duration::from_secs(10), source.next_message())
        .await
        .map_err(|_| "maestro-server handshake timed out".to_string())?;

    match hs_resp {
        Some(ServerResponse::HandshakeOk(_)) => Ok(()),
        Some(ServerResponse::Error(error)) => Err(format!(
            "maestro-server handshake rejected: {}",
            error.message
        )),
        _ => Err("maestro-server did not respond with HandshakeOk".to_string()),
    }
}

/// Parse one complete framed message from `buf`, always consuming its bytes.
/// Returns `Ok(None)` on parse failure (corrupt frame skipped) or incomplete frame, and an error
/// when the length prefix exceeds `MAX_MESSAGE_SIZE`: the stream cannot be resynchronized after
/// that, so the caller must drop the connection.
///
/// Generic over the message type so the exec channel, which shares this framing but carries its
/// own messages, can reuse it.
pub(crate) fn try_parse_acp_frame<T: serde::de::DeserializeOwned>(
    buf: &mut Vec<u8>,
) -> Result<Option<T>, String> {
    Ok(take_frame(buf)?.and_then(|body| serde_json::from_slice::<T>(&body).ok()))
}

/// [`try_parse_acp_frame`] for the server's own messages, keeping the request id beside them.
fn try_parse_message(
    buf: &mut Vec<u8>,
) -> Result<Option<(Option<RequestId>, ServerResponse)>, String> {
    Ok(take_frame(buf)?.and_then(|body| decode_message(&body).ok()))
}

/// Low-level write + flush to a `BufWriter<ChildStdin>`.
pub(crate) async fn write_to_acp_session_raw(
    stdin_writer: &mut BufWriter<ChildStdin>,
    msg: &ServerRequest,
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
