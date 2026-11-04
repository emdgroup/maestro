//! Length-prefixed JSON frames, and the `Message` envelope a frame carries.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::*;

pub const MSG_LEN_SIZE: usize = 4;
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16 MB — reject oversized payloads (T-41-01)

/// Length-prefixed JSON frame, for any message type. The exec channel shares this framing with
/// the main protocol but carries its own message set.
pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    stream: &mut W,
    msg: &T,
) -> Result<(), Box<dyn std::error::Error>> {
    let frame = frame(serde_json::to_vec(msg)?).map_err(|e| e as Box<dyn std::error::Error>)?;
    stream.write_all(&frame).await?;
    Ok(())
}

pub async fn read_frame<R: AsyncRead + Unpin, T: serde::de::DeserializeOwned>(
    stream: &mut R,
) -> Result<T, Box<dyn std::error::Error>> {
    Ok(serde_json::from_slice(&read_body(stream).await?)?)
}

/// One frame's body, the length prefix consumed and checked. Bytes only, so the generic readers
/// leave decoding to [`decode_message`]: a decode inside them would be compiled again in every
/// crate that calls them, and the message enum's decode tree is the largest code in the protocol.
async fn read_body<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut prefix = [0u8; MSG_LEN_SIZE];
    stream.read_exact(&mut prefix).await?;
    let mut body = vec![0u8; body_len(prefix)?];
    stream.read_exact(&mut body).await?;
    Ok(body)
}

/// Synchronous [`read_body`].
fn read_body_sync<R: std::io::Read>(
    stream: &mut R,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let mut prefix = [0u8; MSG_LEN_SIZE];
    stream.read_exact(&mut prefix)?;
    let mut body = vec![0u8; body_len(prefix)?];
    stream.read_exact(&mut body)?;
    Ok(body)
}

/// One whole frame's body taken off the front of `buffer`, for a reader that receives bytes in
/// chunks rather than reading a stream. `Ok(None)` until a whole frame has arrived. An error when
/// the length prefix exceeds `MAX_MESSAGE_SIZE`: the stream cannot be resynchronized after that,
/// so the caller has to drop the connection.
pub fn take_frame(buffer: &mut Vec<u8>) -> Result<Option<Vec<u8>>, String> {
    let Some(prefix) = buffer.first_chunk::<MSG_LEN_SIZE>() else {
        return Ok(None);
    };
    let end = MSG_LEN_SIZE + body_len(*prefix)?;
    if buffer.len() < end {
        return Ok(None);
    }
    let body = buffer[MSG_LEN_SIZE..end].to_vec();
    buffer.drain(..end);
    Ok(Some(body))
}

/// The body length a frame's prefix announces, refused past `MAX_MESSAGE_SIZE`.
fn body_len(prefix: [u8; MSG_LEN_SIZE]) -> Result<usize, String> {
    let len = u32::from_le_bytes(prefix) as usize;
    if len > MAX_MESSAGE_SIZE {
        return Err(format!(
            "Message too large: {len} bytes (max {MAX_MESSAGE_SIZE})"
        ));
    }
    Ok(len)
}

pub async fn write_message<M: Message, W: AsyncWrite + Unpin>(
    stream: &mut W,
    msg: &M,
) -> Result<(), Box<dyn std::error::Error>> {
    let frame = msg
        .encode(None)
        .map_err(|e| e as Box<dyn std::error::Error>)?;
    stream.write_all(&frame).await?;
    Ok(())
}

pub async fn read_message<M: Message, R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<M, Box<dyn std::error::Error>> {
    Ok(read_message_with_id(stream).await?.1)
}

/// Pairs a reply with the request it answers. Rides as the frame's `rpc_id` key beside its
/// `request` or `response`, and is absent on anything unprompted.
pub type RequestId = u64;

