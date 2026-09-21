//! Where the server's framed responses go.
//!
//! Every response, session update and diagnostic this process produces leaves through
//! `helpers::send_response`, which is the only code that writes to the client. That single
//! chokepoint is why the destination can be made swappable at all: in stdio mode it is this
//! process's stdout, fixed for the run, and in daemon mode it is whichever client is currently
//! attached over the loopback socket.
//!
//! Keeping it behind `ClientOut` rather than naming `tokio::io::Stdout` in a dozen signatures is
//! what lets that second mode exist without touching any of them.

use std::sync::Arc;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

/// Handle every component holds to talk back to the client.
pub type ClientOut = Arc<Mutex<ClientSink>>;

pub struct ClientSink {
    writer: Option<Box<dyn AsyncWrite + Send + Unpin>>,
}

impl ClientSink {
    /// The stdio client: a parent process holding this one's stdin and stdout, for its whole life.
    pub fn stdio() -> ClientOut {
        Arc::new(Mutex::new(Self {
            writer: Some(Box::new(tokio::io::stdout())),
        }))
    }

    /// A sink with nobody on the other end, which is how a daemon starts and how it waits between
    /// clients.
    pub fn detached() -> ClientOut {
        Arc::new(Mutex::new(Self { writer: None }))
    }

    pub fn attach(&mut self, writer: Box<dyn AsyncWrite + Send + Unpin>) {
        self.writer = Some(writer);
    }

    pub fn detach(&mut self) {
        self.writer = None;
    }

    /// Write already-framed bytes and flush.
    ///
    /// Flushing every message is deliberate: the client blocks on a response it cannot see
    /// buffered, and these are small and infrequent enough that batching would buy nothing.
    ///
    /// A client that is absent, or that goes away mid-write, is not an error here. That is the
    /// difference residency makes: nobody watching is the normal state of a daemon between app
    /// runs, and the many callers that abandon their loop on a write error must not do so then.
    /// A failed write detaches the writer, so the session keeps running and its output goes
    /// nowhere until a client attaches again.
    ///
    /// Stdio mode gets the same treatment and loses nothing by it: it has always exited on stdin
    /// EOF, which arrives when the parent dies — the same moment its stdout would start failing.
    pub async fn write(&mut self, buf: &[u8]) -> std::io::Result<()> {
        let Some(writer) = self.writer.as_mut() else {
            return Ok(());
        };
        let wrote = async {
            writer.write_all(buf).await?;
            writer.flush().await
        }
        .await;
        if wrote.is_err() {
            self.writer = None;
        }
        Ok(())
    }
}
