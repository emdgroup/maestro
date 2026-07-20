use std::collections::HashMap;
use std::process::Stdio;
use crate::command_ext::NoConsoleWindow;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use agent_client_protocol as acp;
use acp::schema::v1::{
    CreateTerminalRequest, CreateTerminalResponse, TerminalId,
};
use maestro_protocol::{MaestroRpcMessage, ServerResponse, TerminalOutput};
use tokio::sync::{mpsc, Mutex, Notify};

use crate::file_ops::truncate_buf;
use crate::send_response;
use crate::sessions::{TerminalExitInfo, TerminalHandle};

/// Handle create_terminal request: spawn subprocess, set up background reader.
pub(crate) async fn handle_create_terminal(
    args: CreateTerminalRequest,
    terminals: Arc<Mutex<HashMap<String, TerminalHandle>>>,
    terminal_counter: Arc<AtomicU64>,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
    maestro_session_id: String,
) -> acp::Result<CreateTerminalResponse> {
    // T-42-01: Validate cwd exists before spawning
    if let Some(ref cwd) = args.cwd {
        for component in cwd.components() {
            if component == std::path::Component::ParentDir {
                return Err(acp::Error::new(
                    -32603,
                    format!("cwd contains '..' component: {}", cwd.display()),
                ));
            }
        }
        match tokio::fs::metadata(cwd).await {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => {
                return Err(acp::Error::new(
                    -32603,
                    format!("cwd is not a directory: {}", cwd.display()),
                ));
            }
            Err(e) => {
                return Err(acp::Error::new(
                    -32603,
                    format!("cwd does not exist: {}: {}", cwd.display(), e),
                ));
            }
        }
    }

    let terminal_id = format!("term-{}", terminal_counter.fetch_add(1, Ordering::Relaxed) + 1);

    // T-42-02: Use Command::new(program).args(args) — never shell strings
    let mut cmd = tokio::process::Command::new(&args.command);
    cmd.args(&args.args);
    for var in &args.env {
        cmd.env(&var.name, &var.value);
    }
    if let Some(ref cwd) = args.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    cmd.kill_on_drop(true);
    cmd.no_console_window();

    let mut child = cmd
        .spawn()
        .map_err(|e| acp::Error::new(-32603, e.to_string()))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let output_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let truncated: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    let exit_status: Arc<Mutex<Option<TerminalExitInfo>>> = Arc::new(Mutex::new(None));
    let exit_notify: Arc<Notify> = Arc::new(Notify::new());
    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();

    let output_buf_bg = Arc::clone(&output_buf);
    let truncated_bg = Arc::clone(&truncated);
    let exit_status_bg = Arc::clone(&exit_status);
    let exit_notify_bg = Arc::clone(&exit_notify);
    let stdout_bg = Arc::clone(&stdout);
    let terminal_id_bg = terminal_id.clone();
    let output_byte_limit = args.output_byte_limit;

    // Background reader task — streams terminal output to stdout
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let (line_tx, mut line_rx) = mpsc::channel::<String>(32);

        if let Some(pipe) = stdout_pipe {
            let tx = line_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if tx.send(line).await.is_err() {
                        break;
                    }
                }
            });
        }

        if let Some(pipe) = stderr_pipe {
            let tx = line_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if tx.send(line).await.is_err() {
                        break;
                    }
                }
            });
        }

        drop(line_tx);

        let mut kill_rx = kill_rx;
        let killed = loop {
            tokio::select! {
                biased;
                _ = &mut kill_rx => break true,
                item = line_rx.recv() => {
                    match item {
                        Some(line) => {
                            let chunk = format!("{}\n", line);
                            // T-42-03: Respect output_byte_limit — truncate from beginning
                            {
                                let mut buf = output_buf_bg.lock().await;
                                buf.push_str(&chunk);
                                if let Some(limit) = output_byte_limit {
                                    if buf.len() > limit as usize {
                                        truncate_buf(&mut buf, limit as usize);
                                        truncated_bg.store(true, Ordering::Relaxed);
                                    }
                                }
                            }
                            let msg = MaestroRpcMessage::Response(
                                ServerResponse::TerminalOutput(TerminalOutput {
                                    session_id: maestro_session_id.clone(),
                                    terminal_id: terminal_id_bg.clone(),
                                    bytes: chunk.into_bytes(),
                                }),
                            );
                            if let Err(e) = send_response(&stdout_bg, &msg).await {
                                eprintln!("[terminal] send TerminalOutput failed: {e}");
                            }
                        }
                        None => break false,
                    }
                }
            }
        };

        if killed {
            let _ = child.start_kill();
        }

        let exit_info = match child.wait().await {
            Ok(status) => {
                let exit_code = status.code().map(|c| c as u32);
                #[cfg(unix)]
                let signal = {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal().map(|s| format!("SIG{}", s))
                };
                #[cfg(not(unix))]
                let signal: Option<String> = None;
                TerminalExitInfo { exit_code, signal }
            }
            Err(_) => TerminalExitInfo {
                exit_code: None,
                signal: None,
            },
        };

        *exit_status_bg.lock().await = Some(exit_info);
        exit_notify_bg.notify_one();
    });

    let handle = TerminalHandle {
        output_buf,
        truncated,
        exit_status,
        exit_notify,
        kill_tx: Mutex::new(Some(kill_tx)),
    };
    terminals.lock().await.insert(terminal_id.clone(), handle);

    Ok(CreateTerminalResponse::new(TerminalId::new(&*terminal_id)))
}
