//! OAuth for remote MCP servers, per the MCP authorization spec: protected resource metadata
//! names the authorization server, dynamic client registration gets a client, and an
//! authorization code grant with PKCE is redirected to a loopback listener on this machine.
//!
//! The access token becomes the server's `Authorization` header secret like any other, so the
//! daemon injects it knowing nothing about OAuth. What refreshing it takes (refresh token, client,
//! token endpoint) sits beside it in the keychain under the key `oauth`. Neither is written until
//! the server is saved: a sign-in is held in memory under an id until then, so one the user cancels
//! never reaches the keychain.
//!
//! A server that registers no clients needs one the user registered with the provider. Its client
//! ID comes with `McpOAuthSettings`, and the redirect then goes to a fixed port, since a registered
//! app only accepts the redirect address it was registered with.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use rand::RngCore;
use reqwest::header::{ACCEPT, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::mcp::{account, push_secrets, McpOAuthSettings, KEYCHAIN_SERVICE};
use crate::acp::ConnectionKey;
use crate::core::AppState;
use crate::integration::keychain::KeychainStore;

pub(crate) const OAUTH_KEY: &str = "oauth";
pub(crate) const AUTHORIZATION: &str = "Authorization";
/// How long the user has to finish signing in in the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Refresh this long before the token runs out, so a session started meanwhile gets a live one.
const REFRESH_MARGIN: u64 = 120;
/// Where the browser comes back to when the user brought their own client, which the provider
/// only accepts at the address it was registered with. Any other sign-in takes a free port.
pub(crate) const REDIRECT_PORT: u16 = 33418;
const JWT_BEARER: &str = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/// What refreshing an access token takes.
#[derive(Serialize, Deserialize)]
struct Grant {
    token_endpoint: String,
    client_id: String,
    client_secret: Option<String>,
    resource: String,
    refresh_token: Option<String>,
    /// Unix seconds, when the server said.
    expires_at: Option<u64>,
    /// How the client proves itself to the token endpoint. Empty in a grant from before this
    /// existed, which sent its secret, if any, in the body.
    #[serde(default)]
    client_auth: String,
    #[serde(default)]
    private_key: Option<String>,
    #[serde(default)]
    key_id: Option<String>,
    #[serde(default)]
    algorithm: Option<String>,
}

/// A short-lived JWT the client signs to authenticate itself (RFC 7523): with its secret for
/// `client_secret_jwt`, with its private key for `private_key_jwt`.
fn client_assertion(grant: &Grant) -> Result<String, String> {
    use jsonwebtoken::{Algorithm, EncodingKey, Header};
    let (algorithm, key) = if grant.client_auth == "private_key_jwt" {
        let pem = grant
            .private_key
            .as_deref()
            .ok_or("private_key_jwt needs a private key")?
            .as_bytes();
        let algorithm: Algorithm = grant
            .algorithm
            .as_deref()
            .unwrap_or("RS256")
            .parse()
            .map_err(|e| format!("Unknown signing algorithm: {e}"))?;
        let key = match algorithm {
            Algorithm::ES256 | Algorithm::ES384 => EncodingKey::from_ec_pem(pem),
            Algorithm::EdDSA => EncodingKey::from_ed_pem(pem),
            _ => EncodingKey::from_rsa_pem(pem),
        }
        .map_err(|e| format!("The private key could not be read: {e}"))?;
        (algorithm, key)
    } else {
        let secret = grant
            .client_secret
            .as_deref()
            .ok_or("client_secret_jwt needs a client secret")?;
        (
            Algorithm::HS256,
            EncodingKey::from_secret(secret.as_bytes()),
        )
    };
    let mut header = Header::new(algorithm);
    header.kid = grant.key_id.clone();
    let issued = now();
    let claims = json!({
        "iss": grant.client_id,
        "sub": grant.client_id,
        "aud": grant.token_endpoint,
        "jti": random_token(),
        "iat": issued,
        "exp": issued + 300,
    });
    jsonwebtoken::encode(&header, &claims, &key)
        .map_err(|e| format!("Signing the client assertion failed: {e}"))
}

/// The method `auto` stands for: what the credentials given allow, among what the server lists.
fn pick_client_auth(wanted: &str, supported: &[&str], has_secret: bool, has_key: bool) -> String {
    if wanted != "auto" && !wanted.is_empty() {
        return wanted.to_string();
    }
    let offered = |method: &str| supported.is_empty() || supported.contains(&method);
    let method = if has_key {
        "private_key_jwt"
    } else if !has_secret {
        "none"
    } else if offered("client_secret_basic") {
        "client_secret_basic"
    } else if offered("client_secret_post") {
        "client_secret_post"
    } else {
        "client_secret_jwt"
    };
    method.to_string()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `<origin>/.well-known/<suffix><path>` then `<origin>/.well-known/<suffix>`, the order RFC 8414
/// and RFC 9728 give for a URL with a path.
fn well_known(url: &Url, suffix: &str) -> Vec<String> {
    let origin = url.origin().ascii_serialization();
    let path = url.path().trim_end_matches('/');
    let mut urls = Vec::new();
    if !path.is_empty() {
        urls.push(format!("{origin}/.well-known/{suffix}{path}"));
    }
    urls.push(format!("{origin}/.well-known/{suffix}"));
    urls
}

/// A parameter of a `WWW-Authenticate` challenge, quoted or not.
fn challenge_param(header: &str, name: &str) -> Option<String> {
    let start = header.find(&format!("{name}="))? + name.len() + 1;
    let rest = &header[start..];
    let value = match rest.strip_prefix('"') {
        Some(quoted) => &quoted[..quoted.find('"')?],
        None => rest.split([',', ' ']).next()?,
    };
    Some(value.to_string())
}

async fn get_json(client: &reqwest::Client, url: &str) -> Option<Value> {
    let response = client
        .get(url)
        .header(ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

async fn first_json(client: &reqwest::Client, urls: Vec<String>) -> Option<Value> {
    for url in urls {
        if let Some(value) = get_json(client, &url).await {
            return Some(value);
        }
    }
    None
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", urlencoding::encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn describe_error(body: &Value, fallback: &str) -> String {
    body.get("error_description")
        .or_else(|| body.get("error"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

/// Ask the token endpoint for a token, and fold the answer into `grant`. Returns the access token.
async fn request_token(
    client: &reqwest::Client,
    grant: &mut Grant,
    pairs: &[(&str, &str)],
) -> Result<String, String> {
    let mut pairs = pairs.to_vec();
    pairs.push(("resource", &grant.resource));
    let mut request = client
        .post(&grant.token_endpoint)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded");
    let assertion;
    match (grant.client_auth.as_str(), &grant.client_secret) {
        ("client_secret_basic", Some(secret)) => {
            // RFC 6749 §2.3.1: each half is form-encoded before the pair is.
            let credentials = format!(
                "{}:{}",
                urlencoding::encode(&grant.client_id),
                urlencoding::encode(secret)
            );
            request = request.header(
                reqwest::header::AUTHORIZATION,
                format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(credentials)
                ),
            );
        }
        ("client_secret_jwt" | "private_key_jwt", _) => {
            assertion = client_assertion(grant)?;
            pairs.push(("client_id", &grant.client_id));
            pairs.push(("client_assertion_type", JWT_BEARER));
            pairs.push(("client_assertion", &assertion));
        }
        (method, secret) => {
            pairs.push(("client_id", &grant.client_id));
            if let (Some(secret), false) = (secret, method == "none") {
                pairs.push(("client_secret", secret));
            }
        }
    }
    let response = request
        .body(form(&pairs))
        .send()
        .await
        .map_err(|e| format!("Reaching the token endpoint failed: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let Some(access) = body.get("access_token").and_then(Value::as_str) else {
        return Err(format!(
            "The token endpoint refused: {}",
            describe_error(&body, status.as_str())
        ));
    };
    // A server that rotates refresh tokens sends a new one; one that does not keeps the old.
    if let Some(refresh) = body.get("refresh_token").and_then(Value::as_str) {
        grant.refresh_token = Some(refresh.to_string());
    }
    grant.expires_at = body
        .get("expires_in")
        .and_then(Value::as_u64)
        .map(|seconds| now() + seconds);
    Ok(access.to_string())
}

fn store(
    connection: ConnectionKey,
    server: &str,
    grant: &Grant,
    access: &str,
    app_state: &AppState,
) -> Result<(), String> {
    let dir = &app_state.app_data_dir;
    let grant = serde_json::to_string(grant).map_err(|e| e.to_string())?;
    KeychainStore::set_secret(
        KEYCHAIN_SERVICE,
        &account(connection, server, OAUTH_KEY),
        &grant,
        dir,
    )?;
    KeychainStore::set_secret(
        KEYCHAIN_SERVICE,
        &account(connection, server, AUTHORIZATION),
        &format!("Bearer {access}"),
        dir,
    )
}

/// Wait for the browser to come back with `?code=…&state=…`, and answer it with a page saying
/// how it went.
async fn receive_code(listener: TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("The sign-in listener failed: {e}"))?;
        let mut buffer = vec![0u8; 16 * 1024];
        let read = stream.read(&mut buffer).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]);
        let target = request.split_whitespace().nth(1).unwrap_or("/");
        let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
            continue;
        };
        if url.path() != "/callback" {
            // The browser asking for a favicon, most likely.
            if let Err(e) = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
            {
                log::debug!("[mcp] answering a stray sign-in request failed: {e}");
            }
            continue;
        }
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
        let outcome = if params.get("state").map(String::as_str) != Some(state) {
            Err("The sign-in answer did not match the request".to_string())
        } else if let Some(code) = params.get("code") {
            Ok(code.clone())
        } else {
            let reason = params
                .get("error_description")
                .or_else(|| params.get("error"))
                .map_or("no reason given", String::as_str);
            Err(redirect_hint(format!("Sign-in was refused: {reason}")))
        };
        let message = match &outcome {
            Ok(_) => "Signed in. You can close this tab and return to Maestro.",
            Err(_) => "Sign-in failed. Return to Maestro for the reason.",
        };
        let page = format!("<!doctype html><title>Maestro</title><p style=\"font-family:sans-serif\">{message}</p>");
        if let Err(e) = stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
                    page.len()
                )
                .as_bytes(),
            )
            .await
        {
            log::warn!("[mcp] answering the sign-in redirect failed: {e}");
        }
        return outcome;
    }
}

