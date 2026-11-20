//! `config/location.ts` and `settings/yaml-doc-store.ts`: where the settings live, authoritative
//! YAML reads, atomic writes through settings links, merge patches and the stable server identity.
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde_json::{Map, Value};
use uuid::Uuid;

pub type Doc = Map<String, Value>;

/// The settings document could not be read authoritatively (missing is empty, not unreadable).
#[derive(Debug, PartialEq)]
pub struct Unreadable;

pub struct Location {
    pub base: PathBuf,
    pub config: PathBuf,
    pub state: PathBuf,
    pub instances: PathBuf,
}

impl Location {
    /// `resolveConfigLocation`: a folder, a YAML file or a legacy JSON file (`~/` is the home folder).
    pub fn resolve(raw: &str) -> Location {
        let input = match raw.trim() {
            "" => "~/.config/codenomad/config.json",
            input => input,
        };
        let path = match input.strip_prefix("~/") {
            Some(rest) => home().join(rest),
            None => std::path::absolute(input).unwrap_or_else(|_| input.into()),
        };
        let lower = path.to_string_lossy().to_lowercase();
        let parent = || path.parent().unwrap_or(&path).to_path_buf();
        let (base, config) = if lower.ends_with(".yaml") || lower.ends_with(".yml") {
            (parent(), path.clone())
        } else if lower.ends_with(".json") {
            (parent(), parent().join("config.yaml"))
        } else {
            (path.clone(), path.join("config.yaml"))
        };
        Location { state: base.join("state.yaml"), instances: base.join("instances"), base, config }
    }
}

/// Node's `os.homedir()`: `USERPROFILE` on Windows, `HOME` elsewhere.
pub fn home() -> PathBuf {
    std::env::home_dir().unwrap_or_default()
}

/// `readAuthoritative`: only an actually missing path is empty; anything unreadable or not a
/// mapping (a dangling link, a folder, invalid YAML, an empty file) is refused.
pub fn read(file: &Path) -> Result<Doc, Unreadable> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(e)
            if e.kind() == io::ErrorKind::NotFound
                && fs::symlink_metadata(file).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) =>
        {
            return Ok(Doc::new());
        }
        Err(_) => return Err(Unreadable),
    };
    // Through YAML's own mapping first: duplicate keys are refused like `uniqueKeys`.
    let yaml: serde_norway::Value = serde_norway::from_str(&text).map_err(|_| Unreadable)?;
    match serde_json::to_value(yaml) {
        Ok(Value::Object(doc)) => Ok(doc),
        _ => Err(Unreadable),
    }
}

/// `resolveWriteDestination`: a settings link is written through to its final target.
pub fn destination(file: &Path) -> io::Result<PathBuf> {
    let mut current = std::path::absolute(file)?;
    let mut seen = Vec::new();
    loop {
        match fs::symlink_metadata(&current) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(current),
            Err(e) => return Err(e),
            Ok(meta) if !meta.file_type().is_symlink() => return Ok(current),
            Ok(_) if seen.contains(&current) => return Err(io::Error::other("Circular settings symlink")),
            Ok(_) => {
                let target = fs::read_link(&current)?;
                seen.push(current.clone());
                current = std::path::absolute(current.parent().unwrap_or(Path::new("")).join(target))?;
            }
        }
    }
}

