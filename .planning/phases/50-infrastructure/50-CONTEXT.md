---
phase: 50
name: Infrastructure
status: complete
completed: 2026-05-21
---

# Phase 50: Infrastructure — Context

## Goal

The app can make authenticated HTTP calls to all four provider APIs and handle OAuth localhost redirects.

## Decisions

- **D-01:** CSP expanded to allow `api.github.com`, `github.com`, `gitlab.com`, `api.linear.app`, `auth.atlassian.com`, `api.atlassian.com`, `127.0.0.1` (OAuth redirect port)
- **D-02:** `tauri-plugin-oauth = "2"` registered in `main.rs` via `.plugin(tauri_plugin_oauth::init())`
- **D-03:** OAuth capabilities `oauth:allow-start` and `oauth:allow-cancel` added to `capabilities/default.json`
- **D-04:** Cargo deps added: `tauri-plugin-oauth`, `oauth2 5` (no default features), `octocrab 0.51` (rustls + jwt-rust-crypto), `graphql_client 0.16` (reqwest feature)
- **D-05:** `keyring` features expanded: `windows-native` + `apple-native` + `linux-native-sync-persistent`

## Implementation Notes

Work was done as a single commit (`18389de`) outside GSD phase structure. OAuth capabilities (`oauth:allow-start`, `oauth:allow-cancel`) were added in a follow-up fix commit to complete the phase.