/// A refusal naming the redirect is almost always a registered app that does not list ours; say
/// which address to add, the one thing the user cannot find anywhere else.
fn redirect_hint(message: String) -> String {
    if message.to_lowercase().contains("redirect") {
        format!(
            "{message}. Add http://127.0.0.1:{REDIRECT_PORT}/callback as a redirect URL in the OAuth app's settings."
        )
    } else {
        message
    }
}

/// Send an initialize with no credentials, which a server that wants OAuth answers with a 401
/// pointing at its metadata. Returns the status and the `WWW-Authenticate` header.
async fn challenge(
    client: &reqwest::Client,
    server_url: &Url,
) -> Result<(reqwest::StatusCode, String), String> {
    let response = client
        .post(server_url.clone())
        .header(ACCEPT, "application/json, text/event-stream")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "maestro", "version": env!("CARGO_PKG_VERSION") },
            },
        }))
        .send()
        .await
        .map_err(|e| format!("Reaching {server_url} failed: {e}"))?;
    let header = response
        .headers()
        .get(WWW_AUTHENTICATE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    Ok((response.status(), header))
}

/// Whether the server at `url` needs an OAuth sign-in: it turns away a client with no credentials
/// and publishes protected resource metadata, which the MCP spec requires of an OAuth server and a
/// plain API key server has no reason to. Asked from this machine, not the connection's.
#[tauri::command]
#[specta::specta]
pub async fn mcp_requires_oauth(url: String) -> Result<bool, String> {
    let server_url = Url::parse(url.trim()).map_err(|e| format!("Invalid URL: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let (status, header) = challenge(&client, &server_url).await?;
    if status != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(false);
    }
    if challenge_param(&header, "resource_metadata").is_some() {
        return Ok(true);
    }
    Ok(
        first_json(&client, well_known(&server_url, "oauth-protected-resource"))
            .await
            .is_some(),
    )
}

/// Sign-ins not saved yet, by the id `authorize_mcp_server` returned: the grant and its access
/// token.
static PENDING: LazyLock<Mutex<HashMap<String, (Grant, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The `Authorization` value of a sign-in not saved yet, for testing the connection with it.
pub(crate) fn pending_authorization(id: &str) -> Option<String> {
    let pending = PENDING.lock().ok()?;
    pending
        .get(id)
        .map(|(_, access)| format!("Bearer {access}"))
}

/// Store a sign-in under the server it was saved as, and forget it here.
pub(crate) fn commit(
    connection: ConnectionKey,
    server: &str,
    id: &str,
    app_state: &AppState,
) -> Result<(), String> {
    let (grant, access) = PENDING
        .lock()
        .map_err(|e| e.to_string())?
        .remove(id)
        .ok_or("The OAuth sign-in is no longer available; sign in again")?;
    store(connection, server, &grant, &access, app_state)
}

/// Forget a sign-in the user did not save.
#[tauri::command]
#[specta::specta]
pub fn discard_mcp_authorization(id: String) {
    if let Ok(mut pending) = PENDING.lock() {
        pending.remove(&id);
    }
}

/// The grant a saved server holds.
fn stored_grant(connection: ConnectionKey, server: &str, app_state: &AppState) -> Option<Grant> {
    let stored = KeychainStore::get_secret(
        KEYCHAIN_SERVICE,
        &account(connection, server, OAUTH_KEY),
        &app_state.app_data_dir,
    )
    .ok()??;
    serde_json::from_str(&stored).ok()
}

/// Put client settings changed while editing a saved server into its grant, when no new sign-in
/// came with them. Refreshing the token is the only thing that uses them.
pub(crate) fn update_stored_client(
    connection: ConnectionKey,
    server: &str,
    settings: &McpOAuthSettings,
    app_state: &AppState,
) -> Result<(), String> {
    let Some(mut grant) = stored_grant(connection, server, app_state) else {
        return Ok(());
    };
    if !settings.client_secret.is_empty() {
        grant.client_secret = Some(settings.client_secret.clone());
    }
    if !settings.private_key.is_empty() {
        grant.private_key = Some(settings.private_key.clone());
    }
    grant.key_id = filled(&settings.key_id);
    grant.algorithm = filled(&settings.algorithm);
    if !matches!(settings.client_auth.as_str(), "" | "auto") {
        grant.client_auth = settings.client_auth.clone();
    }
    let grant = serde_json::to_string(&grant).map_err(|e| e.to_string())?;
    KeychainStore::set_secret(
        KEYCHAIN_SERVICE,
        &account(connection, server, OAUTH_KEY),
        &grant,
        &app_state.app_data_dir,
    )
}

fn filled(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Sign in to the MCP server at `url` in the browser. Returns the id the sign-in is held under
/// until `save_mcp_server` stores it or `discard_mcp_authorization` drops it. `stored_as` names
/// the saved server being edited, whose client secret or key fills one left blank.
#[tauri::command]
#[specta::specta]
pub async fn authorize_mcp_server(
    app: AppHandle,
    app_state: tauri::State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    url: String,
    settings: Option<McpOAuthSettings>,
    stored_as: Option<String>,
) -> Result<String, String> {
    let settings = settings.unwrap_or_default();
    let stored = stored_as
        .as_deref()
        .and_then(|server| stored_grant(connection, server, &app_state));
    let client_secret = Some(settings.client_secret.clone())
        .filter(|secret| !secret.is_empty())
        .or_else(|| {
            stored
                .as_ref()
                .and_then(|grant| grant.client_secret.clone())
        });
    let private_key = Some(settings.private_key.clone())
        .filter(|key| !key.is_empty())
        .or_else(|| stored.as_ref().and_then(|grant| grant.private_key.clone()));
    let own_client = filled(&settings.client_id);
    let resource = url.trim().to_string();
    let server_url = Url::parse(&resource).map_err(|e| format!("Invalid URL: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let (_, header) = challenge(&client, &server_url).await?;
    let mut candidates: Vec<String> = challenge_param(&header, "resource_metadata")
        .into_iter()
        .collect();
    candidates.extend(well_known(&server_url, "oauth-protected-resource"));
    let metadata = first_json(&client, candidates).await;
    // A server from before protected resource metadata is its own authorization server.
    let issuer = metadata
        .as_ref()
        .and_then(|m| m["authorization_servers"][0].as_str())
        .map_or_else(|| server_url.origin().ascii_serialization(), str::to_string);
    let scope = filled(&settings.scopes)
        .or_else(|| challenge_param(&header, "scope"))
        .or_else(|| {
            let scopes: Vec<&str> = metadata.as_ref()?["scopes_supported"]
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect();
            (!scopes.is_empty()).then(|| scopes.join(" "))
        });

    let issuer_url = Url::parse(&issuer).map_err(|e| format!("Invalid issuer {issuer}: {e}"))?;
    let mut candidates = well_known(&issuer_url, "oauth-authorization-server");
    candidates.extend(well_known(&issuer_url, "openid-configuration"));
    candidates.push(format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    ));
    let origin = issuer_url.origin().ascii_serialization();
    let server = first_json(&client, candidates).await.unwrap_or_else(|| {
        json!({
            "authorization_endpoint": format!("{origin}/authorize"),
            "token_endpoint": format!("{origin}/token"),
            "registration_endpoint": format!("{origin}/register"),
        })
    });
    let endpoint = |key: &str| {
        server[key]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("{issuer} does not name its {key}"))
    };
    let authorization_endpoint = endpoint("authorization_endpoint")?;
    let token_endpoint = endpoint("token_endpoint")?;
    let supported: Vec<&str> = server["token_endpoint_auth_methods_supported"]
        .as_array()
        .map(|methods| methods.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();

    let port = if own_client.is_some() {
        REDIRECT_PORT
    } else {
        0
    };
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Opening the sign-in listener on port {port} failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");

    let (client_id, client_secret, client_auth) = match own_client {
        Some(client_id) => {
            let method = pick_client_auth(
                &settings.client_auth,
                &supported,
                client_secret.is_some(),
                private_key.is_some(),
            );
            (client_id, client_secret, method)
        }
        None => {
            let registration_endpoint = endpoint("registration_endpoint").map_err(|_| {
                format!(
                    "{issuer} does not register clients itself. Register an OAuth app with it and enter its client ID under Client settings."
                )
            })?;
            let registration = client
                .post(&registration_endpoint)
                .json(&json!({
                    "client_name": "Maestro",
                    "redirect_uris": [redirect],
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "token_endpoint_auth_method": "none",
                }))
                .send()
                .await
                .map_err(|e| format!("Registering with {issuer} failed: {e}"))?;
            let status = registration.status();
            let registration: Value = registration.json().await.unwrap_or(Value::Null);
            let client_id = registration["client_id"].as_str().ok_or_else(|| {
                format!(
                    "Registering with {issuer} failed: {}",
                    describe_error(&registration, status.as_str())
                )
            })?;
            let secret = registration["client_secret"].as_str().map(str::to_string);
            // What the server settled on, which need not be the "none" asked for.
            let method = registration["token_endpoint_auth_method"]
                .as_str()
                .map_or_else(
                    || {
                        if secret.is_some() {
                            "client_secret_post"
                        } else {
                            "none"
                        }
                        .to_string()
                    },
                    str::to_string,
                );
            (client_id.to_string(), secret, method)
        }
    };

    let verifier = random_token();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token();
    let mut authorize = Url::parse(&authorization_endpoint)
        .map_err(|e| format!("Invalid authorization endpoint: {e}"))?;
    {
        let mut query = authorize.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("resource", &resource);
        if let Some(scope) = &scope {
            query.append_pair("scope", scope);
        }
    }
    app.opener()
        .open_url(authorize.as_str(), None::<&str>)
        .map_err(|e| format!("Opening the browser failed: {e}"))?;

    let code = tokio::time::timeout(SIGN_IN_TIMEOUT, receive_code(listener, &state))
        .await
        .map_err(|_| "Sign-in timed out".to_string())??;

    let mut grant = Grant {
        token_endpoint,
        client_id,
        client_secret,
        resource,
        refresh_token: None,
        expires_at: None,
        client_auth,
        private_key,
        key_id: filled(&settings.key_id),
        algorithm: filled(&settings.algorithm),
    };
    let access = request_token(
        &client,
        &mut grant,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect),
            ("code_verifier", &verifier),
        ],
    )
    .await
    .map_err(redirect_hint)?;
    log::info!("[mcp] signed in to {}", grant.resource);
    let id = uuid::Uuid::new_v4().to_string();
    PENDING
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), (grant, access));
    Ok(id)
}

