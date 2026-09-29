//! Which attached client holds which project.
//!
//! In memory on purpose: a lock that outlived the daemon would be a project nobody could open, and
//! the daemon dying is exactly when every client holding one has lost its sessions anyway. Keyed by
//! the canonical project path, because that is what two windows on different machines, or with
//! different databases, can agree on.
//!
//! A client holds at most one project. Everything here is pure bookkeeping: each change returns the
//! messages it owes as [`Effect`]s, which `client_sink` writes, so the rules can be tested without
//! a socket.

use std::collections::HashMap;

use maestro_protocol::{
    AcquireProjectLockResponse, KickReason, ProjectKicked, ProjectLockInfo, ServerResponse,
    TakeoverRequested, TakeoverResult,
};
use tokio::time::{Duration, Instant};

use crate::client_sink::ClientId;

/// How long a holder has to answer a takeover before it counts as a yes.
pub const TAKEOVER_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a client may go without sending anything before its lock is taken from it. Three
/// missed pings.
pub const STALE_AFTER: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq)]
pub enum Effect {
    To(ClientId, ServerResponse),
    Broadcast(ServerResponse),
}

struct Holder {
    client: ClientId,
    label: String,
}

struct Takeover {
    path: String,
    requester: ClientId,
    label: String,
    holder: ClientId,
}

#[derive(Default)]
pub struct ProjectLocks {
    held: HashMap<String, Holder>,
    last_seen: HashMap<ClientId, Instant>,
    takeovers: HashMap<String, Takeover>,
    next_request: u64,
}

fn changed() -> Effect {
    Effect::Broadcast(ServerResponse::ProjectLocksChanged)
}

fn takeover_result(requester: ClientId, granted: bool) -> Effect {
    Effect::To(
        requester,
        ServerResponse::TakeoverResultOk(TakeoverResult { granted }),
    )
}

impl ProjectLocks {
    /// Give `path` to `client`, dropping whatever else it held. Returns who had it before, if that
    /// was somebody else.
    fn assign(&mut self, client: ClientId, path: String, label: String) -> Option<ClientId> {
        self.held
            .retain(|held, holder| holder.client != client || *held == path);
        self.held
            .insert(path, Holder { client, label })
            .map(|previous| previous.client)
            .filter(|previous| *previous != client)
    }

    pub fn acquire(
        &mut self,
        client: ClientId,
        path: String,
        label: String,
    ) -> (AcquireProjectLockResponse, Vec<Effect>) {
        if let Some(holder) = self.held.get(&path).filter(|h| h.client != client) {
            return (
                AcquireProjectLockResponse {
                    acquired: false,
                    holder_label: Some(holder.label.clone()),
                },
                Vec::new(),
            );
        }
        self.assign(client, path, label);
        (
            AcquireProjectLockResponse {
                acquired: true,
                holder_label: None,
            },
            vec![changed()],
        )
    }

    pub fn release(&mut self, client: ClientId) -> Vec<Effect> {
        let before = self.held.len();
        self.held.retain(|_, holder| holder.client != client);
        if self.held.len() == before {
            Vec::new()
        } else {
            vec![changed()]
        }
    }

    /// `paths` pairs what the client sent with its canonical form; the answer echoes the former.
    pub fn list(
        &self,
        client: Option<ClientId>,
        paths: Vec<(String, String)>,
    ) -> Vec<ProjectLockInfo> {
        paths
            .into_iter()
            .filter_map(|(sent, canonical)| {
                self.held.get(&canonical).map(|holder| ProjectLockInfo {
                    project_path: sent,
                    holder_label: holder.label.clone(),
                    yours: Some(holder.client) == client,
                })
            })
            .collect()
    }

    /// Ask for a project on `requester`'s behalf. Returns the request id when the holder has to be
    /// asked, which the caller times out with [`TAKEOVER_TIMEOUT`]; `None` when it was settled on
    /// the spot, because nobody else held it.
    pub fn start_takeover(
        &mut self,
        requester: ClientId,
        path: String,
        label: String,
    ) -> (Option<String>, Vec<Effect>) {
        let Some(holder) = self
            .held
            .get(&path)
            .map(|h| h.client)
            .filter(|holder| *holder != requester)
        else {
            self.assign(requester, path, label);
            return (None, vec![takeover_result(requester, true), changed()]);
        };
        self.next_request += 1;
        let request_id = format!("takeover-{}", self.next_request);
        let ask = Effect::To(
            holder,
            ServerResponse::TakeoverRequested(TakeoverRequested {
                request_id: request_id.clone(),
                project_path: path.clone(),
                requester_label: label.clone(),
            }),
        );
        self.takeovers.insert(
            request_id.clone(),
            Takeover {
                path,
                requester,
                label,
                holder,
            },
        );
        (Some(request_id), vec![ask])
    }

