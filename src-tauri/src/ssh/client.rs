use ssh2::Session;

/// Minimal SSH client wrapper for managing low-level SSH operations
pub struct SshClient {
    session: Option<Session>,
}

impl SshClient {
    /// Create a new SSH client instance
    pub fn new() -> Self {
        Self { session: None }
    }

    /// Check if a session is currently connected
    pub fn is_connected(&self) -> bool {
        self.session.is_some()
    }

    /// Set the internal session
    pub fn set_session(&mut self, session: Session) {
        self.session = Some(session);
    }

    /// Get a reference to the session if connected
    pub fn get_session(&self) -> Option<&Session> {
        self.session.as_ref()
    }

    /// Get a mutable reference to the session if connected
    pub fn get_session_mut(&mut self) -> Option<&mut Session> {
        self.session.as_mut()
    }

    /// Clear the session (disconnects)
    pub fn clear_session(&mut self) {
        self.session = None;
    }
}

impl Default for SshClient {
    fn default() -> Self {
        Self::new()
    }
}
