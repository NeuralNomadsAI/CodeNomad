//! Bundled plugin provisioning, after the reference
//! `opencode/desktop-plugin-{paths,installation,provisioning}.ts`.
//!
//! Always the reference set under `serve`, like the reference; the positional
//! launch opts in with `CNRS_PROVISION_PLUGINS` (`1` = the reference set, see
//! `selected`, or a comma list). Payloads come from the `plugins/` folder beside
//! the binary (positional launch: `CNRS_PLUGIN_ASSETS` first) (`<feature>/plugin.mjs`, Missions
//! `provider.mjs`). `lifecycle` runs it on every daemon connection.
//! The discovery root is the one the connected daemon reports through
//! `GET /api/config`, never this process's environment. Payloads are
//! content-addressed (`<sha256>.mjs`) in the sibling `.codenomad/<root-hash>/`
//! namespace and never deleted, so a running daemon keeps the copy it loaded
//! while the managed shim moves to a new payload. `CNRS_PLUGIN_PROFILE_ROOT`
//! optionally confines the discovery root (test benches).

use crate::{Shared, extensions::artifact};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    env, fs, io,
    path::{Component, Path, PathBuf},
    time::Duration,
};

/// In `prepareDesktopPluginPresence` order.
pub const FEATURES: [&str; 4] = ["session-pruning", "automation", "missions", "memory"];
const MAX_BUNDLE: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Paths {
    pub config: PathBuf,
    pub data: PathBuf,
}

/// `path.win32.normalize` / `path.posix.normalize` (lexical; keeps a trailing separator).
fn normalize(raw: &str) -> String {
    let sep = if cfg!(windows) { '\\' } else { '/' };
    let text = if cfg!(windows) { raw.replace('/', "\\") } else { raw.to_owned() };
    let mut out: Vec<String> = Vec::new();
    let mut prefix = String::new();
    for component in Path::new(&text).components() {
        match component {
            Component::Prefix(p) => prefix = p.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir => prefix.push(sep),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(n) => out.push(n.to_string_lossy().into_owned()),
        }
    }
    let mut joined = prefix + &out.join(&sep.to_string());
    if (text.ends_with(sep)) && !joined.ends_with(sep) {
        joined.push(sep);
    }
    joined
}

/// Sibling namespace of the authenticated discovery root (`desktop-plugin-paths.ts`).
pub fn namespace(directory: &str) -> Result<Paths, String> {
    if !Path::new(directory).is_absolute() || directory.contains('\0') {
        return Err("Connected OpenCode daemon did not report an absolute global plugin discovery directory".into());
    }
    let config = normalize(directory);
    let parent = Path::new(&config).parent().ok_or("OpenCode discovery root has no unwatched parent")?;
    let identity = if cfg!(windows) { config.to_lowercase() } else { config.clone() };
    let data = parent.join(".codenomad").join(artifact::sha256_hex(identity.as_bytes()));
    Ok(Paths { config: config.into(), data })
}

fn within(directory: &Path, root: &Path) -> bool {
    let fold = |p: &Path| {
        let s = p.to_string_lossy().into_owned();
        PathBuf::from(if cfg!(windows) { s.to_lowercase() } else { s })
    };
    fold(directory).starts_with(fold(root))
}

fn marker(feature: &str) -> String {
    format!("// Managed by CodeNomad: {} lifecycle v1\n", feature.replace('-', " "))
}

struct Storage {
    directory: PathBuf,
    presence: Vec<PathBuf>,
}