    /// Settle a takeover. `from` is the client answering, which has to be the one that was asked;
    /// `None` is the daemon itself, when the holder ran out of time or went away. An answer to a
    /// takeover already settled is ignored.
    pub fn answer(
        &mut self,
        from: Option<ClientId>,
        request_id: &str,
        accept: bool,
    ) -> Vec<Effect> {
        match self.takeovers.get(request_id) {
            Some(takeover) if from.is_none_or(|from| from == takeover.holder) => {}
            _ => return Vec::new(),
        }
        let Some(takeover) = self.takeovers.remove(request_id) else {
            return Vec::new();
        };
        if !accept {
            return vec![takeover_result(takeover.requester, false)];
        }

        let mut effects = Vec::new();
        if let Some(previous) = self.assign(
            takeover.requester,
            takeover.path.clone(),
            takeover.label.clone(),
        ) {
            effects.push(Effect::To(
                previous,
                ServerResponse::ProjectKicked(ProjectKicked {
                    project_path: takeover.path.clone(),
                    reason: KickReason::TakenOver {
                        by: takeover.label.clone(),
                    },
                }),
            ));
        }
        effects.push(takeover_result(takeover.requester, true));
        effects.push(changed());

        // Anybody else waiting on the same project was asking the client that just gave it up.
        // Granting them later would take it from the one it was just given to.
        let rivals: Vec<String> = self
            .takeovers
            .iter()
            .filter(|(_, t)| t.path == takeover.path)
            .map(|(id, _)| id.clone())
            .collect();
        for id in rivals {
            if let Some(rival) = self.takeovers.remove(&id) {
                effects.push(takeover_result(rival.requester, false));
            }
        }
        effects
    }

    /// A client has gone. What it was asked to give up is given up, what it asked for is dropped,
    /// and what it held is released.
    pub fn remove_client(&mut self, client: ClientId) -> Vec<Effect> {
        self.last_seen.remove(&client);
        self.takeovers.retain(|_, t| t.requester != client);
        let owed: Vec<String> = self
            .takeovers
            .iter()
            .filter(|(_, t)| t.holder == client)
            .map(|(id, _)| id.clone())
            .collect();
        let mut effects = Vec::new();
        for id in owed {
            effects.extend(self.answer(None, &id, true));
        }
        effects.extend(self.release(client));
        effects
    }

    pub fn touch(&mut self, client: ClientId, now: Instant) {
        self.last_seen.insert(client, now);
    }

