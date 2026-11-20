//! `memory/store.ts`: `<data>/memory/{global,projects/<id>}/<id>.md`, a durable
//! `.transaction.json` journal published before each file operation, one commit per
//! accepted write, and roll-forward recovery under the repository lock.

use super::git::MemoryGit;
use super::model::{Code, Entry, MemoryError, Result, check, fail};
use super::{lock, rules, yaml};
use serde_json::{Value, json};
use std::{
    fs, io,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

const MAX_FILE_BYTES: usize = 16_384;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Namespace {
    Global,
    Project(String),
}
impl Namespace {
    pub fn key(&self) -> &str {
        match self {
            Namespace::Global => "global",
            Namespace::Project(id) => id,
        }
    }
}

/// The policy's decision (the reference's `{ kind: "none" }` has no caller here).
pub enum Mutation<T> {
    Save(Entry, T),
    Delete(String, T),
}

/// `JSON.stringify` of a flat object in the given key order.
pub fn ordered_json(pairs: &[(&str, Value)]) -> String {
    let body: Vec<String> =
        pairs.iter().map(|(k, v)| format!("{}:{}", Value::from(*k), super::model::js_json(v))).collect();
    format!("{{{}}}", body.join(","))
}

/// `mkdir(path, { recursive, mode: 0o700 })`.
pub fn private_dir(path: &Path, recursive: bool) -> io::Result<()> {
    let mut b = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.recursive(recursive).create(path)
}
fn open_new(path: &Path) -> io::Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}
/// `writeFile(path, bytes, { flag: "wx", mode: 0o600 })`.
pub fn create_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    open_new(path)?.write_all(bytes)
}

fn unreadable(message: &'static str) -> MemoryError {
    fail(Code::Unreadable, message)
}
fn storage() -> MemoryError {
    unreadable("Memory storage is unavailable")
}
fn abort() -> MemoryError {
    fail(Code::Unreadable, "Memory request cancelled")
}

/// `atomicMemoryWrite`: same-directory temporary, fsync, rename over the target.
pub fn atomic_write(file: &Path, content: &str, cancel: Option<&CancellationToken>) -> Result<()> {
    check(cancel)?;
    if content.len() > MAX_FILE_BYTES {
        return Err(fail(Code::Invalid, "Memory file is too large"));
    }
    let mut name = file.as_os_str().to_owned();
    name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let temporary = PathBuf::from(name);
    let mut created = false;
    let result = (|| -> std::result::Result<(), MemoryError> {
        let mut handle = open_new(&temporary).map_err(|_| storage())?;
        created = true;
        handle.write_all(content.as_bytes()).and_then(|_| handle.sync_all()).map_err(|_| storage())?;
        drop(handle);
        check(cancel)?;
        fs::rename(&temporary, file).map_err(|_| storage())
    })();
    if created {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// `regularDirectory`: absent → false, a real directory → true, anything else unreadable.
fn regular_directory(directory: &Path) -> Result<bool> {
    match fs::symlink_metadata(directory) {
        Ok(info) if info.is_dir() && !info.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(unreadable("Invalid memory directory")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(unreadable("Memory directory is unavailable")),
    }
}

/// `readBounded`: a regular file of at most 16 KiB of strict UTF-8 (leading BOM dropped,
/// as `TextDecoder` does). `Ok(None)` only for an absent file.
fn read_bounded(file: &Path) -> Result<Option<String>> {
    let info = match fs::symlink_metadata(file) {
        Ok(i) => i,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage()),
    };
    if !info.is_file() || info.file_type().is_symlink() {
        return Err(unreadable("Invalid memory file"));
    }
    let mut bytes = Vec::new();
    fs::File::open(file)
        .and_then(|f| f.take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| storage())?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(fail(Code::Malformed, "Memory file is too large"));
    }
    let text = String::from_utf8(bytes).map_err(|_| fail(Code::Malformed, "Invalid memory encoding"))?;
    Ok(Some(text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text)))
}

fn temporary_name(name: &str) -> bool {
    // `/\.md\.[a-f0-9-]{36}\.tmp$/`
    let Some(stem) = name.strip_suffix(".tmp") else { return false };
    stem.len() >= 39 && stem.is_char_boundary(stem.len() - 36) && {
        let (head, tail) = stem.split_at(stem.len() - 36);
        head.ends_with(".md.") && tail.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-'))
    }
}

pub struct Store {
    pub base: PathBuf,
    pub directory: PathBuf,
    git: MemoryGit,
}

