//! Messages for the exec channel — a second, dedicated connection to `maestro-server` used only
//! to run commands.
//!
//! Deliberately not part of [`crate::MaestroRpcMessage`]. That protocol is served by a loop which
//! handles one message at a time, on a pipe that also carries live agent output, so a slow command
//! would stall agent streaming and a large one would sit in front of it. The exec channel is a
//! separate process with its own loop, so neither can happen.
//!
//! A command is identified by an id chosen by the host; output arrives as [`ExecEvent::Chunk`]s
//! carrying that id and is terminated by exactly one [`ExecEvent::Exit`] or
//! [`ExecEvent::Failed`].
//!
//! There is no cancel message. Nothing in Maestro can cancel a git command today, and a command
//! that hangs holds only its own request — the channel keeps serving everything else.

use serde::{Deserialize, Serialize};

/// `argv[1]` that puts `maestro-server` into exec-channel mode.
pub const EXEC_CHANNEL_ARG: &str = "exec-channel";

/// Output is forwarded in pieces of at most this size rather than accumulated, so a large diff
/// never has to fit in one frame.
pub const EXEC_CHUNK_SIZE: usize = 256 * 1024;

pub type RequestId = u64;

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ExecCommand {
    pub id: RequestId,
    pub cwd: Option<String>,
    /// Program and arguments are passed structurally to the OS, never through a shell, so no
    /// caller has to quote anything. A caller that wants shell semantics asks for them explicitly
    /// with `program: "sh", args: ["-c", script]`.
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default, with = "base64_opt")]
    pub stdin: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecEvent {
    Chunk {
        id: RequestId,
        stream: ExecStream,
        #[serde(with = "base64_bytes")]
        bytes: Vec<u8>,
    },
    Exit {
        id: RequestId,
        code: i32,
    },
    /// The command could not be started at all — a missing binary, an unusable cwd. Distinct from
    /// a non-zero exit, which is a result the caller may well expect.
    Failed {
        id: RequestId,
        message: String,
    },
}

// Bytes ride as base64 rather than as a JSON array of numbers, which costs about four bytes per
// byte. base64 costs a third more than the raw bytes and keeps the frame a plain JSON document.
// ponytail: if that third ever matters, give chunks their own raw binary frame kind.
mod base64_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&super::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        super::decode(&text).map_err(serde::de::Error::custom)
    }
}

mod base64_opt {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        bytes: &Option<Vec<u8>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(bytes) => serializer.serialize_some(&super::encode(bytes)),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Vec<u8>>, D::Error> {
        let text = Option::<String>::deserialize(deserializer)?;
        text.map(|t| super::decode(&t))
            .transpose()
            .map_err(serde::de::Error::custom)
    }
}

fn encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_output_survives_a_round_trip() {
        let event = ExecEvent::Chunk {
            id: 7,
            stream: ExecStream::Stderr,
            // Invalid UTF-8 on purpose: git diff of a binary file produces exactly this, and the
            // old code path reached the host as raw bytes.
            bytes: vec![0x00, 0xff, 0xfe, b'h', b'i'],
        };
        let json = serde_json::to_string(&event).expect("serialize");
        assert_eq!(serde_json::from_str::<ExecEvent>(&json).expect("deserialize"), event);
    }

    #[test]
    fn stdin_is_optional_and_absent_by_default() {
        let json = r#"{"id":1,"cwd":null,"program":"git","args":["status"]}"#;
        let command: ExecCommand = serde_json::from_str(json).expect("deserialize");
        assert_eq!(command.stdin, None);
        assert!(command.env.is_empty());
    }

    #[test]
    fn stdin_survives_a_round_trip() {
        let command = ExecCommand {
            id: 2,
            cwd: Some("/repo".to_string()),
            program: "git".to_string(),
            args: vec!["apply".to_string()],
            env: Vec::new(),
            stdin: Some(vec![0x00, 0x9f, b'p', b'a', b't', b'c', b'h']),
        };
        let json = serde_json::to_string(&command).expect("serialize");
        assert_eq!(serde_json::from_str::<ExecCommand>(&json).expect("deserialize"), command);
    }
}
