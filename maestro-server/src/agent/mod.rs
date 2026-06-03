pub mod detection;
pub mod registry;
pub mod spawn;

pub use registry::{discover_agents, load_registry};
pub use spawn::spawn_agent_subprocess;
