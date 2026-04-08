use keyring::Entry;
use zeroize::Zeroizing;

pub struct PasswordManager;

impl PasswordManager {
    /// Store password in OS keyring
    pub fn store_password(host: &str, username: &str, password: String) -> Result<(), String> {
        let service_name = format!("maestro.ssh.{}", host);
        let entry = Entry::new(&service_name, username)
            .map_err(|e| format!("Keyring error: {}", e))?;
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
            .delete_credential()
            .map_err(|e| format!("Failed to delete password: {}", e))?;

        Ok(())
    }

    /// Store SSH key passphrase in OS keyring, keyed by the key file path
    pub fn store_passphrase(key_path: &str, passphrase: String) -> Result<(), String> {
        let entry = Entry::new("maestro.ssh.key", key_path)
            .map_err(|e| format!("Keyring error: {}", e))?;
        entry
            .set_password(&passphrase)
            .map_err(|e| format!("Failed to save passphrase: {}", e))?;
        Ok(())
    }

    /// Retrieve SSH key passphrase from OS keyring
    pub fn get_passphrase(key_path: &str) -> Result<Zeroizing<String>, String> {
        let entry = Entry::new("maestro.ssh.key", key_path)
            .map_err(|e| format!("Keyring error: {}", e))?;
        let passphrase = entry
            .get_password()
            .map_err(|e| format!("Passphrase not found: {}", e))?;
        Ok(Zeroizing::new(passphrase))
    }

    /// Delete SSH key passphrase from OS keyring
    pub fn delete_passphrase(key_path: &str) -> Result<(), String> {
        let entry = Entry::new("maestro.ssh.key", key_path)
            .map_err(|e| format!("Keyring error: {}", e))?;
        entry
            .delete_credential()
            .map_err(|e| format!("Failed to delete passphrase: {}", e))?;
        Ok(())
    }
}
