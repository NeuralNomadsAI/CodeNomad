//! `automation-bridges/` (`publishAutomationBridge`): this backend's bridge URL and token,
//! written atomically and owner-only after pruning registrations of dead publishers.
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

use serde_json::{Value, json};

const MAX_FILES: usize = 4096;
const MAX_BYTES: u64 = 4 * 1024;

/// Removed on graceful shutdown.
pub struct Record {
    path: PathBuf,
    removed: bool,
}
impl Record {
    /// Removes the bridge registration with one retry, propagating non-`NotFound` errors
    /// (TS `automation-plugin.ts:189-196`, `shutdown.ts:135-146`).
    pub fn remove(mut self) -> io::Result<()> {
        let mut last_err = None;
        for _ in 0..2 {
            match fs::remove_file(&self.path) {
                Ok(()) => {
                    self.removed = true;
                    return Ok(());
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    self.removed = true;
                    return Ok(());
                }
                Err(e) => last_err = Some(e),
            }
        }
        self.removed = true;
        Err(last_err.unwrap())
    }
}
impl Drop for Record {
    fn drop(&mut self) {
        if !self.removed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub fn publish(dir: &Path, url: &str, token: &str) -> io::Result<Record> {
    fs::create_dir_all(dir)?;
    prune(dir);
    let (started, pid) = (crate::shared::now_ms(), std::process::id());
    let target = dir.join(format!("{started}-{pid}-{}.json", &token[..12]));
    let body = json!({ "version": 1, "url": url, "token": token, "pid": pid, "startedAt": started });
    crate::auth::tls::write_private(&target, format!("{body}\n").as_bytes())?;
    Ok(Record { path: target, removed: false })
}

/// `isProcessAlive`: out of range is absent, an unconfirmed probe stays alive.
fn alive(pid: u64) -> bool {
    (1..=0x7fff_ffff).contains(&pid) && !crate::memory::confirmed_absent(pid as i64)
}

/// `<startedAt>-<pid>-<token prefix>.json` (`REGISTRATION_NAME`).
fn name(file: &str) -> Option<(u64, u64)> {
    let mut parts = file.strip_suffix(".json")?.splitn(3, '-');
    let digits = |p: &&str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    let (started, pid) = (parts.next().filter(digits)?, parts.next().filter(digits)?);
    parts.next().filter(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)))?;
    Some((started.parse().unwrap_or(u64::MAX), pid.parse().unwrap_or(u64::MAX)))
}

/// `readRegistration`: the publisher's PID of a well-formed registration.
fn publisher(path: &Path) -> Option<u64> {
    let mut bytes = Vec::new();
    fs::File::open(path).ok()?.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok().filter(|_| bytes.len() as u64 <= MAX_BYTES)?;
    let positive = |key: &str| value[key].as_u64().filter(|n| (1..=(1 << 53) - 1).contains(n));
    let url = reqwest::Url::parse(value["url"].as_str()?).ok()?;
    let valid = value["version"] == 1
        && value["token"].is_string()
        && positive("startedAt").is_some()
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.path() == super::PATH;
    valid.then(|| positive("pid")).flatten()
}

fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| name(&e.file_name().to_string_lossy()).map(|(started, pid)| (started, pid, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(MAX_FILES);
    for (_, pid, path) in files {
        if !alive(pid) || publisher(&path).is_some_and(|p| !alive(p)) {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_prunes_dead_publishers_and_leaves_the_rest() {
        let dir = crate::shared::test_dir("bridges");
        let token = "A".repeat(43);
        let live = std::process::id();
        let url = |port: u16| format!("http://127.0.0.1:{port}{}", super::super::PATH);
        let write = |file: &str, body: Value| fs::write(dir.join(file), body.to_string()).unwrap();
        let entry = |pid: u64| json!({ "version": 1, "url": url(1), "token": "t", "pid": pid, "startedAt": 1 });
        write("1-4294967295-dead.json", entry(live.into()));
        write(&format!("2-{live}-livename.json"), entry(4_294_967_295));
        write(&format!("3-{live}-kept.json"), entry(live.into()));
        write(
            &format!("4-{live}-foreign.json"),
            json!({ "version": 1, "url": "http://localhost:1/x", "pid": 4_294_967_295u64 }),
        );
        write("notes.txt", json!({}));
        let record = publish(&dir, &url(4567), &token).unwrap();
        let mut names: Vec<String> =
            fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        let published = names.iter().find(|n| n.ends_with(&format!("-{live}-AAAAAAAAAAAA.json"))).unwrap().clone();
        let mut expected =
            [format!("3-{live}-kept.json"), format!("4-{live}-foreign.json"), published.clone(), "notes.txt".into()];
        expected.sort();
        assert_eq!(names, expected);
        let text = fs::read_to_string(dir.join(&published)).unwrap();
        assert!(text.ends_with("}\n"));
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["url"], url(4567));
        assert_eq!(
            (value["version"].clone(), value["token"].clone(), value["pid"].clone()),
            (json!(1), json!(token), json!(live))
        );
        assert!(published.starts_with(&format!("{}-", value["startedAt"])));
        assert_eq!(publisher(&dir.join(&published)), Some(live.into()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(dir.join(&published)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        drop(record);
        assert!(!dir.join(&published).exists());
        assert!(fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        assert_eq!(name("12-34-ab_C-d.json"), Some((12, 34)));
        assert_eq!(
            [name("12-34-.json"), name("x-34-a.json"), name("12-34-a.json.tmp"), name("12-34-a!b.json")],
            [None; 4]
        );
    }
}
