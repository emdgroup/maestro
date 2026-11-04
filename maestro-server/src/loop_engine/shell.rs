//! The shell runner: a loop's steps and command checks, each run in the user's shell in the
//! loop's worktree, its output tailed and killed with everything it started past its limit.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use maestro_protocol::command_ext::NoConsoleWindow;
use maestro_protocol::{LoopCheck, LoopCheckState, LoopConfig};

use super::{duration_words, tail_chars, OUTPUT_CHARS};
use crate::task_store::loops;

/// How much of a command's output is kept, from the end.
const TAIL_LINES: usize = 200;
const LINE_CHARS: usize = 2000;
/// How long the output of a command that exited is still read, for a child it left holding the
/// pipe open.
const DRAIN_GRACE: Duration = Duration::from_secs(5);

/// What one run of the checks found.
#[derive(Debug, Default)]
pub(super) struct CheckRun {
    /// The steps that ran, by id, in order.
    pub(super) steps: Vec<(i32, LoopCheckState, Option<String>)>,
    /// Every command check, by id.
    pub(super) results: Vec<(i32, LoopCheckState, Option<String>)>,
    pub(super) flaky: Vec<String>,
    pub(super) all_pass: bool,
    /// The failing checks' output, for the next iteration and the stall rule.
    pub(super) output: String,
}

/// The steps, then every command check, run in the loop's worktree, where the sealed files simply
/// are, each within its own time limit or the loop's. A failing step stops the steps after it and
/// fails every check unrun. `on_result` hears each result as soon as it exists.
pub(super) async fn run_commands<F, Fut>(
    dir: &str,
    config: &LoopConfig,
    checks: &[LoopCheck],
    mut on_result: F,
) -> CheckRun
where
    F: FnMut(&LoopCheck, LoopCheckState, Option<String>) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let default = config.check_timeout_secs;
    let limit = |c: &LoopCheck| Duration::from_secs(c.timeout_secs.unwrap_or(default).into());
    let runnable: Vec<&LoopCheck> = checks.iter().filter(|c| loops::is_runnable(c)).collect();
    let mut run = CheckRun::default();

    for (k, step) in checks.iter().filter(|c| loops::is_setup(c)).enumerate() {
        let command = step.command.as_deref().unwrap_or_default();
        let ran = run_shell(dir, command, limit(step)).await;
        if ran.passed {
            on_result(step, LoopCheckState::Pass, Some(ran.tail.clone())).await;
            run.steps
                .push((step.id, LoopCheckState::Pass, Some(ran.tail)));
            continue;
        }
        let output = ran.describe(limit(step));
        on_result(step, LoopCheckState::Fail, Some(output.clone())).await;
        run.steps
            .push((step.id, LoopCheckState::Fail, Some(output.clone())));
        let named = format!("Step {} ({})", k + 1, step.label);
        let detail = format!("{named} failed, so no check ran.");
        for check in &runnable {
            on_result(check, LoopCheckState::Fail, Some(detail.clone())).await;
            run.results
                .push((check.id, LoopCheckState::Fail, Some(detail.clone())));
        }
        run.output = tail_chars(&format!("### {named}\n{output}"), OUTPUT_CHARS);
        return run;
    }

    let mut failing = Vec::new();
    for check in &runnable {
        let command = check.command.as_deref().unwrap_or_default();
        let limit = limit(check);
        let first = run_shell(dir, command, limit).await;
        let (state, detail) = if first.passed {
            (LoopCheckState::Pass, first.tail)
        } else if first.timed_out {
            (LoopCheckState::Fail, first.describe(limit))
        } else {
            // The same commit in the same state: a different answer is the check, not the code.
            let second = run_shell(dir, command, limit).await;
            if second.passed {
                run.flaky.push(check.label.clone());
                (
                    LoopCheckState::Flaky,
                    format!("Failed, then passed on the same commit.\n{}", first.tail),
                )
            } else {
                (LoopCheckState::Fail, second.describe(limit))
            }
        };
        if state != LoopCheckState::Pass {
            failing.push(format!("### {}\n{detail}", check.label));
        }
        on_result(check, state, Some(detail.clone())).await;
        run.results.push((check.id, state, Some(detail)));
    }
    run.all_pass = failing.is_empty();
    run.output = tail_chars(&failing.join("\n\n"), OUTPUT_CHARS);
    run
}

