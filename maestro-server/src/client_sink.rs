//! Where the server's framed responses go.
//!
//! Every response, session update and diagnostic this process produces leaves through
//! `helpers::send_response`, which is the only code that writes to the client. That single
//! chokepoint is why the destination can be made swappable at all: in stdio mode it is this
//! process's stdout, fixed for the run, and in daemon mode it is whichever clients are currently
//! attached over the loopback socket.
//!
//! Keeping it behind `ClientOut` rather than naming `tokio::io::Stdout` in a dozen signatures is
//! what lets that second mode exist without touching any of them.
//!
//! A daemon serves every Maestro window on its machine at once, and the host protocol has no
//! request ids: a window matches a reply to its request by the reply's type alone. So a reply must
//! reach only the window that asked, which is what a route is. The server loop hands each request
//! a `ClientOut` whose `reply_to` is its sender, and everything that request spawns inherits it.
//! A message about a session goes to that session's owner instead, the window that last sent a
//! request naming it, since a session outlives the request that started it.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

/// Handle every component holds to talk back to the client.
pub type ClientOut = Arc<Mutex<ClientSink>>;

pub type ClientId = u64;

type Writer = Box<dyn AsyncWrite + Send + Unpin>;

/// The windows attached to a daemon, and which of them owns which session.
#[derive(Default)]
struct Clients {
    next_id: ClientId,
    writers: HashMap<ClientId, Writer>,
    owners: HashMap<String, ClientId>,
}

impl Clients {
    /// Write to one client. One that fails is gone, and is forgotten along with its sessions.
    async fn write_to(&mut self, id: ClientId, buf: &[u8]) {
        let Some(writer) = self.writers.get_mut(&id) else {
            return;
        };
        if write_all(writer, buf).await.is_err() {
            self.remove(id);
        }
    }

    async fn broadcast(&mut self, buf: &[u8]) {
        let ids: Vec<ClientId> = self.writers.keys().copied().collect();
        for id in ids {
            self.write_to(id, buf).await;
        }
    }

    fn remove(&mut self, id: ClientId) {
        self.writers.remove(&id);
        self.owners.retain(|_, owner| *owner != id);
    }
}

enum Route {
    Stdio(Option<Writer>),
    Daemon {
        clients: Arc<Mutex<Clients>>,
        reply_to: Option<ClientId>,
    },
}

pub struct ClientSink {
    route: Route,
}

impl ClientSink {
    /// The stdio client: a parent process holding this one's stdin and stdout, for its whole life.
    pub fn stdio() -> ClientOut {
        Arc::new(Mutex::new(Self {
            route: Route::Stdio(Some(Box::new(tokio::io::stdout()))),
        }))
    }

    /// A daemon's sink, with nobody on the other end yet. Messages sent through it that are not
    /// about an owned session go to every attached client.
    pub fn detached() -> ClientOut {
        Arc::new(Mutex::new(Self {
            route: Route::Daemon {
                clients: Arc::default(),
                reply_to: None,
            },
        }))
    }

    /// The same clients, replying to `id` alone. Stdio has one client, so it is returned as is.
    pub async fn for_client(this: &ClientOut, id: ClientId) -> ClientOut {
        match &this.lock().await.route {
            Route::Stdio(_) => Arc::clone(this),
            Route::Daemon { clients, .. } => Arc::new(Mutex::new(Self {
                route: Route::Daemon {
                    clients: Arc::clone(clients),
                    reply_to: Some(id),
                },
            })),
        }
    }

    /// Register a client. Only meaningful on a daemon's sink.
    pub async fn attach(&mut self, writer: Writer) -> ClientId {
        match &mut self.route {
            Route::Stdio(slot) => {
                *slot = Some(writer);
                0
            }
            Route::Daemon { clients, .. } => {
                let mut clients = clients.lock().await;
                clients.next_id += 1;
                let id = clients.next_id;
                clients.writers.insert(id, writer);
                id
            }
        }
    }

    pub async fn detach(&mut self, id: ClientId) {
        match &mut self.route {
            Route::Stdio(slot) => *slot = None,
            Route::Daemon { clients, .. } => clients.lock().await.remove(id),
        }
    }

    /// Make `id` the owner of `session_id`, so what that session says from now on goes to it.
    pub async fn claim(&mut self, id: ClientId, session_id: &str) {
        if let Route::Daemon { clients, .. } = &mut self.route {
            clients
                .lock()
                .await
                .owners
                .insert(session_id.to_string(), id);
        }
    }

