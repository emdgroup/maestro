use crate::connectivity::exec_channel::{self, ExecTarget};
use crate::models::GitConnection;
use super::remote;

/// Prefix on git error messages, kept per connection type because it is what users see when a
/// git command fails and it says which machine failed it.
fn label_for(conn: &GitConnection) -> &'static str {
    match conn {
        GitConnection::Local { .. } => "",
        GitConnection::Remote { .. } => "Remote ",
        GitConnection::Wsl { .. } => "WSL ",
        GitConnection::Docker { .. } => "Docker ",
    }
}

/// Options every `git` invocation on this target needs, before any subcommand.
///
/// WSL has a certificate store separate from Windows' and so cannot validate the certs of
/// internal servers the host trusts. Containers verify normally — do not extend that to them.
///
/// A Windows host needs `core.longpaths`: without it git uses the ANSI path APIs and gives up
/// past 260 characters, which a worktree holding `node_modules` or `target` passes easily.
pub fn git_prefix_args(target: &ExecTarget<'_>) -> &'static [&'static str] {
    match target {
        ExecTarget::Wsl { .. } => &["-c", "http.sslVerify=false"],
        ExecTarget::Local if cfg!(windows) => &["-c", "core.longpaths=true"],
        _ => &[],
    }
}

/// `git` and its arguments for a repository, as argv.
fn git_args<'a>(path: &'a str, args: &[&'a str], prefix: &'static [&'static str]) -> Vec<&'a str> {
    let mut argv = prefix.to_vec();
    argv.extend_from_slice(&["-C", path]);
    argv.extend_from_slice(args);
    argv
}

async fn run_git_on(
    target: &ExecTarget<'_>,
    label: &str,
    path: &str,
    args: &[&str],
    ignore_exit_code: bool,
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    let argv = git_args(path, args, git_prefix_args(target));
    let output = exec_channel::run_with_stdin(
        target,
        None,
        "git",
        &argv,
        stdin.map(|bytes| bytes.to_vec()),
    )
    .await?;
    if !ignore_exit_code && !output.success() {
        return Err(format!("{}git error: {}", label, output.stderr_string()));
    }
    Ok(output.stdout_string())
}

async fn run_git_in_dir_inner(
    conn: &GitConnection,
    abs_path: &str,
    args: &[&str],
    ignore_exit_code: bool,
) -> Result<String, String> {
    let target = ExecTarget::of(conn);
    run_git_on(&target, label_for(conn), abs_path, args, ignore_exit_code, None).await
}

/// Run a git command in a repository, wherever that repository lives.
///
/// Every connection type takes the same route: the connection's exec channel, which runs it on
/// the machine owning the files. There is no per-connection branch here by design.
pub async fn run_git_in_dir(
    conn: &GitConnection,
    abs_path: &str,
    args: &[&str],
) -> Result<String, String> {
    run_git_in_dir_inner(conn, abs_path, args, false).await
}

/// Like `run_git_in_dir` but tolerates non-zero exit codes (returns stdout anyway).
pub async fn run_git_in_dir_lossy(
    conn: &GitConnection,
    abs_path: &str,
    args: &[&str],
) -> Result<String, String> {
    run_git_in_dir_inner(conn, abs_path, args, true).await
}

/// Run several git commands in the same directory, returning one stdout per
/// command. A failed command yields an empty string instead of failing the batch.
///
/// The commands are joined into one delimiter-separated shell script so the batch costs a single
/// message. Local is the exception, and not for cost: a Windows host has no `sh` to run the
/// script with, so those commands go one at a time down the same path.
pub async fn run_git_commands_lossy(
    conn: &GitConnection,
    abs_path: &str,
    commands: &[&[&str]],
) -> Vec<String> {
    const DELIM: &str = "__MAESTRO_GIT_BATCH_7f3a9c__";

    let build_script = |git_prefix: String| {
        commands
            .iter()
            .map(|args| {
                let quoted: Vec<String> = args.iter().map(|a| remote::shell_quote(a)).collect();
                format!("{} {} 2>/dev/null", git_prefix, quoted.join(" "))
            })
            .collect::<Vec<_>>()
            .join(&format!("; echo {}; ", DELIM))
            // Force a zero exit so runners that treat non-zero as an error still
            // return the partial output (e.g. rev-list on a branch with no upstream).
            + "; true"
    };

    if matches!(conn, GitConnection::Local { .. }) {
        let mut results = Vec::with_capacity(commands.len());
        for args in commands {
            results.push(run_git_in_dir(conn, abs_path, args).await.unwrap_or_default());
        }
        return results;
    }

    let git_prefix = if matches!(conn, GitConnection::Wsl { .. }) {
        format!("git -c http.sslVerify=false -C {}", remote::shell_quote(abs_path))
    } else {
        format!("git -C {}", remote::shell_quote(abs_path))
    };
    let script = build_script(git_prefix);
    let output = exec_channel::run(&ExecTarget::of(conn), None, "sh", &["-c", &script])
        .await
        .map(|output| output.stdout_string())
        .unwrap_or_default();

    let mut results: Vec<String> = output
        .split(&format!("{}\n", DELIM))
        .map(|s| s.to_string())
        .collect();
    results.resize(commands.len(), String::new());
    results
}