    /// Take the locks of every client silent for longer than `max_age`, and tell each why. Its
    /// connection is left alone: a client that is only slow keeps its sessions.
    pub fn release_stale(&mut self, now: Instant, max_age: Duration) -> Vec<Effect> {
        let stale: Vec<(String, ClientId)> = self
            .held
            .iter()
            .filter(|(_, holder)| {
                self.last_seen
                    .get(&holder.client)
                    .is_some_and(|seen| now.duration_since(*seen) > max_age)
            })
            .map(|(path, holder)| (path.clone(), holder.client))
            .collect();
        if stale.is_empty() {
            return Vec::new();
        }
        let mut effects = Vec::new();
        for (path, client) in stale {
            self.held.remove(&path);
            effects.push(Effect::To(
                client,
                ServerResponse::ProjectKicked(ProjectKicked {
                    project_path: path,
                    reason: KickReason::Stale,
                }),
            ));
        }
        effects.push(changed());
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acquire(locks: &mut ProjectLocks, client: ClientId, path: &str) -> bool {
        locks
            .acquire(client, path.to_string(), format!("host-{client}"))
            .0
            .acquired
    }

    fn holder(locks: &ProjectLocks, path: &str) -> Option<ClientId> {
        locks.held.get(path).map(|h| h.client)
    }

    fn kicked(effects: &[Effect], client: ClientId) -> Option<KickReason> {
        effects.iter().find_map(|e| match e {
            Effect::To(to, ServerResponse::ProjectKicked(k)) if *to == client => {
                Some(k.reason.clone())
            }
            _ => None,
        })
    }

    fn granted(effects: &[Effect], client: ClientId) -> Option<bool> {
        effects.iter().find_map(|e| match e {
            Effect::To(to, ServerResponse::TakeoverResultOk(r)) if *to == client => Some(r.granted),
            _ => None,
        })
    }

    #[test]
    fn a_held_project_is_refused_with_its_holder() {
        let mut locks = ProjectLocks::default();
        assert!(acquire(&mut locks, 1, "/a"));
        let (resp, effects) = locks.acquire(2, "/a".into(), "two".into());
        assert!(!resp.acquired);
        assert_eq!(resp.holder_label.as_deref(), Some("host-1"));
        assert!(effects.is_empty());
        // The holder asking again is not a conflict.
        assert!(acquire(&mut locks, 1, "/a"));
    }

    #[test]
    fn acquiring_another_project_releases_the_first() {
        let mut locks = ProjectLocks::default();
        acquire(&mut locks, 1, "/a");
        acquire(&mut locks, 1, "/b");
        assert_eq!(holder(&locks, "/a"), None);
        assert_eq!(holder(&locks, "/b"), Some(1));
    }

    #[test]
    fn detach_releases_and_announces() {
        let mut locks = ProjectLocks::default();
        acquire(&mut locks, 1, "/a");
        assert_eq!(locks.remove_client(1), vec![changed()]);
        assert!(acquire(&mut locks, 2, "/a"));
    }

    #[test]
    fn a_silent_client_loses_its_lock_after_thirty_seconds() {
        let mut locks = ProjectLocks::default();
        let start = Instant::now();
        locks.touch(1, start);
        locks.touch(2, start);
        acquire(&mut locks, 1, "/a");
        acquire(&mut locks, 2, "/b");
        locks.touch(2, start + Duration::from_secs(25));

        assert!(locks
            .release_stale(start + Duration::from_secs(29), STALE_AFTER)
            .is_empty());
        let effects = locks.release_stale(start + Duration::from_secs(31), STALE_AFTER);
        assert_eq!(kicked(&effects, 1), Some(KickReason::Stale));
        assert_eq!(kicked(&effects, 2), None);
        assert_eq!(holder(&locks, "/a"), None);
        assert_eq!(holder(&locks, "/b"), Some(2));
    }

    #[test]
    fn list_marks_the_askers_own_lock() {
        let mut locks = ProjectLocks::default();
        acquire(&mut locks, 1, "/a");
        acquire(&mut locks, 2, "/b");
        let listed = locks.list(
            Some(1),
            vec![
                ("A".into(), "/a".into()),
                ("B".into(), "/b".into()),
                ("C".into(), "/c".into()),
            ],
        );
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|l| l.project_path == "A" && l.yours));
        assert!(listed
            .iter()
            .any(|l| l.project_path == "B" && !l.yours && l.holder_label == "host-2"));
    }

    #[test]
    fn a_free_project_is_granted_without_asking() {
        let mut locks = ProjectLocks::default();
        let (pending, effects) = locks.start_takeover(2, "/a".into(), "two".into());
        assert_eq!(pending, None);
        assert_eq!(granted(&effects, 2), Some(true));
        assert_eq!(holder(&locks, "/a"), Some(2));
    }

    #[test]
    fn takeover_accepted_moves_the_lock_and_kicks_the_holder() {
        let mut locks = ProjectLocks::default();
        acquire(&mut locks, 1, "/a");
        let (id, effects) = locks.start_takeover(2, "/a".into(), "two".into());
        let id = id.unwrap();
        assert!(matches!(
            &effects[..],
            [Effect::To(1, ServerResponse::TakeoverRequested(_))]
        ));

        // Only the client that was asked may answer.
        assert!(locks.answer(Some(3), &id, true).is_empty());

        let effects = locks.answer(Some(1), &id, true);
        assert_eq!(
            kicked(&effects, 1),
            Some(KickReason::TakenOver { by: "two".into() })
        );
        assert_eq!(granted(&effects, 2), Some(true));
        assert_eq!(holder(&locks, "/a"), Some(2));
        // Settled: a late answer, or the timer firing, changes nothing.
        assert!(locks.answer(None, &id, true).is_empty());
    }

    #[test]
    fn takeover_refused_leaves_the_lock_where_it_was() {
        let mut locks = ProjectLocks::default();
        acquire(&mut locks, 1, "/a");
        let id = locks
            .start_takeover(2, "/a".into(), "two".into())
            .0
            .unwrap();
        let effects = locks.answer(Some(1), &id, false);
        assert_eq!(granted(&effects, 2), Some(false));
        assert_eq!(holder(&locks, "/a"), Some(1));
    }

    #[test]
    fn takeover_unanswered_is_granted_by_the_timer() {
        let mut locks = ProjectLocks::default();
        acquire(&mut locks, 1, "/a");
        let id = locks
            .start_takeover(2, "/a".into(), "two".into())
            .0
            .unwrap();
        let effects = locks.answer(None, &id, true);
        assert_eq!(granted(&effects, 2), Some(true));
        assert_eq!(holder(&locks, "/a"), Some(2));
    }

    #[test]
    fn holder_leaving_grants_and_requester_leaving_drops() {
        let mut locks = ProjectLocks::default();
        acquire(&mut locks, 1, "/a");
        locks.start_takeover(2, "/a".into(), "two".into());
        let effects = locks.remove_client(1);
        assert_eq!(granted(&effects, 2), Some(true));
        assert_eq!(holder(&locks, "/a"), Some(2));

        let id = locks
            .start_takeover(3, "/a".into(), "three".into())
            .0
            .unwrap();
        locks.remove_client(3);
        assert!(locks.answer(Some(2), &id, true).is_empty());
        assert_eq!(holder(&locks, "/a"), Some(2));
    }

    #[test]
    fn granting_one_takeover_refuses_its_rivals() {
        let mut locks = ProjectLocks::default();
        acquire(&mut locks, 1, "/a");
        let first = locks
            .start_takeover(2, "/a".into(), "two".into())
            .0
            .unwrap();
        let second = locks
            .start_takeover(3, "/a".into(), "three".into())
            .0
            .unwrap();
        let effects = locks.answer(Some(1), &first, true);
        assert_eq!(granted(&effects, 3), Some(false));
        assert!(locks.answer(None, &second, true).is_empty());
        assert_eq!(holder(&locks, "/a"), Some(2));
    }
}
