use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MSG_LEN_SIZE: usize = 4;
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16 MB — reject oversized payloads (T-41-01)

// --- Top-level envelope ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "direction", rename_all = "snake_case")]
pub enum MaestroRpcMessage {
    Request(ServerRequest),
    Response(ServerResponse),
}

// --- Client -> Server ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerRequest {
    Spawn(SpawnRequest),
    Prompt(PromptRequest),
    Cancel(CancelRequest),
    PermitResponse(PermissionResponse),
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpawnRequest {
    pub agent_id: String,
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PromptRequest {
    pub session_id: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CancelRequest {
    pub session_id: String,
}

// --- Server -> Client ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerResponse {
    SpawnOk(SpawnResponse),
    Error(ErrorResponse),
    SessionUpdate(SessionUpdate),
    PermissionRequest(PermissionRequest),
    TerminalOutput(TerminalOutput),
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpawnResponse {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ErrorResponse {
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionUpdate {
    pub session_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PermissionRequest {
    pub session_id: String,
    pub request_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PermissionResponse {
    pub session_id: String,
    pub request_id: String,
    pub allowed: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TerminalOutput {
    pub session_id: String,
    pub terminal_id: String,
    pub bytes: Vec<u8>,
}

pub async fn write_message<W: AsyncWrite + Unpin>(
    stream: &mut W,
    msg: &MaestroRpcMessage,
) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = serde_json::to_vec(msg)?;
    let len = bytes.len() as u32;
    stream.write_all(&len.to_le_bytes()).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}

pub async fn read_message<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<MaestroRpcMessage, Box<dyn std::error::Error>> {
    let mut len_buf = [0u8; MSG_LEN_SIZE];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_MESSAGE_SIZE {
        return Err(format!("Message too large: {} bytes (max {})", len, MAX_MESSAGE_SIZE).into());
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_spawn_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "claude-acp".to_string(),
            session_id: "sess-1".to_string(),
            cwd: "/home/user/project".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_prompt_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id: "sess-1".to_string(),
            content: "fix the bug in auth.rs".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_cancel_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest {
            session_id: "sess-1".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_spawn_ok_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "sess-1".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_error_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
            message: "agent not found".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_session_update() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
            session_id: "sess-1".to_string(),
            payload: serde_json::json!({"type": "agent_message_chunk", "text": "hello"}),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_permission_request() {
        let msg = MaestroRpcMessage::Response(ServerResponse::PermissionRequest(PermissionRequest {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            payload: serde_json::json!({"tool": "write_file", "path": "/tmp/foo.txt"}),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_terminal_output() {
        let msg = MaestroRpcMessage::Response(ServerResponse::TerminalOutput(TerminalOutput {
            session_id: "sess-1".to_string(),
            terminal_id: "term-1".to_string(),
            bytes: vec![0x1b, 0x5b, 0x32, 0x4a], // ESC[2J
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_permission_response() {
        // PermissionResponse is standalone (not wrapped in MaestroRpcMessage)
        // but still needs roundtrip verification
        let resp = PermissionResponse {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            allowed: true,
        };
        let json = serde_json::to_string(&resp).unwrap();
        let back: PermissionResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, back);
    }

    #[tokio::test]
    async fn framing_write_then_read_roundtrip() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "gemini".to_string(),
            session_id: "sess-99".to_string(),
            cwd: "/tmp".to_string(),
        }));

        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, &msg).await.unwrap();

        let mut cursor = std::io::Cursor::new(buf);
        let back = read_message(&mut cursor).await.unwrap();
        assert_eq!(msg, back);
    }

    #[tokio::test]
    async fn read_message_rejects_oversized() {
        // Craft a length prefix claiming 32 MB
        let fake_len: u32 = 32 * 1024 * 1024;
        let mut buf = Vec::new();
        buf.extend_from_slice(&fake_len.to_le_bytes());
        buf.extend_from_slice(&[0u8; 64]); // some body bytes (doesn't matter)

        let mut cursor = std::io::Cursor::new(buf);
        let result = read_message(&mut cursor).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Message too large"));
    }

    #[test]
    fn roundtrip_permit_response_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            allowed: true,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[tokio::test]
    async fn framing_permit_response_roundtrip() {
        let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            allowed: false,
        }));
        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, &msg).await.unwrap();
        let mut cursor = std::io::Cursor::new(buf);
        let back = read_message(&mut cursor).await.unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn request_and_response_are_distinguishable() {
        // Verify that a Spawn request and a SpawnOk response both containing session_id
        // are correctly distinguished by the "direction" tag
        let req = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "test".to_string(),
            session_id: "sess-1".to_string(),
            cwd: "/tmp".to_string(),
        }));
        let resp = MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "sess-1".to_string(),
        }));
        let req_json = serde_json::to_string(&req).unwrap();
        let resp_json = serde_json::to_string(&resp).unwrap();
        // Verify they produce different JSON
        assert_ne!(req_json, resp_json);
        // Verify each round-trips to the correct variant
        let req_back: MaestroRpcMessage = serde_json::from_str(&req_json).unwrap();
        let resp_back: MaestroRpcMessage = serde_json::from_str(&resp_json).unwrap();
        assert!(matches!(req_back, MaestroRpcMessage::Request(_)));
        assert!(matches!(resp_back, MaestroRpcMessage::Response(_)));
    }
}