/// How one command went.
#[derive(Debug)]
struct Ran {
    passed: bool,
    timed_out: bool,
    /// The last lines of stdout and stderr, interleaved as they arrived.
    tail: String,
}

impl Ran {
    fn describe(&self, limit: Duration) -> String {
        if self.timed_out {
            let limit = duration_words(limit.as_secs() as u32);
            format!("Timed out after {limit}.\n{}", self.tail)
        } else {
            self.tail.clone()
        }
    }
}

/// The user's shell runs `command` in `dir`. Past `limit` it is killed, with everything it started.
async fn run_shell(dir: &str, command: &str, limit: Duration) -> Ran {
    let failed = |tail: String| Ran {
        passed: false,
        timed_out: false,
        tail,
    };
    let mut shell = shell(command);
    shell
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .no_console_window();
    let mut child = match shell.spawn() {
        Ok(child) => child,
        Err(e) => return failed(format!("cannot run the command: {e}")),
    };
    let lines = Arc::new(Mutex::new(VecDeque::new()));
    let readers: Vec<_> = [
        child
            .stdout
            .take()
            .map(|out| tokio::spawn(collect(out, Arc::clone(&lines)))),
        child
            .stderr
            .take()
            .map(|err| tokio::spawn(collect(err, Arc::clone(&lines)))),
    ]
    .into_iter()
    .flatten()
    .collect();

    let (passed, timed_out) = match tokio::time::timeout(limit, child.wait()).await {
        Ok(Ok(status)) => (status.success(), false),
        Ok(Err(e)) => {
            lines
                .lock()
                .unwrap()
                .push_back(format!("cannot wait for the command: {e}"));
            (false, false)
        }
        Err(_) => {
            if let Some(pid) = child.id() {
                kill_tree(pid).await;
            }
            let _ = child.kill().await;
            (false, true)
        }
    };
    for reader in readers {
        let abort = reader.abort_handle();
        if tokio::time::timeout(DRAIN_GRACE, reader).await.is_err() {
            abort.abort();
        }
    }
    let tail = lines
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    Ran {
        passed,
        timed_out,
        tail,
    }
}

#[cfg(windows)]
fn shell(command: &str) -> tokio::process::Command {
    // `/S` strips the outer quotes and keeps the rest as typed, which the usual argument quoting
    // would mangle for cmd.
    let mut shell = tokio::process::Command::new("cmd");
    shell
        .args(["/D", "/S", "/C"])
        .raw_arg(format!("\"{command}\""));
    shell
}

#[cfg(not(windows))]
fn shell(command: &str) -> tokio::process::Command {
    let mut shell = tokio::process::Command::new("sh");
    shell.arg("-c").arg(command);
    // Its own process group, so a timeout kills what the command started too.
    shell.process_group(0);
    shell
}

#[cfg(windows)]
async fn kill_tree(pid: u32) {
    let _ = tokio::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .no_console_window()
        .status()
        .await;
}

