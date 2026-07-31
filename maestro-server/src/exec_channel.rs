//! Exec-channel mode: run commands on this host on behalf of Maestro.
//!
//! Entered with `maestro-server exec-channel`. The host starts one of these per connection and
//! keeps it, so running a command costs a frame on an open pipe instead of a `wsl.exe` or
//! `docker exec` start — measured at 264ms per command on WSL.
//!
//! Deliberately a separate process and a separate loop from `dispatch.rs`: commands here run
//! concurrently and may produce megabytes, neither of which the ACP loop tolerates.

use std::process::Stdio;
use std::sync::Arc;

use maestro_protocol::exec::{ExecCommand, ExecEvent, ExecStream, RequestId, EXEC_CHUNK_SIZE};
use maestro_protocol::{read_frame, write_frame};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::command_ext::NoConsoleWindow;

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    serve(tokio::io::stdin(), Arc::new(Mutex::new(tokio::io::stdout()))).await
}

/// The channel loop, over any pair of streams so it can be driven in tests.
async fn serve<R, W>(mut input: R, output: Arc<Mutex<W>>) -> Result<(), Box<dyn std::error::Error>>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut running = Vec::new();
    loop {
        let command: ExecCommand = match read_frame(&mut input).await {
            Ok(command) => command,
            // The host closed the pipe, or sent something this build cannot parse. Either way
            // there is no way to answer, so exit rather than spin.
            Err(_) => break,
        };
        running.push(tokio::spawn(execute(command, Arc::clone(&output))));
    }

    // Let commands already in flight report their results before the process goes away.
    for handle in running {
        let _ = handle.await;
    }
    Ok(())
}

async fn execute<W: AsyncWrite + Unpin + Send + 'static>(
    command: ExecCommand,
    output: Arc<Mutex<W>>,
) {
    let id = command.id;
    let mut child = {
        let mut builder = tokio::process::Command::new(&command.program);
        builder
            .args(&command.args)
            .stdin(if command.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .no_console_window();
        if let Some(ref cwd) = command.cwd {
            builder.current_dir(cwd);
        }
        for (name, value) in &command.env {
            builder.env(name, value);
        }
        match builder.spawn() {
            Ok(child) => child,
            Err(e) => {
                send(
                    &output,
                    &ExecEvent::Failed { id, message: format!("{}: {}", command.program, e) },
                )
                .await;
                return;
            }
        }
    };

    if let (Some(bytes), Some(mut sink)) = (command.stdin.as_ref(), child.stdin.take()) {
        // Errors here are the child having exited early, which its status already reports.
        if sink.write_all(bytes).await.is_ok() {
            let _ = sink.flush().await;
        }
        drop(sink);
    }

    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        readers.push(tokio::spawn(forward(id, ExecStream::Stdout, stdout, Arc::clone(&output))));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(tokio::spawn(forward(id, ExecStream::Stderr, stderr, Arc::clone(&output))));
    }

    let status = child.wait().await;
    // Drain both pipes before reporting the exit, so the host never sees `Exit` ahead of output.
    for reader in readers {
        let _ = reader.await;
    }

    let event = match status {
        Ok(status) => ExecEvent::Exit { id, code: status.code().unwrap_or(-1) },
        Err(e) => ExecEvent::Failed { id, message: format!("wait failed: {}", e) },
    };
    send(&output, &event).await;
}

async fn forward<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    id: RequestId,
    stream: ExecStream,
    mut source: R,
    output: Arc<Mutex<W>>,
) {
    let mut buffer = vec![0u8; EXEC_CHUNK_SIZE];
    loop {
        match source.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                send(&output, &ExecEvent::Chunk { id, stream, bytes: buffer[..n].to_vec() }).await;
            }
        }
    }
}