impl Store {
    pub fn new(base: &Path) -> Store {
        let directory = base.join("memory");
        Store { base: base.to_path_buf(), git: MemoryGit { directory: directory.clone() }, directory }
    }
    fn journal(&self) -> PathBuf {
        self.directory.join(".transaction.json")
    }
    fn scope_path(namespace: &Namespace) -> Result<String> {
        match namespace {
            Namespace::Global => Ok("global".into()),
            Namespace::Project(id) if id.len() == 64 && id.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9')) => {
                Ok(format!("projects/{id}"))
            }
            Namespace::Project(_) => Err(fail(Code::Invalid, "Invalid memory namespace")),
        }
    }
    fn scope_dir(&self, scope: &str) -> PathBuf {
        scope.split('/').fold(self.directory.clone(), |p, s| p.join(s))
    }

    pub async fn list(&self, namespace: &Namespace, cancel: Option<&CancellationToken>) -> Result<Vec<Entry>> {
        Ok(rules::for_agent(&self.list_stored(namespace, cancel).await?))
    }
    pub async fn list_for_ui(
        &self,
        namespace: &Namespace,
        cancel: Option<&CancellationToken>,
    ) -> Result<Vec<(Entry, bool)>> {
        let entries = self.list_stored(namespace, cancel).await?;
        let flags: Vec<bool> = entries.iter().map(rules::flagged).collect();
        Ok(entries.into_iter().zip(flags).collect())
    }

    async fn list_stored(&self, namespace: &Namespace, cancel: Option<&CancellationToken>) -> Result<Vec<Entry>> {
        check(cancel)?;
        Self::scope_path(namespace)?;
        // The data and memory folders stay absent for a pristine empty read.
        if !regular_directory(&self.base)? || !regular_directory(&self.directory)? {
            return Ok(vec![]);
        }
        let ns = namespace.clone();
        self.locked(cancel, async move { self.read_scope(&ns, cancel) }).await
    }

    /// A cleanup capability snapshot: probes host ACLs without changing entries or history.
    pub async fn cleanup_writable(&self, namespace: &Namespace, cancel: Option<&CancellationToken>) -> bool {
        let probe = async {
            if !regular_directory(&self.directory)? || self.git.symbolic_head().await? != "refs/heads/main" {
                return Ok(false);
            }
            let scope = self.scope_dir(&Self::scope_path(namespace)?);
            let git = self.directory.join(".git");
            for directory in [
                scope.clone(),
                self.directory.clone(),
                git.clone(),
                git.join("objects"),
                git.join("refs"),
                git.join("refs").join("heads"),
            ] {
                check(cancel)?;
                if !regular_directory(&directory)? {
                    return Ok(false);
                }
                let probe = directory.join(format!(".cleanup.md.{}.tmp", uuid::Uuid::new_v4()));
                drop(open_new(&probe).map_err(|_| abort())?);
                fs::remove_file(&probe).map_err(|_| abort())?;
            }
            let mut files = vec![git.join("index"), git.join("refs").join("heads").join("main")];
            files.extend(self.read_scope(namespace, cancel)?.iter().map(|e| scope.join(format!("{}.md", e.id))));
            for file in files {
                check(cancel)?;
                fs::OpenOptions::new().read(true).write(true).open(&file).map_err(|_| abort())?;
            }
            Ok(true)
        };
        self.locked(cancel, probe).await.unwrap_or(false)
    }

    /// `mutate(namespace, decide)`: the decision and its commit share the repository lock.
    pub async fn mutate<T, F, Fut>(
        &self,
        namespace: &Namespace,
        cancel: Option<&CancellationToken>,
        decide: F,
    ) -> Result<T>
    where
        F: FnOnce(Vec<Entry>) -> Fut,
        Fut: std::future::Future<Output = Result<Mutation<T>>>,
    {
        check(cancel)?;
        let scope = Self::scope_path(namespace)?;
        private_dir(&self.base, true).map_err(|_| unreadable("Memory directory is unavailable"))?;
        regular_directory(&self.base)?;
        let ns = namespace.clone();
        self.locked(cancel, async move {
            let entries = self.read_scope(&ns, cancel)?;
            check(cancel)?;
            let mutation = decide(entries.clone()).await?;
            check(cancel)?;
            let (id, content, result) = match mutation {
                Mutation::Save(entry, result) => {
                    super::model::validate(&entry, Code::Invalid)?;
                    let encoded = yaml::encode_entry(&entry)?;
                    (entry.id, Some(encoded), result)
                }
                Mutation::Delete(id, result) => {
                    let existing = entries
                        .iter()
                        .find(|e| e.id == id)
                        .ok_or_else(|| fail(Code::Invalid, "Unknown memory entry"))?;
                    (existing.id.clone(), None, result)
                }
            };
            // Case-only filename collisions are refused on every host.
            if entries.iter().any(|e| e.id != id && e.id.to_lowercase() == id.to_lowercase()) {
                return Err(fail(Code::Conflict, "Memory entry filename conflicts"));
            }
            self.git.initialize().await?;
            check(cancel)?;
            let file = format!("{scope}/{id}.md");
            let transaction = uuid::Uuid::new_v4().to_string();
            self.ensure_scope(&scope)?;
            check(cancel)?;
            let journal = ordered_json(&[
                ("version", json!(1)),
                ("id", json!(transaction)),
                ("file", json!(file)),
                ("content", content.as_ref().map_or(Value::Null, |c| json!(c))),
            ]);
            // Atomic journal publication admits the durable transaction.
            atomic_write(&self.journal(), &journal, cancel)?;
            self.finish(&transaction, &file, content.as_deref(), true).await?;
            Ok(result)
        })
        .await
    }

    fn ensure_scope(&self, scope: &str) -> Result<()> {
        let mut directory = self.directory.clone();
        for segment in std::iter::once("").chain(scope.split('/')) {
            directory = if segment.is_empty() { directory } else { directory.join(segment) };
            if !regular_directory(&directory)? {
                private_dir(&directory, false).map_err(|_| storage())?;
            }
        }
        Ok(())
    }

    fn read_scope(&self, namespace: &Namespace, cancel: Option<&CancellationToken>) -> Result<Vec<Entry>> {
        check(cancel)?;
        if !regular_directory(&self.directory)? {
            return Ok(vec![]);
        }
        let mut directory = self.directory.clone();
        for segment in Self::scope_path(namespace)?.split('/') {
            directory = directory.join(segment);
            if !regular_directory(&directory)? {
                return Ok(vec![]);
            }
        }
        let mut names: Vec<String> = Vec::new();
        for item in fs::read_dir(&directory).map_err(|_| storage())? {
            let item = item.map_err(|_| storage())?;
            names.push(item.file_name().into_string().map_err(|_| fail(Code::Malformed, "Unexpected memory file"))?);
        }
        names.sort_by(|a, b| rules::js_cmp(a, b));
        let mut entries: Vec<Entry> = Vec::new();
        for name in names {
            check(cancel)?;
            if temporary_name(&name) {
                continue;
            }
            if !name.ends_with(".md") {
                return Err(fail(Code::Malformed, "Unexpected memory file"));
            }
            let text = read_bounded(&directory.join(&name))?.ok_or_else(|| storage())?;
            let entry = yaml::decode_entry(&text)?;
            if format!("{}.md", entry.id) != name {
                return Err(fail(Code::Malformed, "Memory filename and id differ"));
            }
            if entries.iter().any(|o| o.id.to_lowercase() == entry.id.to_lowercase()) {
                return Err(fail(Code::Malformed, "Memory filenames conflict"));
            }
            entries.push(entry);
        }
        Ok(entries)
    }

    async fn finish(
        &self,
        transaction: &str,
        file: &str,
        content: Option<&str>,
        discard_on_failure: bool,
    ) -> Result<()> {
        let destination = self.scope_dir(file);
        let replaced = match content {
            None => match fs::remove_file(&destination) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err(storage()),
            },
            Some(text) => atomic_write(&destination, text, None),
        };
        if let Err(e) = replaced {
            if discard_on_failure {
                fs::remove_file(self.journal()).map_err(|_| storage())?;
            }
            return Err(e);
        }
        self.git.commit(file, transaction).await?;
        fs::remove_file(self.journal()).map_err(|_| storage())
    }

    async fn recover(&self) -> Result<()> {
        if !regular_directory(&self.directory)? {
            return Ok(());
        }
        let Some(raw) = read_bounded(&self.journal())? else { return Ok(()) };
        let invalid = || fail(Code::Malformed, "Invalid memory transaction");
        let value: Value = serde_json::from_str(&raw).map_err(|_| invalid())?;
        let object = value.as_object().ok_or_else(invalid)?;
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let file = object.get("file").and_then(Value::as_str).unwrap_or_default().to_owned();
        let id = object.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        static FILE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"^(?:global|projects/[a-f0-9]{64})/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.md$").unwrap()
        });
        static DEVICE: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\.md$").unwrap());
        let base = file.rsplit('/').next().unwrap_or_default().to_owned();
        let content = object.get("content").cloned().unwrap_or(Value::Bool(false));
        if object.get("version").and_then(Value::as_f64) != Some(1.0)
            || keys != ["content", "file", "id", "version"]
            || !(id.len() == 36 && id.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-')))
            || !FILE.is_match(&file)
            || DEVICE.is_match(&base)
            || !(content.is_null() || content.is_string())
        {
            return Err(invalid());
        }
        let content = content.as_str().map(str::to_owned);
        if let Some(text) = &content
            && yaml::decode_entry(text).map_err(|_| invalid())?.id + ".md" != base
        {
            return Err(invalid());
        }
        self.git.initialize().await?;
        let parent = file.rsplit_once('/').map(|(p, _)| p.to_owned()).unwrap_or_default();
        self.ensure_scope(&parent)?;
        self.finish(&id, &file, content.as_deref(), false).await
    }

    /// `locked`: the repository lock, then journal recovery, then the action.
    async fn locked<T>(
        &self,
        cancel: Option<&CancellationToken>,
        action: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        let guard = lock::acquire(&self.directory, cancel).await?;
        let outcome = async {
            check(cancel)?;
            self.recover().await?;
            check(cancel)?;
            action.await
        }
        .await;
        guard.release().await?;
        outcome
    }
}
