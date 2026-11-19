//! File operations on the machine a project lives on.
//!
//! One implementation, run by the app itself for a local project and by `maestro-server` in its
//! exec channel for every other kind of connection. Remote connections used to run `ls`, `test`,
//! `find` and `sh` and parse what they printed, which no native Windows host has, and which drifted
//! from the local half in what it followed, skipped and refused.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;

/// Text files above this are refused rather than streamed into the UI.
pub const TEXT_LIMIT: usize = 512 * 1024;
/// Binary files above this are refused: the base64 of one already costs a third more again.
pub const BINARY_LIMIT: usize = 10 * 1024 * 1024;
/// A workspace listing is for a file picker, not an inventory.
pub const MAX_WORKSPACE_FILES: usize = 2000;
const MAX_WORKSPACE_DEPTH: u8 = 8;
/// Directories a workspace listing never descends into. `.git` stays out even with hidden entries
/// asked for: its object store alone would exhaust [`MAX_WORKSPACE_FILES`].
const SKIPPED_DIRS: [&str; 4] = ["node_modules", "target", "dist", ".git"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FsOp {
    /// The home directory of the user the server runs as.
    Home,
    /// Whether `path` is a file, a directory or absent, following symlinks.
    Kind {
        path: String,
    },
    CreateDirAll {
        path: String,
    },
    /// A single directory; an existing path is an error.
    CreateDir {
        path: String,
    },
    /// An empty file; an existing path is an error.
    CreateFile {
        path: String,
    },
    /// Subdirectories of `path`, hidden ones included.
    Directories {
        path: String,
    },
    /// Directories then files under `path`, each sorted.
    Contents {
        path: String,
        include_hidden: bool,
    },
    /// Every file under `path`, relative to it with `/`.
    WorkspaceFiles {
        path: String,
        include_hidden: bool,
    },
    /// Files under each of `dirs` in `root` changed since `since_ms`.
    ArtifactFiles {
        root: String,
        dirs: Vec<String>,
        since_ms: f64,
    },
    ReadText {
        path: String,
    },
    /// The file's bytes, base64-encoded.
    ReadBinary {
        path: String,
    },
    /// Replace the file through a temporary in its own directory, so no reader sees half of it.
    WriteText {
        path: String,
        contents: String,
    },
    /// Refuses to replace anything already at `to`.
    Rename {
        from: String,
        to: String,
    },
    Delete {
        path: String,
        recursive: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FsKind {
    File,
    Dir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FsArtifact {
    /// The root joined to the path under it with `/`, so a caller can strip the root back off.
    pub path: String,
    /// Milliseconds since the epoch, by the host's clock.
    pub modified_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "reply", content = "value", rename_all = "snake_case")]
pub enum FsReply {
    Done,
    Kind(Option<FsKind>),
    /// A path, a file's text, or base64.
    Text(String),
    Names(Vec<String>),
    Entries(Vec<FsEntry>),
    Artifacts(Vec<FsArtifact>),
}

/// Carry out one operation on this machine.
pub fn apply(op: FsOp) -> Result<FsReply, String> {
    match op {
        FsOp::Home => crate::paths::home_dir()
            .map(|home| FsReply::Text(home.to_string_lossy().replace('\\', "/"))),
        FsOp::Kind { path } => kind(&path).map(FsReply::Kind),
        FsOp::CreateDirAll { path } => fs::create_dir_all(&path)
            .map(|()| FsReply::Done)
            .map_err(|e| format!("Failed to create {path}: {e}")),
        FsOp::CreateDir { path } => fs::create_dir(&path)
            .map(|()| FsReply::Done)
            .map_err(|e| format!("Failed to create {path}: {e}")),
        FsOp::CreateFile { path } => fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(|_| FsReply::Done)
            .map_err(|e| format!("Failed to create {path}: {e}")),
        FsOp::Directories { path } => {
            let (dirs, _files) = list(&path, true)?;
            Ok(FsReply::Names(dirs))
        }
        FsOp::Contents {
            path,
            include_hidden,
        } => {
            let (dirs, files) = list(&path, include_hidden)?;
            let entries = dirs
                .into_iter()
                .map(|name| FsEntry { name, is_dir: true })
                .chain(files.into_iter().map(|name| FsEntry {
                    name,
                    is_dir: false,
                }))
                .collect();
            Ok(FsReply::Entries(entries))
        }
        FsOp::WorkspaceFiles {
            path,
            include_hidden,
        } => workspace_files(&path, include_hidden).map(FsReply::Names),
        FsOp::ArtifactFiles {
            root,
            dirs,
            since_ms,
        } => Ok(FsReply::Artifacts(artifact_files(&root, &dirs, since_ms))),
        FsOp::ReadText { path } => read_text(&path).map(FsReply::Text),
        FsOp::ReadBinary { path } => read_binary(&path).map(FsReply::Text),
        FsOp::WriteText { path, contents } => {
            if contents.len() > TEXT_LIMIT {
                return Err("File too large".to_string());
            }
            atomic_write(Path::new(&path), contents.as_bytes())
                .map(|()| FsReply::Done)
                .map_err(|e| format!("Failed to write {path}: {e}"))
        }
        FsOp::Rename { from, to } => {
            // `fs::rename` replaces the destination, so the check is what stops a rename from
            // silently destroying a sibling. Advisory: nothing holds a lock in between.
            if kind(&to)?.is_some() {
                return Err(format!("{to} already exists"));
            }
            fs::rename(&from, &to)
                .map(|()| FsReply::Done)
                .map_err(|e| format!("Failed to rename {from}: {e}"))
        }
        FsOp::Delete { path, recursive } => {
            let result = if recursive {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
            result
                .map(|()| FsReply::Done)
                .map_err(|e| format!("Failed to delete {path}: {e}"))
        }
    }
}

/// `None` only when the path is absent: a caller deleting rows on the strength of "not there"
/// must not get that answer for a path it merely could not stat.
fn kind(path: &str) -> Result<Option<FsKind>, String> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(Some(FsKind::Dir)),
        Ok(_) => Ok(Some(FsKind::File)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not check {path}: {e}")),
    }
}

/// Directory and file names in `path`, each sorted. Symlinks are followed, so a link to a
/// directory is listed as one; an entry that cannot be read is left out rather than failing the
/// listing.
fn list(path: &str, include_hidden: bool) -> Result<(Vec<String>, Vec<String>), String> {
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to list {path}: {e}"))?;
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        match fs::metadata(entry.path()) {
            Ok(meta) if meta.is_dir() => dirs.push(name),
            Ok(_) => files.push(name),
            Err(_) => continue,
        }
    }
    dirs.sort();
    files.sort();
    Ok((dirs, files))
}

fn workspace_files(root: &str, include_hidden: bool) -> Result<Vec<String>, String> {
    let root = Path::new(root);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", root.display()));
    }
    let mut output = Vec::new();
    walk(root, root, 0, include_hidden, &mut output)
        .map_err(|e| format!("Failed to list {}: {e}", root.display()))?;
    output.sort();
    Ok(output)
}

fn walk(
    root: &Path,
    dir: &Path,
    depth: u8,
    include_hidden: bool,
    output: &mut Vec<String>,
) -> std::io::Result<()> {
    if depth > MAX_WORKSPACE_DEPTH || output.len() >= MAX_WORKSPACE_FILES {
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(dir)?.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') && !include_hidden {
            continue;
        }
        // `file_type` does not follow symlinks, so a link cannot loop the walk.
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if !SKIPPED_DIRS.contains(&name.as_str()) {
                walk(root, &entry.path(), depth + 1, include_hidden, output)?;
            }
        } else if file_type.is_file() && output.len() < MAX_WORKSPACE_FILES {
            if let Ok(relative) = entry.path().strip_prefix(root) {
                output.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

fn artifact_files(root: &str, dirs: &[String], since_ms: f64) -> Vec<FsArtifact> {
    let root = root.trim_end_matches(['/', '\\']);
    let mut files = Vec::new();
    let mut pending: Vec<(std::path::PathBuf, String)> = dirs
        .iter()
        .map(|dir| (Path::new(root).join(dir), dir.clone()))
        .collect();
    while let Some((dir, relative)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            // `DirEntry::metadata` does not follow symlinks, so a link cannot loop the walk.
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let relative = format!("{relative}/{name}");
            if meta.is_dir() {
                pending.push((entry.path(), relative));
                continue;
            }
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|age| age.as_millis() as f64);
            if let Some(modified_ms) = modified_ms.filter(|ms| *ms >= since_ms) {
                files.push(FsArtifact {
                    path: format!("{root}/{relative}"),
                    modified_ms,
                });
                if files.len() >= MAX_WORKSPACE_FILES {
                    return files;
                }
            }
        }
    }
    files
}

fn read_text(path: &str) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let size = file
        .metadata()
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len() as usize;
    if size > TEXT_LIMIT {
        return Err(format!(
            "File too large ({} KB, max {} KB)",
            size / 1024,
            TEXT_LIMIT / 1024
        ));
    }
    let mut bytes = Vec::with_capacity(size);
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read {path}: {e}"))?;
    if bytes.contains(&0u8) {
        return Err("Binary file".to_string());
    }
    String::from_utf8(bytes).map_err(|e| format!("Failed to read {path}: {e}"))
}