/// `parseManagedDesktopPluginEntry`: only the installer's exact generated shim.
fn parse_entry(feature: &str, source: &str) -> Result<Option<Storage>, String> {
    let invalid = |what: &str| Err(format!("Invalid managed CodeNomad plugin {what}"));
    let Some(rest) = source.strip_prefix(&marker(feature)) else { return Ok(None) };
    let shape = regex::Regex::new(
        r#"^import \{ desktopPlugin \} from ("(?:[^"\\]|\\.)*")\nexport default desktopPlugin\((.+)\)\n$"#,
    )
    .expect("static entry pattern");
    let Some(m) = shape.captures(rest) else { return invalid("entry") };
    let url: String = serde_json::from_str(&m[1]).map_err(|_| "Invalid managed CodeNomad plugin entry")?;
    let args: Vec<Value> =
        serde_json::from_str(&format!("[{}]", &m[2])).map_err(|_| "Invalid managed CodeNomad plugin arguments")?;
    if args.is_empty() || args.len() > 2 {
        return invalid("arguments");
    }
    let dirs: Vec<Value> = match &args[0] {
        Value::String(_) => vec![args[0].clone()],
        Value::Array(list) => list.clone(),
        _ => vec![],
    };
    let presence: Vec<PathBuf> = dirs.iter().filter_map(Value::as_str).map(PathBuf::from).collect();
    if presence.is_empty()
        || presence.len() > 8
        || presence.len() != dirs.len()
        || !presence.iter().all(|d| {
            d.is_absolute()
                && !d.to_string_lossy().contains('\0')
                && d.file_name().is_some_and(|n| n == "presence")
                && d.parent().and_then(Path::file_name).is_some_and(|n| n == feature)
        })
    {
        return invalid("presence");
    }
    let directory = presence[0].parent().expect("checked").to_path_buf();
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid managed CodeNomad plugin storage")?;
    let plugin = (parsed.scheme() == "file"
        && parsed.query().is_none()
        && parsed.fragment().is_none()
        && (cfg!(windows) || parsed.host_str().unwrap_or("").is_empty()))
    .then(|| parsed.to_file_path().ok())
    .flatten();
    let hashed = |p: &Path, suffix: &str| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            n.strip_suffix(suffix)
                .is_some_and(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        })
    };
    let Some(plugin) = plugin.filter(|p| p.parent() == Some(&directory) && hashed(p, ".mjs")) else {
        return invalid("storage");
    };
    if let Some(artifacts) = args.get(1) {
        let roles = artifacts.as_object().map(|o| {
            let mut k: Vec<_> = o.keys().cloned().collect();
            k.sort();
            k
        });
        if feature != "missions" || roles.as_deref() != Some(&["provider".to_owned(), "runtime".to_owned()][..]) {
            return invalid("Missions artifacts");
        }
        for (role, suffix) in [("provider", ".provider.mjs"), ("runtime", ".mjs")] {
            let a = &artifacts[role];
            let ok = a.as_object().is_some_and(|o| o.len() == 2)
                && a["sha256"].as_str().is_some_and(|h| {
                    h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                })
                && a["file"].as_str().is_some_and(|f| {
                    let f = Path::new(f);
                    f.parent() == Some(&directory)
                        && f.file_name().and_then(|n| n.to_str())
                            == Some(&format!("{}{suffix}", a["sha256"].as_str().unwrap_or("")))
                        && (role != "runtime" || f == plugin)
                });
            if !ok {
                return invalid("Missions artifacts");
            }
        }
    }
    Ok(Some(Storage { directory, presence }))
}

/// One installed feature: its payload hash, shim and owned backend lease.
#[derive(Debug, Clone)]
pub struct Installed {
    pub feature: &'static str,
    pub sha256: String,
    pub provider: Option<String>,
    pub entry: PathBuf,
    pub lease: PathBuf,
}

