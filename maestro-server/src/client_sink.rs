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
//!
//! The same table of clients is where project locks live (`project_locks`), because a lock
//! belongs to a client and has to go when it does: `Clients::remove` is the one place a client
//! is forgotten, whether it detached or a write to it failed.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

use maestro_protocol::{
    AcquireProjectLockResponse, MaestroRpcMessage, ProjectLockInfo, ServerResponse, TakeoverResult,
};

use crate::project_locks::{Effect, ProjectLocks, TAKEOVER_TIMEOUT};

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
    locks: ProjectLocks,
    /// Lock messages owed and not yet written. Filled by code that cannot await, such as
    /// `remove`, and emptied by `flush`.
    outbox: Vec<Effect>,
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
        let effects = self.locks.remove_client(id);
        self.outbox.extend(effects);
    }

    /// Write every lock message owed. A client that fails here is removed, which can owe more, so
    /// this runs until nothing is left.
    async fn flush(&mut self) {
        while !self.outbox.is_empty() {
            for effect in std::mem::take(&mut self.outbox) {
                let (to, msg) = match effect {
                    Effect::To(id, msg) => (Some(id), msg),
                    Effect::Broadcast(msg) => (None, msg),
                };
                let Ok(buf) = encode(msg).await else {
                    continue;
                };
                match to {
                    Some(id) => self.write_to(id, &buf).await,
                    None => self.broadcast(&buf).await,
                }
            }
        }
    }

    async fn apply(&mut self, effects: Vec<Effect>) {
        self.outbox.extend(effects);
        self.flush().await;
    }
}

async fn encode(msg: ServerResponse) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut buf = Vec::new();
    maestro_protocol::write_message(&mut buf, &MaestroRpcMessage::Response(msg)).await?;
    Ok(buf)
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
                clients.locks.touch(id, tokio::time::Instant::now());
                id
            }
        }
    }

    pub async fn detach(&mut self, id: ClientId) {
        match &mut self.route {
            Route::Stdio(slot) => *slot = None,
            Route::Daemon { clients, .. } => {
                let mut clients = clients.lock().await;
                clients.remove(id);
                clients.flush().await;
            }
        }
    }

    /// Run a change to the lock table as the client this route replies to, and write what it owes.
    /// `None` on the stdio route, which has one client and so nobody to contend with.
    ///
    /// `&mut self` throughout, not `&self`: the stdio writer is not `Sync`, so a shared borrow held
    /// across an await would make every caller's future unsendable.
    async fn with_locks<R>(
        &mut self,
        change: impl FnOnce(&mut ProjectLocks, Option<ClientId>) -> (R, Vec<Effect>),
    ) -> Option<R> {
        let Route::Daemon { clients, reply_to } = &self.route else {
            return None;
        };
        let mut clients = clients.lock().await;
        let (result, effects) = change(&mut clients.locks, *reply_to);
        clients.apply(effects).await;
        Some(result)
    }

    pub async fn acquire_project(
        &mut self,
        path: String,
        label: String,
    ) -> AcquireProjectLockResponse {
        let granted = || AcquireProjectLockResponse {
            acquired: true,
            holder_label: None,
        };
        self.with_locks(|locks, me| match me {
            Some(me) => locks.acquire(me, path, label),
            None => (granted(), Vec::new()),
        })
        .await
        .unwrap_or_else(granted)
    }

    pub async fn release_project(&mut self) {
        self.with_locks(|locks, me| ((), me.map(|me| locks.release(me)).unwrap_or_default()))
            .await;
    }

    /// `paths` pairs what the client sent with its canonical form.
    pub async fn list_projects(&mut self, paths: Vec<(String, String)>) -> Vec<ProjectLockInfo> {
        self.with_locks(|locks, me| (locks.list(me, paths), Vec::new()))
            .await
            .unwrap_or_default()
    }

    /// Ask for a project on behalf of this route's client. The answer, `TakeoverResultOk`, goes to
    /// that client once the holder has agreed, refused, gone, or run out of time.
    pub async fn start_takeover(&mut self, path: String, label: String) {
        let pending = self
            .with_locks(|locks, me| match me {
                Some(me) => locks.start_takeover(me, path, label),
                None => (None, Vec::new()),
            })
            .await;
        match (pending, &self.route) {
            (Some(Some(request_id)), Route::Daemon { clients, .. }) => {
                let clients = Arc::clone(clients);
                tokio::spawn(async move {
                    tokio::time::sleep(TAKEOVER_TIMEOUT).await;
                    let mut clients = clients.lock().await;
                    let effects = clients.locks.answer(None, &request_id, true);
                    clients.apply(effects).await;
                });
            }
            (Some(_), _) => {}
            // Stdio: nobody else to ask.
            (None, _) => {
                let buf = encode(ServerResponse::TakeoverResultOk(TakeoverResult {
                    granted: true,
                }))
                .await
                .ok();
                if let Some(buf) = buf {
                    let _ = self.write(None, &buf).await;
                }
            }
        }
    }

    pub async fn answer_takeover(&mut self, request_id: String, accept: bool) {
        self.with_locks(|locks, me| ((), locks.answer(me, &request_id, accept)))
            .await;
    }

    /// `id` said something, so it is alive.
    pub async fn touch(&mut self, id: ClientId) {
        if let Route::Daemon { clients, .. } = &self.route {
            clients
                .lock()
                .await
                .locks
                .touch(id, tokio::time::Instant::now());
        }
    }

    /// Take the locks of clients that have gone quiet. See `project_locks::STALE_AFTER`.
    pub async fn release_stale(&mut self, max_age: tokio::time::Duration) {
        self.with_locks(|locks, _| {
            (
                (),
                locks.release_stale(tokio::time::Instant::now(), max_age),
            )
        })
        .await;
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
                // A client this write dropped may have held a lock.
                clients.flush().await;
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

    #[tokio::test]
    async fn a_lock_goes_with_the_client_that_held_it() {
        let root = ClientSink::detached();
        // Roomy enough that nobody reading does not block the broadcasts.
        let attach = |sink: ClientOut| async move {
            let (ours, theirs) = tokio::io::duplex(1 << 16);
            (sink.lock().await.attach(Box::new(ours)).await, theirs)
        };
        let (a, _a_rx) = attach(root.clone()).await;
        let (b, _b_rx) = attach(root.clone()).await;
        let to_a = ClientSink::for_client(&root, a).await;
        let to_b = ClientSink::for_client(&root, b).await;

        let acquire = |sink: ClientOut| async move {
            sink.lock()
                .await
                .acquire_project("/p".into(), "host".into())
                .await
                .acquired
        };
        assert!(acquire(to_a.clone()).await);
        assert!(!acquire(to_b.clone()).await);
        root.lock().await.detach(a).await;
        assert!(acquire(to_b.clone()).await);
    }
}
