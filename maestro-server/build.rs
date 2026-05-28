use std::fs;
use std::path::Path;
use std::time::Duration;
use ureq::tls::{RootCerts, TlsConfig};

const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_PATH: &str = "src/assets/registry.json";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .new_agent();

    match agent.get(REGISTRY_URL).call() {
        Ok(mut response) => match response.body_mut().read_to_string() {
            Ok(body) => {
                if serde_json::from_str::<serde_json::Value>(&body).is_ok() {
                    let path = Path::new(REGISTRY_PATH);
                    let existing = fs::read_to_string(path).unwrap_or_default();
                    if body != existing {
                        if let Err(e) = fs::write(path, &body) {
                            println!("cargo:warning=Failed to write registry.json: {e}");
                        }
                    }
                } else {
                    println!(
                        "cargo:warning=CDN returned invalid JSON, keeping existing registry.json"
                    );
                }
            }
            Err(e) => {
                println!("cargo:warning=Failed to read registry response body: {e}");
            }
        },
        Err(e) => {
            println!(
                "cargo:warning=Failed to fetch ACP registry (using bundled fallback): {e}"
            );
        }
    }
}