/// `installDesktopPluginPresence` without the readiness challenge files
/// (Rust polls the native plugin catalogue instead, `pending::await_plugin`).
/// `isLegacyAutomationPlugin`: the pre-lifecycle entry re-exporting the server's
/// own `opencode/automation-plugin.{js,ts}`, which the managed shim replaces.
pub fn legacy_automation(source: &str) -> bool {
    let shape = regex::Regex::new(r#"^export \{ default \} from ("(?:[^"\\]|\\.)*")\s*$"#).expect("static pattern");
    let Some(m) = shape.captures(source) else { return false };
    let Some(url) = serde_json::from_str::<String>(&m[1]).ok().and_then(|u| reqwest::Url::parse(&u).ok()) else {
        return false;
    };
    let tail = regex::Regex::new(r"(?:/server/dist|/packages/server/src)/opencode/automation-plugin\.(?:js|ts)$")
        .expect("static pattern");
    url.scheme() == "file" && tail.is_match(url.path())
}

/// `lease` is the backend's current lease content (empty when it requests nothing).
pub fn install(
    feature: &'static str,
    bundle: &[u8],
    provider: Option<&[u8]>,
    paths: &Paths,
    lease_content: &str,
) -> io::Result<Installed> {
    let fail = |m: String| io::Error::other(m);
    if provider.is_some() && feature != "missions" {
        return Err(fail("Local carrier provider requires Missions".into()));
    }
    let marker = marker(feature);
    let hash = artifact::sha256_hex(bundle);
    let entry = paths.config.join("plugins").join(format!("codenomad-{feature}.ts"));
    let existing = match fs::read_to_string(&entry) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    if existing.as_ref().is_some_and(|s| !s.starts_with(&marker) && !(feature == "automation" && legacy_automation(s)))
    {
        return Err(fail(format!("Existing plugin entry is not managed by CodeNomad: {}", entry.display())));
    }
    let storage = match &existing {
        Some(s) => parse_entry(feature, s).map_err(fail)?,
        None => None,
    };
    let retained = storage.as_ref().filter(|s| !within(&s.directory, &paths.config));
    let directory = retained.map_or_else(|| paths.data.join(feature), |s| s.directory.clone());
    let leases = directory.join("presence");
    let plugin = directory.join(format!("{hash}.mjs"));
    let url = reqwest::Url::from_file_path(&plugin).map_err(|_| fail("Plugin path has no file URL".into()))?;
    let mut seen = HashSet::new();
    let presence: Vec<String> = std::iter::once(leases.clone())
        .chain(storage.iter().flat_map(|s| s.presence.clone()))
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| seen.insert(p.clone()))
        .collect();
    let provider_hash = provider.map(artifact::sha256_hex);
    let provider_file = provider_hash.as_ref().map(|h| directory.join(format!("{h}.provider.mjs")));
    let presence_arg = if presence.len() == 1 { json!(presence[0]) } else { json!(presence) };
    let artifacts = provider_hash.as_ref().map(|h| {
        json!({"provider":{"file":provider_file.as_ref().unwrap(),"sha256":h},"runtime":{"file":plugin,"sha256":hash}})
    });
    let source = format!(
        "{marker}import {{ desktopPlugin }} from {}\nexport default desktopPlugin({}{})\n",
        json!(url.as_str()),
        presence_arg,
        artifacts.map(|a| format!(", {a}")).unwrap_or_default()
    );
    fs::create_dir_all(&leases)?;
    fs::create_dir_all(entry.parent().expect("entry has a parent"))?;
    // Immutable, content-addressed payloads keep running instances independent of upgrades.
    let mut runtime_id = artifact::install(&plugin, bundle, &hash)?;
    let mut provider_id = match (provider, &provider_file, &provider_hash) {
        (Some(bytes), Some(file), Some(h)) => Some(artifact::install(file, bytes, h)?),
        _ => None,
    };
    let assert_payloads = |runtime_id: &mut _, provider_id: &mut Option<_>| -> io::Result<()> {
        artifact::assert_unchanged(&plugin, runtime_id, bundle, &hash)?;
        if let (Some(id), Some(file), Some(bytes), Some(h)) =
            (provider_id.as_mut(), &provider_file, provider, &provider_hash)
        {
            artifact::assert_unchanged(file, id, bytes, h)?;
        }
        Ok(())
    };
    assert_payloads(&mut runtime_id, &mut provider_id)?;
    let lease = leases.join(format!("{}.lease", uuid::Uuid::new_v4()));
    artifact::write_replacing(&lease, lease_content.as_bytes())?;
    let published = (|| {
        if existing.as_deref() != Some(&source) {
            assert_payloads(&mut runtime_id, &mut provider_id)?;
            artifact::write_replacing(&entry, source.as_bytes())?;
        }
        Ok(())
    })();
    if let Err(e) = published {
        let _ = fs::remove_file(&lease);
        return Err(e);
    }
    Ok(Installed { feature, sha256: hash, provider: provider_hash, entry, lease })
}

