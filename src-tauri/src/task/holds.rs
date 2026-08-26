//! Short leases that keep the scheduler off a card the user is working with.
//!
//! A task being dragged, or open in the detail modal being edited, must not be picked up by
//! auto-mode underneath the interaction. Both are facts only the client knows — there is no row to
//! read that says "a pointer is currently down on this card" — so this is a lease the frontend
//! renews while the interaction lasts, rather than a guard on an existing path.
//!
//! It lives in memory and dies with the process, which is the point. A hold that outlived a crash
//! would leave a task the scheduler refuses forever, with nothing in the UI to explain it; the
//! `expires_at` stamp does the same job for a window that goes away without releasing.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a hold survives unrenewed.
///
/// Long enough to ride out a slow frame or a paused renderer, short enough that a window closed
/// mid-drag frees the task before the user notices. The client renews at half this.
pub const HOLD_TTL: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct TaskHolds {
    held: Mutex<HashMap<i32, Instant>>,
}

impl TaskHolds {
    /// Take or renew a hold, expiring `ttl` from now.
    pub fn hold(&self, task_id: i32, ttl: Duration) {
        match self.held.lock() {
            Ok(mut held) => {
                held.insert(task_id, Instant::now() + ttl);
            }
            Err(_) => log::warn!("[holds] hold map poisoned; task {} will not be held", task_id),
        }
    }

    pub fn release(&self, task_id: i32) {
        match self.held.lock() {
            Ok(mut held) => {
                held.remove(&task_id);
            }
            Err(_) => log::warn!("[holds] hold map poisoned; task {} stays held", task_id),
        }
    }

    /// Drop the ids the user is currently working with, keeping the rest in order.
    ///
    /// A poisoned map answers "nothing is held". That is the right direction to fail: the worst
    /// case is an agent starting on a card mid-drag, where the claim still wins and the user sees
    /// one surprising start. Failing the other way would stop the queue with nothing to explain it.
    pub fn retain_unheld(&self, ids: Vec<i32>) -> Vec<i32> {
        let mut held = match self.held.lock() {
            Ok(held) => held,
            Err(_) => {
                log::warn!("[holds] hold map poisoned; scheduling as though nothing were held");
                return ids;
            }
        };

        // Swept here rather than on a timer: this is the only place staleness matters, and a map
        // that is only read when the queue drains does not need a task of its own to tidy it.
        let now = Instant::now();
        held.retain(|_, expires_at| *expires_at > now);

        ids.into_iter().filter(|id| !held.contains_key(id)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_task_is_not_offered_to_the_scheduler() {
        let holds = TaskHolds::default();
        holds.hold(2, HOLD_TTL);

        assert_eq!(holds.retain_unheld(vec![1, 2, 3]), vec![1, 3]);
    }

    /// Skipping keeps the rest of the queue moving. Stalling the whole drain on one card being
    /// dragged would make a two-second interaction look like a stuck queue.
    #[test]
    fn the_rest_of_the_queue_keeps_its_order() {
        let holds = TaskHolds::default();
        holds.hold(1, HOLD_TTL);

        assert_eq!(holds.retain_unheld(vec![1, 4, 2]), vec![4, 2]);
    }

    #[test]
    fn releasing_gives_the_task_back() {
        let holds = TaskHolds::default();
        holds.hold(1, HOLD_TTL);
        holds.release(1);

        assert_eq!(holds.retain_unheld(vec![1]), vec![1]);
    }

    /// The case the TTL exists for: a window that went away without releasing. Without expiry the
    /// task would be refused by the scheduler for the rest of the process's life.
    #[test]
    fn a_hold_nobody_renewed_expires() {
        let holds = TaskHolds::default();
        holds.hold(1, Duration::ZERO);

        assert_eq!(holds.retain_unheld(vec![1]), vec![1]);
    }

    #[test]
    fn renewing_extends_an_expiring_hold() {
        let holds = TaskHolds::default();
        holds.hold(1, Duration::ZERO);
        holds.hold(1, HOLD_TTL);

        assert!(holds.retain_unheld(vec![1]).is_empty());
    }
}