#[cfg(not(windows))]
async fn kill_tree(pid: u32) {
    // `--` before the group: procps-ng's `kill -KILL -<pid>` exits 0 having signalled nothing.
    let _ = tokio::process::Command::new("kill")
        .args(["-s", "KILL", "--", &format!("-{pid}")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
}

/// Read `pipe` line by line into `lines`, keeping the last [`TAIL_LINES`].
async fn collect(pipe: impl tokio::io::AsyncRead + Unpin, lines: Arc<Mutex<VecDeque<String>>>) {
    use tokio::io::AsyncBufReadExt;
    let mut reader = tokio::io::BufReader::new(pipe);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buffer);
                let line: String = line.trim_end().chars().take(LINE_CHARS).collect();
                let mut lines = lines.lock().unwrap();
                lines.push_back(line);
                if lines.len() > TAIL_LINES {
                    lines.pop_front();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::LoopCheckKind;

    #[cfg(windows)]
    const SLOW: &str = "ping -n 6 127.0.0.1 >NUL";
    #[cfg(not(windows))]
    const SLOW: &str = "sleep 5";

    #[tokio::test]
    async fn a_command_keeps_its_output_and_a_slow_one_is_killed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path().to_str().unwrap();
        let ok = run_shell(dir, "echo one && echo two", Duration::from_secs(30)).await;
        assert!(ok.passed, "{ok:?}");
        assert!(ok.tail.contains("one") && ok.tail.contains("two"), "{ok:?}");

        let bad = run_shell(dir, "exit 3", Duration::from_secs(30)).await;
        assert!(!bad.passed && !bad.timed_out);

        let started = std::time::Instant::now();
        let slow = run_shell(dir, SLOW, Duration::from_secs(1)).await;
        assert!(slow.timed_out && !slow.passed);
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "{:?}",
            started.elapsed()
        );
    }

    #[cfg(windows)]
    const FAILS_ONCE: &str = "git hash-object flag || (echo x> flag & exit /b 1)";
    #[cfg(not(windows))]
    const FAILS_ONCE: &str = "git hash-object flag || { echo x > flag; exit 1; }";

    #[tokio::test]
    async fn a_check_that_passes_on_its_second_run_is_flaky() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path().to_str().unwrap();
        let check = LoopCheck {
            id: 7,
            position: 0,
            kind: LoopCheckKind::Command,
            label: "Sometimes".to_string(),
            command: Some(FAILS_ONCE.to_string()),
            state: LoopCheckState::Pending,
            detail: None,
            proposed: false,
            accepted: false,
            passed_at_sha: None,
            updated_at: String::new(),
            timeout_secs: None,
        };
        let run = run_commands(dir, &LoopConfig::default(), &[check], |_, _, _| async {}).await;
        assert_eq!(run.flaky, ["Sometimes"]);
        assert_eq!(run.results[0].1, LoopCheckState::Flaky);
        assert!(!run.all_pass);
    }

    fn row(id: i32, kind: LoopCheckKind, command: &str, timeout_secs: Option<u32>) -> LoopCheck {
        LoopCheck {
            id,
            position: id,
            kind,
            label: format!("row {id}"),
            command: Some(command.to_string()),
            timeout_secs,
            state: LoopCheckState::Pending,
            detail: None,
            proposed: false,
            accepted: false,
            passed_at_sha: None,
            updated_at: String::new(),
        }
    }

    #[tokio::test]
    async fn steps_run_in_order_and_a_failing_one_runs_no_check() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path().to_str().unwrap();
        let heard = Mutex::new(Vec::new());
        let hear = |c: &LoopCheck, state: LoopCheckState, _: Option<String>| {
            heard.lock().unwrap().push((c.id, state));
            async {}
        };
        // The second step needs what the first wrote; the check comes after both.
        let checks = [
            row(3, LoopCheckKind::Command, "git hash-object flag", None),
            row(1, LoopCheckKind::Setup, "echo x> flag", None),
            row(2, LoopCheckKind::Setup, "git hash-object flag", None),
        ];
        let config = LoopConfig::default();
        let run = run_commands(dir, &config, &checks, hear).await;
        assert!(run.all_pass, "{run:?}");
        assert_eq!(
            heard.lock().unwrap().clone(),
            [
                (1, LoopCheckState::Pass),
                (2, LoopCheckState::Pass),
                (3, LoopCheckState::Pass)
            ]
        );

        // A step past its own limit is killed, the step after it never runs, and every check
        // fails naming it, though the loop's limit would have let it finish.
        heard.lock().unwrap().clear();
        let checks = [
            row(1, LoopCheckKind::Setup, "echo ok", None),
            row(2, LoopCheckKind::Setup, SLOW, Some(1)),
            row(3, LoopCheckKind::Setup, "echo never", None),
            row(4, LoopCheckKind::Command, "echo fine", None),
            row(5, LoopCheckKind::Judge, "unused", None),
        ];
        let started = std::time::Instant::now();
        let run = run_commands(dir, &config, &checks, hear).await;
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(!run.all_pass);
        assert_eq!(
            heard.lock().unwrap().clone(),
            [
                (1, LoopCheckState::Pass),
                (2, LoopCheckState::Fail),
                (4, LoopCheckState::Fail)
            ]
        );
        assert!(run.steps[1].2.as_deref().unwrap().starts_with("Timed out"));
        assert_eq!(
            run.results,
            [(
                4,
                LoopCheckState::Fail,
                Some("Step 2 (row 2) failed, so no check ran.".to_string())
            )]
        );
        assert!(run.output.contains("### Step 2 (row 2)"), "{}", run.output);
    }
}