pub fn ready_marker(lease: &Path) -> PathBuf {
    let mut name = lease.as_os_str().to_owned();
    name.push(".ready");
    name.into()
}

/// Lease release: the payloads stay for native carrier recovery and older copies.
pub fn dispose(installed: &[Installed]) {
    for i in installed {
        let _ = fs::remove_file(&i.lease);
        let _ = fs::remove_file(ready_marker(&i.lease));
    }
}

/// `lease-request.ts`: `{"version":1,"<field>":true}` while requested, else empty.
pub fn lease_request(field: &str, requested: bool) -> String {
    if requested { format!("{{\"version\":1,{}:true}}", json!(field)) } else { String::new() }
}

/// The reference `index.ts` set: pruning always; automation only for a desktop
/// native parent (`CODENOMAD_NATIVE_PARENT=1`); Missions and memory with the
/// backend's Missions host. A comma list selects features explicitly.
pub fn selected() -> Result<Vec<&'static str>, String> {
    let Some(value) = crate::config::provision_plugins() else { return Ok(vec![]) };
    if value == "1" {
        let parent = crate::config::native_parent();
        return Ok(FEATURES.iter().copied().filter(|f| *f != "automation" || parent).collect());
    }
    let mut chosen: Vec<&'static str> = Vec::new();
    for name in value.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let feature = FEATURES.iter().copied().find(|f| *f == name).ok_or(format!("Unknown bundled plugin: {name}"))?;
        if !chosen.contains(&feature) {
            chosen.push(feature);
        }
    }
    // Provisioning order of `prepareDesktopPluginPresence`.
    chosen.sort_by_key(|f| FEATURES.iter().position(|x| x == f));
    Ok(chosen)
}

fn assets() -> io::Result<PathBuf> {
    if let Some(dir) = crate::config::plugin_assets() {
        return Ok(dir.into());
    }
    let exe = env::current_exe()?;
    Ok(exe.parent().ok_or_else(|| io::Error::other("binary has no folder"))?.join("plugins"))
}

pub fn payloads(feature: &str) -> io::Result<(Vec<u8>, Option<Vec<u8>>)> {
    let dir = assets()?.join(feature);
    let read = |name: &str| {
        artifact::read_bounded(&dir.join(name), MAX_BUNDLE)?
            .ok_or_else(|| io::Error::other(format!("Bundled plugin payload missing: {feature}/{name}")))
    };
    Ok((read("plugin.mjs")?, if feature == "missions" { Some(read("provider.mjs")?) } else { None }))
}

/// `resolveDesktopPluginPaths` on the current connection: `config.get` only.
pub async fn discovery(app: &Shared) -> Result<Paths, String> {
    let failed =
        |e: &str| format!("Cannot provision bundled plugins without the connected daemon's discovery directory ({e})");
    let response = app
        .native
        .get("/api/config")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| failed("unreachable"))?
        .error_for_status()
        .map_err(|_| failed("refused"))?;
    let config = crate::opencode::read_json(response, 2 * 1024 * 1024).await.map_err(|_| failed("unreadable"))?;
    let directory = config
        .as_array()
        .and_then(|a| a.iter().find(|x| x["type"] == "directory"))
        .and_then(|x| x["path"].as_str())
        .ok_or_else(|| failed("no directory"))?;
    let paths = namespace(directory)?;
    if let Some(root) = crate::config::plugin_profile_root() {
        let root = dunce::canonicalize(root).map_err(|_| "Plugin profile root is unavailable".to_owned())?;
        let config = dunce::canonicalize(&paths.config).unwrap_or_else(|_| paths.config.clone());
        if !within(&config, &root) {
            return Err("Connected OpenCode discovery directory is outside CNRS_PLUGIN_PROFILE_ROOT".into());
        }
    }
    Ok(paths)
}

#[cfg(test)]
#[path = "provision_tests.rs"]
mod tests;
