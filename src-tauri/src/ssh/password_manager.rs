use keyring::Entry;
use zeroize::Zeroizing;

pub struct PasswordManager;

impl PasswordManager {
    /// Store password in OS keyring
    pub fn store_password(host: &str, username: &str, password: String) -> Result<(), String> {
        let service_name = format!("maestro.ssh.{}", host);
        let entry = Entry::new(&service_name, username)
            .map_err(|e| format!("Keyring error: {}", e))?;

        // Store password securely
        entry
            .set_password(&password)
            .map_err(|e| format!("Failed to save password: {}", e))?;

        Ok(())
    }

    /// Retrieve password from OS keyring
    pub fn get_password(host: &str, username: &str) -> Result<Zeroizing<String>, String> {
        let service_name = format!("maestro.ssh.{}", host);
        let entry = Entry::new(&service_name, username)
            .map_err(|e| format!("Keyring error: {}", e))?;

        let password = entry
            .get_password()
            .map_err(|e| format!("Password not found: {}", e))?;

        Ok(Zeroizing::new(password))
    }

    /// Delete password from OS keyring
    pub fn delete_password(host: &str, username: &str) -> Result<(), String> {
        let service_name = format!("maestro.ssh.{}", host);
        let entry = Entry::new(&service_name, username)
            .map_err(|e| format!("Keyring error: {}", e))?;

        entry
            .delete_password()
            .map_err(|e| format!("Failed to delete password: {}", e))?;

        Ok(())
    }
}