fn read_binary(path: &str) -> Result<String, String> {
    use base64::Engine;
    let size = fs::metadata(path)
        .map_err(|e| format!("Failed to read {path}: {e}"))?
        .len() as usize;
    if size > BINARY_LIMIT {
        return Err("File too large".to_string());
    }
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Replace a file without exposing partially-written contents to concurrent readers.
pub fn atomic_write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let file_name = path.file_name().unwrap_or_default().to_string_lossy();

    for attempt in 0..100 {
        let temp_path = path.with_file_name(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            attempt
        ));
        let mut temp = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };

        let result = (|| {
            temp.write_all(contents)?;
            temp.sync_all()?;
            drop(temp);
            // `fs::rename` replaces the destination on every platform we ship — on Windows it
            // is MoveFileExW with MOVEFILE_REPLACE_EXISTING. The temporary always lives in the
            // destination's own directory, so this is a same-volume metadata rename.
            fs::rename(&temp_path, path)
        })();
        if result.is_err() {
            // The caller gets the write error. A temporary that cannot be removed either is inert,
            // and the next attempt picks a fresh name, so its own failure changes nothing.
            fs::remove_file(&temp_path).ok();
        }
        return result;
    }

    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        "could not allocate an atomic-write temporary file",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("maestro-fs-{name}-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn path(dir: &Path, name: &str) -> String {
        dir.join(name).to_string_lossy().into_owned()
    }

    #[test]
    fn listing_sorts_directories_before_files_and_hides_dotted_names() {
        let dir = temp_dir("list");
        fs::create_dir(dir.join("b-dir")).unwrap();
        fs::create_dir(dir.join(".hidden")).unwrap();
        fs::write(dir.join("a.txt"), "x").unwrap();

        let shown = apply(FsOp::Contents {
            path: dir.to_string_lossy().into_owned(),
            include_hidden: false,
        });
        assert_eq!(
            shown,
            Ok(FsReply::Entries(vec![
                FsEntry {
                    name: "b-dir".into(),
                    is_dir: true
                },
                FsEntry {
                    name: "a.txt".into(),
                    is_dir: false
                },
            ]))
        );
        // The directory picker shows hidden folders, since a project may live under one.
        assert_eq!(
            apply(FsOp::Directories {
                path: dir.to_string_lossy().into_owned()
            }),
            Ok(FsReply::Names(vec![".hidden".into(), "b-dir".into()]))
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn kind_tells_absent_from_present() {
        let dir = temp_dir("kind");
        fs::write(dir.join("f"), "x").unwrap();
        assert_eq!(
            apply(FsOp::Kind {
                path: path(&dir, "f")
            }),
            Ok(FsReply::Kind(Some(FsKind::File)))
        );
        assert_eq!(
            apply(FsOp::Kind {
                path: path(&dir, "missing")
            }),
            Ok(FsReply::Kind(None))
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn workspace_files_skip_build_output_and_use_forward_slashes() {
        let dir = temp_dir("walk");
        fs::create_dir_all(dir.join("src/inner")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::write(dir.join("src/inner/main.rs"), "").unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "").unwrap();
        fs::write(dir.join(".env"), "").unwrap();

        assert_eq!(
            apply(FsOp::WorkspaceFiles {
                path: dir.to_string_lossy().into_owned(),
                include_hidden: false,
            }),
            Ok(FsReply::Names(vec!["src/inner/main.rs".into()]))
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn writes_round_trip_and_reads_refuse_binary() {
        let dir = temp_dir("rw");
        let file = path(&dir, "note.txt");
        assert_eq!(
            apply(FsOp::WriteText {
                path: file.clone(),
                contents: "hello".into()
            }),
            Ok(FsReply::Done)
        );
        assert_eq!(
            apply(FsOp::ReadText { path: file }),
            Ok(FsReply::Text("hello".into()))
        );

        fs::write(dir.join("blob"), [0u8, 1, 2]).unwrap();
        assert_eq!(
            apply(FsOp::ReadText {
                path: path(&dir, "blob")
            }),
            Err("Binary file".to_string())
        );
        assert_eq!(
            apply(FsOp::ReadBinary {
                path: path(&dir, "blob")
            }),
            Ok(FsReply::Text("AAEC".into()))
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rename_refuses_to_replace_a_sibling() {
        let dir = temp_dir("rename");
        fs::write(dir.join("a"), "a").unwrap();
        fs::write(dir.join("b"), "b").unwrap();
        let refused = apply(FsOp::Rename {
            from: path(&dir, "a"),
            to: path(&dir, "b"),
        });
        assert!(matches!(refused, Err(message) if message.ends_with("already exists")));
        assert_eq!(fs::read_to_string(dir.join("b")).unwrap(), "b");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_reply_survives_the_wire() {
        let reply = FsReply::Entries(vec![FsEntry {
            name: "src".into(),
            is_dir: true,
        }]);
        let json = serde_json::to_string(&reply).unwrap();
        assert_eq!(serde_json::from_str::<FsReply>(&json).unwrap(), reply);
        let op = FsOp::Contents {
            path: "C:/Users/me".into(),
            include_hidden: true,
        };
        let json = serde_json::to_string(&op).unwrap();
        assert_eq!(serde_json::from_str::<FsOp>(&json).unwrap(), op);
    }
}