    /// Whether anybody is listening. False is the normal state of a daemon between app runs, and
    /// what tells the reaper a session's output is going nowhere. Contended counts as attached,
    /// the answer that closes nothing.
    pub fn is_attached(&self) -> bool {
        match &self.route {
            Route::Stdio(slot) => slot.is_some(),
            Route::Daemon { clients, .. } => clients
                .try_lock()
                .map_or(true, |clients| !clients.writers.is_empty()),
        }
    }

    /// Write already-framed bytes and flush.
    ///
    /// A message about a session goes to its owner. One whose owner is gone, or that never had
    /// one (an automation's), goes to everybody: the window that holds the session is among them,
    /// and the others park what they do not recognise. Anything else is a reply and goes to the
    /// client this route was made for, and nowhere if that client has gone, since another
    /// window would take it for the answer to a request of its own. A route made for no client
    /// in particular is the server speaking unprompted, and speaks to everybody.
    ///
    /// Flushing every message is deliberate: the client blocks on a response it cannot see
    /// buffered, and these are small and infrequent enough that batching would buy nothing.
    ///
    /// A client that is absent, or that goes away mid-write, is not an error here. That is the
    /// difference residency makes: nobody watching is the normal state of a daemon between app
    /// runs, and the many callers that abandon their loop on a write error must not do so then.
    /// A failed write drops the client, so the session keeps running and its output goes
    /// elsewhere or nowhere until a client attaches again.
    ///
    /// Stdio mode gets the same treatment and loses nothing by it: it has always exited on stdin
    /// EOF, which arrives when the parent dies — the same moment its stdout would start failing.
    pub async fn write(&mut self, session_id: Option<&str>, buf: &[u8]) -> std::io::Result<()> {
        match &mut self.route {
            Route::Stdio(slot) => {
                if let Some(writer) = slot.as_mut() {
                    if write_all(writer, buf).await.is_err() {
                        *slot = None;
                    }
                }
            }
            Route::Daemon { clients, reply_to } => {
                let mut clients = clients.lock().await;
                let owner = session_id
                    .and_then(|sid| clients.owners.get(sid).copied())
                    .filter(|id| clients.writers.contains_key(id));
                match (session_id, owner, *reply_to) {
                    (_, Some(owner), _) => clients.write_to(owner, buf).await,
                    (None, None, Some(id)) => clients.write_to(id, buf).await,
                    _ => clients.broadcast(buf).await,
                }
            }
        }
        Ok(())
    }
}

async fn write_all(writer: &mut Writer, buf: &[u8]) -> std::io::Result<()> {
    writer.write_all(buf).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    async fn client(sink: &ClientOut) -> (ClientId, tokio::io::DuplexStream) {
        let (ours, theirs) = tokio::io::duplex(64);
        (sink.lock().await.attach(Box::new(ours)).await, theirs)
    }

    async fn read(stream: &mut tokio::io::DuplexStream) -> Option<u8> {
        let mut byte = [0u8];
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            stream.read_exact(&mut byte),
        )
        .await
        .ok()
        .map(|_| byte[0])
    }

    #[tokio::test]
    async fn two_windows_each_hear_their_own_replies_and_sessions() {
        let root = ClientSink::detached();
        let (a, mut a_rx) = client(&root).await;
        let (b, mut b_rx) = client(&root).await;
        let to_a = ClientSink::for_client(&root, a).await;
        let to_b = ClientSink::for_client(&root, b).await;

        // A reply goes to whoever asked.
        to_a.lock().await.write(None, &[1]).await.unwrap();
        assert_eq!(read(&mut a_rx).await, Some(1));
        assert_eq!(read(&mut b_rx).await, None);

        // A session goes to its owner, whichever route happens to carry it.
        to_a.lock().await.claim(b, "s").await;
        to_a.lock().await.write(Some("s"), &[2]).await.unwrap();
        assert_eq!(read(&mut b_rx).await, Some(2));
        assert_eq!(read(&mut a_rx).await, None);

        // Unprompted, or with the owner gone: everybody.
        root.lock().await.write(None, &[3]).await.unwrap();
        assert_eq!(read(&mut a_rx).await, Some(3));
        assert_eq!(read(&mut b_rx).await, Some(3));
        root.lock().await.detach(b).await;
        to_b.lock().await.write(Some("s"), &[4]).await.unwrap();
        assert_eq!(read(&mut a_rx).await, Some(4));

        // A reply to a window that has gone goes nowhere, not to another window.
        to_b.lock().await.write(None, &[5]).await.unwrap();
        assert_eq!(read(&mut a_rx).await, None);
    }
}