/// What one side writes and the other reads: the host writes [`ServerRequest`]s and the server
/// [`ServerResponse`]s, each in a frame of its own shape, `{"rpc_id":7,"request":{...}}` or
/// `{"rpc_id":7,"response":{...}}`.
///
/// The methods are not generic, so each direction's encode and decode is compiled once, here,
/// and only into the binary that calls it. A decode inside a generic reader would be compiled
/// again in every crate calling it, and the message enums' decode trees are the largest code in
/// the protocol.
pub trait Message: Sized {
    /// A whole frame, length prefix included, ready to be written as it stands.
    ///
    /// Synchronous and `Send` in its error so both the host's `serialize_message` and the
    /// server's spawned tasks can call it directly.
    fn encode(
        &self,
        id: Option<RequestId>,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>>;

    /// The inverse of [`Message::encode`] for a frame's body, the length prefix already stripped.
    fn decode(body: &[u8]) -> Result<(Option<RequestId>, Self), serde_json::Error>;
}

#[derive(Serialize, Deserialize)]
struct RequestFrame<M> {
    #[serde(rename = "rpc_id", default, skip_serializing_if = "Option::is_none")]
    id: Option<RequestId>,
    request: M,
}

#[derive(Serialize, Deserialize)]
struct ResponseFrame<M> {
    #[serde(rename = "rpc_id", default, skip_serializing_if = "Option::is_none")]
    id: Option<RequestId>,
    response: M,
}

impl Message for ServerRequest {
    fn encode(
        &self,
        id: Option<RequestId>,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
        frame(serde_json::to_vec(&RequestFrame { id, request: self })?)
    }

    fn decode(body: &[u8]) -> Result<(Option<RequestId>, Self), serde_json::Error> {
        let frame: RequestFrame<Self> = serde_json::from_slice(body)?;
        Ok((frame.id, frame.request))
    }
}

impl Message for ServerResponse {
    fn encode(
        &self,
        id: Option<RequestId>,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
        frame(serde_json::to_vec(&ResponseFrame { id, response: self })?)
    }

    fn decode(body: &[u8]) -> Result<(Option<RequestId>, Self), serde_json::Error> {
        let frame: ResponseFrame<Self> = serde_json::from_slice(body)?;
        Ok((frame.id, frame.response))
    }
}

/// `body` behind its length prefix.
fn frame(body: Vec<u8>) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    if body.len() > MAX_MESSAGE_SIZE {
        return Err(format!(
            "Message too large to send: {} bytes (max {})",
            body.len(),
            MAX_MESSAGE_SIZE
        )
        .into());
    }
    let mut frame = Vec::with_capacity(MSG_LEN_SIZE + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// [`Message::encode`], as a function.
pub fn encode_message<M: Message>(
    id: Option<RequestId>,
    message: &M,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    message.encode(id)
}

/// [`Message::decode`], as a function.
pub fn decode_message<M: Message>(
    body: &[u8],
) -> Result<(Option<RequestId>, M), serde_json::Error> {
    M::decode(body)
}

/// [`read_message`], keeping the request id the frame carried.
pub async fn read_message_with_id<M: Message, R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<(Option<RequestId>, M), Box<dyn std::error::Error>> {
    Ok(M::decode(&read_body(stream).await?)?)
}

/// Synchronous version of [`read_message_with_id`] for use in `spawn_blocking` reader threads.
///
/// On Windows, anonymous pipes don't support overlapped I/O (IOCP), so the async
/// version uses `spawn_blocking` internally. If the future is dropped while a read
/// is in flight (e.g. when a `tokio::select!` picks another arm), the blocking thread
/// continues and the 4-byte length prefix gets silently discarded, causing framing
/// desync. This function is meant to run in a dedicated blocking thread that is never
/// dropped, writing results to an mpsc channel instead.
pub fn read_message_with_id_sync<M: Message, R: std::io::Read>(
    stream: &mut R,
) -> Result<(Option<RequestId>, M), Box<dyn std::error::Error + Send + Sync>> {
    Ok(M::decode(&read_body_sync(stream)?)?)
}

#[cfg(test)]
mod tests {
    use crate::*;

    #[tokio::test]
    async fn read_message_rejects_oversized() {
        // Craft a length prefix claiming 32 MB
        let fake_len: u32 = 32 * 1024 * 1024;
        let mut buf = Vec::new();
        buf.extend_from_slice(&fake_len.to_le_bytes());
        buf.extend_from_slice(&[0u8; 64]); // some body bytes (doesn't matter)

        let mut cursor = std::io::Cursor::new(buf);
        let result = read_message::<ServerResponse, _>(&mut cursor).await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Message too large"));
    }

    #[test]
    fn take_frame_waits_for_a_whole_frame_and_rejects_an_oversized_prefix() {
        let mut buffer = 3u32.to_le_bytes().to_vec();
        buffer.extend_from_slice(b"ab");
        assert_eq!(take_frame(&mut buffer), Ok(None));
        buffer.push(b'c');
        assert_eq!(take_frame(&mut buffer), Ok(Some(b"abc".to_vec())));
        assert!(buffer.is_empty());

        // A corrupt prefix must fail rather than leave the reader buffering toward it.
        let mut buffer = ((MAX_MESSAGE_SIZE + 1) as u32).to_le_bytes().to_vec();
        assert!(take_frame(&mut buffer).is_err());
    }
}