/// `persist`: a temporary file beside the target (the target's mode, else private), then a rename.
pub fn write(file: &Path, doc: &Doc) -> io::Result<()> {
    let target = destination(file)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut text = serde_norway::to_string(doc).map_err(io::Error::other)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    let temp = PathBuf::from(format!("{}.{}.{}.tmp", target.display(), std::process::id(), Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mode = fs::metadata(&target).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o600);
            options.mode(mode);
            let mut handle = options.open(&temp)?;
            fs::set_permissions(&temp, fs::Permissions::from_mode(mode))?;
            handle.write_all(text.as_bytes())?;
            handle.sync_all()?;
        }
        #[cfg(not(unix))]
        {
            let mut handle = options.open(&temp)?;
            handle.write_all(text.as_bytes())?;
            handle.sync_all()?;
        }
        fs::rename(&temp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// `applyMergePatch`: objects merge recursively, `null` deletes, anything else replaces
/// (an object replacing a non-object is kept as sent, nested `null`s included).
pub fn merge(current: &Value, patch: &Value) -> Value {
    let Value::Object(patch) = patch else { return patch.clone() };
    let mut base = current.as_object().cloned().unwrap_or_default();
    for (key, value) in patch {
        match (value, base.get(key)) {
            (Value::Null, _) => {
                base.remove(key);
            }
            (Value::Object(_), Some(existing @ Value::Object(_))) => {
                let merged = merge(existing, value);
                base.insert(key.clone(), merged);
            }
            _ => {
                base.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(base)
}

/// `normalizeDoc`: anything but a mapping is an empty owner.
pub fn owner(value: Option<&Value>) -> Doc {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `claimServerIdentity`: one persistent UUID elected through `<config>.server-id`, created
/// exclusively; a writer still publishing its claim is awaited for one second.
pub fn claim_identity(config: &Path) -> io::Result<Uuid> {
    let file = PathBuf::from(format!("{}.server-id", destination(config)?.display()));
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    match options.open(&file) {
        Ok(mut handle) => handle.write_all(Uuid::new_v4().to_string().as_bytes())?,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if let Ok(id) = Uuid::try_parse(fs::read_to_string(&file)?.trim()) {
            return Ok(id);
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other("Incomplete or invalid server identity file; explicit repair required"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn locations_follow_the_reference() {
        let dir = crate::shared::test_dir("settings-location");
        let yaml = Location::resolve(dir.join("custom.yml").to_str().unwrap());
        assert_eq!((yaml.config, yaml.state), (dir.join("custom.yml"), dir.join("state.yaml")));
        let json = Location::resolve(dir.join("config.json").to_str().unwrap());
        assert_eq!((json.base.clone(), json.config), (dir.clone(), dir.join("config.yaml")));
        assert_eq!(json.instances, dir.join("instances"));
        let folder = Location::resolve(&format!(" {} ", dir.display()));
        assert_eq!(folder.config, dir.join("config.yaml"));
        assert_eq!(Location::resolve("").base, home().join(".config/codenomad"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn merge_patch_matches_apply_merge_patch() {
        let current = json!({"a": {"b": 1, "c": 2}, "d": [1], "e": "x"});
        let patch = json!({"a": {"b": null, "n": {"z": null}}, "d": {"k": null}, "e": null, "f": {"g": null}});
        assert_eq!(
            merge(&current, &patch),
            json!({"a": {"c": 2, "n": {"z": null}}, "d": {"k": null}, "f": {"g": null}})
        );
        assert_eq!(merge(&current, &json!([1])), json!([1]));
        assert_eq!(merge(&json!("scalar"), &json!({"a": 1})), json!({"a": 1}));
    }

    #[test]
    fn documents_round_trip_and_refuse_unreadable_files() {
        let dir = crate::shared::test_dir("settings-doc");
        let file = dir.join("config.yaml");
        assert_eq!(read(&file), Ok(Doc::new()));
        let doc = json!({"ui": {"settings": {"locale": "fr", "flag": true, "n": 1.5, "list": ["a", "1", "true", ""]}},
            "server": {"serverId": "7c0b9a4e-3a37-4e9b-9d33-2f6f3f8b6c11", "text": "two\nlines"}});
        write(&file, doc.as_object().unwrap()).unwrap();
        assert_eq!(Value::Object(read(&file).unwrap()), doc);
        // The YAML of the reference (`yaml` 2) reads the same way.
        fs::write(
            &file,
            "ui:\n  settings:\n    locale: en\n    count: 3\n    empty: null\n    note: |-\n      a\n      b\n",
        )
        .unwrap();
        assert_eq!(
            Value::Object(read(&file).unwrap()),
            json!({"ui": {"settings": {"locale": "en", "count": 3, "empty": null, "note": "a\nb"}}})
        );
        for broken in ["", "- a\n", "a: [\n", "a: 1\na: 2\n"] {
            fs::write(&file, broken).unwrap();
            assert_eq!(read(&file), Err(Unreadable), "{broken:?}");
        }
        assert_eq!(read(&dir), Err(Unreadable));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn identity_is_claimed_once() {
        let dir = crate::shared::test_dir("settings-identity");
        let config = dir.join("config.yaml");
        let first = claim_identity(&config).unwrap();
        assert_eq!(claim_identity(&config).unwrap(), first);
        fs::write(dir.join("config.yaml.server-id"), "not a uuid").unwrap();
        assert!(claim_identity(&config).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