/// One frame, written under the lock so concurrent commands never interleave mid-frame.
async fn send<W: AsyncWrite + Unpin>(output: &Arc<Mutex<W>>, event: &ExecEvent) {
    let mut guard = output.lock().await;
    if write_frame(&mut *guard, event).await.is_ok() {
        let _ = guard.flush().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Collect every event the given commands produce, running them through the same code the
    /// channel loop uses.
    async fn run_all(commands: Vec<ExecCommand>) -> Vec<ExecEvent> {
        let output = Arc::new(Mutex::new(Cursor::new(Vec::new())));
        let mut handles = Vec::new();
        for command in commands {
            handles.push(tokio::spawn(execute(command, Arc::clone(&output))));
        }
        for handle in handles {
            handle.await.expect("command task should not panic");
        }

        let bytes = output.lock().await.get_ref().clone();
        let mut cursor = Cursor::new(bytes);
        let mut events = Vec::new();
        while let Ok(event) = read_frame::<_, ExecEvent>(&mut cursor).await {
            events.push(event);
        }
        events
    }

    fn command(id: RequestId, program: &str, args: &[&str]) -> ExecCommand {
        ExecCommand {
            id,
            cwd: None,
            program: program.to_string(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: Vec::new(),
            stdin: None,
        }
    }

    fn text_of(events: &[ExecEvent], id: RequestId, want: ExecStream) -> String {
        let mut collected = Vec::new();
        for event in events {
            if let ExecEvent::Chunk { id: chunk_id, stream, bytes } = event {
                if *chunk_id == id && *stream == want {
                    collected.extend_from_slice(bytes);
                }
            }
        }
        String::from_utf8_lossy(&collected).into_owned()
    }

    fn exit_of(events: &[ExecEvent], id: RequestId) -> Option<i32> {
        events.iter().find_map(|event| match event {
            ExecEvent::Exit { id: exit_id, code } if *exit_id == id => Some(*code),
            _ => None,
        })
    }

    /// The whole loop over in-memory pipes: real frames in, real frames out, two commands at once.
    #[tokio::test]
    async fn the_channel_loop_reads_frames_and_answers_them() {
        let mut input = Vec::new();
        for command in [command(10, "git", &["--version"]), command(11, "git", &["--version"])] {
            write_frame(&mut input, &command).await.expect("encode command");
        }

        let output = Arc::new(Mutex::new(Cursor::new(Vec::new())));
        serve(Cursor::new(input), Arc::clone(&output)).await.expect("serve");

        let bytes = output.lock().await.get_ref().clone();
        let mut cursor = Cursor::new(bytes);
        let mut events = Vec::new();
        while let Ok(event) = read_frame::<_, ExecEvent>(&mut cursor).await {
            events.push(event);
        }

        for id in [10, 11] {
            assert!(text_of(&events, id, ExecStream::Stdout).starts_with("git version"));
            assert_eq!(exit_of(&events, id), Some(0));
        }
    }

    #[tokio::test]
    async fn concurrent_commands_keep_their_output_apart() {
        // Interleaving is the point: the slower command is started first, so its output has to
        // arrive tagged rather than in order.
        let events = run_all(vec![
            command(1, "git", &["--version"]),
            command(2, "git", &["config", "--get", "--default", "second", "maestro.test"]),
        ])
        .await;

        assert!(text_of(&events, 1, ExecStream::Stdout).starts_with("git version"));
        assert_eq!(text_of(&events, 2, ExecStream::Stdout).trim(), "second");
        assert_eq!(exit_of(&events, 1), Some(0));
        assert_eq!(exit_of(&events, 2), Some(0));
    }

    #[tokio::test]
    async fn stderr_and_exit_code_are_reported_separately() {
        let events = run_all(vec![command(3, "git", &["rev-parse", "--verify", "no-such-ref"])]).await;

        assert_eq!(text_of(&events, 3, ExecStream::Stdout), "");
        assert!(!text_of(&events, 3, ExecStream::Stderr).is_empty());
        assert!(matches!(exit_of(&events, 3), Some(code) if code != 0));
    }

    #[tokio::test]
    async fn stdin_reaches_the_child() {
        let mut with_stdin = command(4, "git", &["hash-object", "--stdin"]);
        with_stdin.stdin = Some(b"maestro".to_vec());
        let events = run_all(vec![with_stdin]).await;

        // The object id git produces for exactly these seven bytes — wrong or truncated stdin
        // gives a different hash, so this pins delivery rather than just "something happened".
        assert_eq!(
            text_of(&events, 4, ExecStream::Stdout).trim(),
            "9c8fd3e9390b4de93462a1551e59851b762d63ab"
        );
        assert_eq!(exit_of(&events, 4), Some(0));
    }

    #[tokio::test]
    async fn a_missing_program_fails_rather_than_exiting() {
        let events = run_all(vec![command(5, "maestro-no-such-program", &[])]).await;

        assert_eq!(exit_of(&events, 5), None);
        assert!(matches!(
            events.first(),
            Some(ExecEvent::Failed { id: 5, message }) if message.contains("maestro-no-such-program")
        ));
    }

    #[tokio::test]
    async fn output_larger_than_one_chunk_is_split_and_reassembles_in_order() {
        // Driven through `forward` directly rather than a child process: producing half a
        // megabyte portably from a command line is awkward, and the chunking is what matters.
        let payload: Vec<u8> = (0..EXEC_CHUNK_SIZE * 2 + 17).map(|i| (i % 251) as u8).collect();
        let output = Arc::new(Mutex::new(Cursor::new(Vec::new())));
        forward(6, ExecStream::Stdout, Cursor::new(payload.clone()), Arc::clone(&output)).await;

        let bytes = output.lock().await.get_ref().clone();
        let mut cursor = Cursor::new(bytes);
        let mut events = Vec::new();
        while let Ok(event) = read_frame::<_, ExecEvent>(&mut cursor).await {
            events.push(event);
        }

        assert!(events.len() > 2, "payload should have needed more than one chunk");
        let mut reassembled = Vec::new();
        for event in &events {
            match event {
                ExecEvent::Chunk { id: 6, bytes, .. } => reassembled.extend_from_slice(bytes),
                other => panic!("unexpected event: {:?}", other),
            }
        }
        assert_eq!(reassembled, payload);
    }
}