/// Refresh the server's token when it is about to run out, and say when the one it now holds
/// does. `None` when it has no OAuth grant or the grant never expires.
pub(crate) async fn refresh_if_due(
    connection: ConnectionKey,
    server: &str,
    app_state: &AppState,
) -> Option<u64> {
    let stored = KeychainStore::get_secret(
        KEYCHAIN_SERVICE,
        &account(connection, server, OAUTH_KEY),
        &app_state.app_data_dir,
    )
    .ok()??;
    let mut grant: Grant = serde_json::from_str(&stored).ok()?;
    let expires_at = grant.expires_at?;
    if expires_at > now() + REFRESH_MARGIN {
        return Some(expires_at);
    }
    let refresh = grant.refresh_token.clone()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .ok()?;
    let refreshed = request_token(
        &client,
        &mut grant,
        &[("grant_type", "refresh_token"), ("refresh_token", &refresh)],
    )
    .await
    .and_then(|access| store(connection, server, &grant, &access, app_state));
    match refreshed {
        Ok(()) => grant.expires_at,
        Err(e) => {
            log::warn!("[mcp] refreshing the token of {server} on {connection:?} failed: {e}");
            None
        }
    }
}

static REFRESHERS: LazyLock<Mutex<HashMap<ConnectionKey, tokio::task::JoinHandle<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Push the connection's secrets again shortly before `expires_at`, so the daemon, which holds
/// them in memory only, is never left handing agents a dead token. Replaces any earlier timer.
pub(crate) fn schedule_refresh(
    app_state: &Arc<AppState>,
    connection: ConnectionKey,
    expires_at: Option<u64>,
) {
    let Ok(mut timers) = REFRESHERS.lock() else {
        return;
    };
    if let Some(previous) = timers.remove(&connection) {
        previous.abort();
    }
    let Some(expires_at) = expires_at else {
        return;
    };
    let wait = expires_at.saturating_sub(now() + REFRESH_MARGIN).max(30);
    let app_state = Arc::clone(app_state);
    // Boxed, because a future that spawns itself would otherwise have an infinitely sized type.
    let push: Pin<Box<dyn Future<Output = Result<(), String>> + Send>> = Box::pin(async move {
        tokio::time::sleep(Duration::from_secs(wait)).await;
        push_secrets(&app_state, connection).await
    });
    timers.insert(
        connection,
        tokio::spawn(async move {
            if let Err(e) = push.await {
                log::warn!("[mcp] pushing refreshed tokens to {connection:?} failed: {e}");
            }
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_known_urls_try_the_path_first() {
        let url = Url::parse("https://example.com/mcp/").unwrap();
        assert_eq!(
            well_known(&url, "oauth-protected-resource"),
            [
                "https://example.com/.well-known/oauth-protected-resource/mcp",
                "https://example.com/.well-known/oauth-protected-resource",
            ]
        );
        let bare = Url::parse("https://example.com").unwrap();
        assert_eq!(
            well_known(&bare, "oauth-authorization-server"),
            ["https://example.com/.well-known/oauth-authorization-server"]
        );
    }

    #[test]
    fn automatic_client_auth_follows_the_credentials_and_the_server() {
        assert_eq!(pick_client_auth("auto", &[], false, false), "none");
        assert_eq!(
            pick_client_auth("auto", &[], true, false),
            "client_secret_basic"
        );
        assert_eq!(
            pick_client_auth("auto", &["client_secret_post"], true, false),
            "client_secret_post"
        );
        assert_eq!(pick_client_auth("auto", &[], true, true), "private_key_jwt");
        assert_eq!(
            pick_client_auth("client_secret_post", &[], false, false),
            "client_secret_post"
        );
    }

    #[test]
    fn a_client_secret_jwt_is_signed_for_the_token_endpoint() {
        let grant = Grant {
            token_endpoint: "https://auth.example.com/token".to_string(),
            client_id: "maestro".to_string(),
            client_secret: Some("s3cret".to_string()),
            resource: "https://mcp.example.com".to_string(),
            refresh_token: None,
            expires_at: None,
            client_auth: "client_secret_jwt".to_string(),
            private_key: None,
            key_id: None,
            algorithm: None,
        };
        let token = client_assertion(&grant).expect("signed");
        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
        validation.set_audience(&["https://auth.example.com/token"]);
        let decoded = jsonwebtoken::decode::<Value>(
            &token,
            &jsonwebtoken::DecodingKey::from_secret(b"s3cret"),
            &validation,
        )
        .expect("valid");
        assert_eq!(decoded.claims["iss"], "maestro");
        assert_eq!(decoded.claims["sub"], "maestro");
    }

    #[test]
    fn challenge_params_are_read_quoted_or_not() {
        let header = r#"Bearer error="invalid_token", resource_metadata="https://x.dev/.well-known/oauth-protected-resource", scope=read"#;
        assert_eq!(
            challenge_param(header, "resource_metadata").as_deref(),
            Some("https://x.dev/.well-known/oauth-protected-resource")
        );
        assert_eq!(challenge_param(header, "scope").as_deref(), Some("read"));
        assert_eq!(challenge_param(header, "realm"), None);
    }
}
