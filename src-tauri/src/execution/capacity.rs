//! How many agents a host can run at once.
//!
//! The limit is per host rather than per project, because it tracks real resources: two projects
//! pointed at the same SSH box share that box's memory, and nothing in the frontend can see that —
//! which is why the scheduler has to live here rather than in the UI.
//!
//! The limit itself is the daemon's (`maestro-server/src/pipeline_settings.rs`), measured on the
//! machine the agents run on; this is the app's view of it.
//!
//! The user picks between a fixed number and a figure derived from free memory. Neither is a
//! guess about the other: a laptop with plenty of RAM but a noisy fan wants a hard cap, and a
//! shared build host wants the limit to move as other people use it.

pub use maestro_protocol::ConcurrencyMode;
