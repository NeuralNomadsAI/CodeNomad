//! Discovery loader proofs (`opencode/plugin-discovery-loaders.ts`) and managed desktop plugin
//! provenance verification (`opencode/desktop-plugin-managed.ts`).

use std::{
    collections::BTreeSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{extensions::artifact, files::node_path::Style};

pub(super) const DISCOVERY_MAX_CHILDREN: usize = 256;

const ENTRYPOINT_EXTENSIONS: &[&str] = &[".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];

#[derive(Clone, Debug)]
pub(super) struct ManagedDesktopPlugin {
    pub(super) entry: String,
    pub(super) plugin: String,
    pub(super) ids: Vec<String>,
}

/// `escapes` (`plugin-discovery-loaders.ts:25`): whether a `relative` path leaves its base.
pub(super) fn escapes(style: Style, relative: &str) -> bool {
    let sep = if style == Style::Win32 { "\\" } else { "/" };
    relative == ".."
        || relative.starts_with(&format!("..{sep}"))
        || relative.starts_with("../")
        || style.is_absolute(relative)
}

fn extname(name: &str) -> &str {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(idx) if idx > 0 => &base[idx..],
        _ => "",
    }
}

/// `discoveryEntrypointShape` (`plugin-discovery-loaders.ts:16`).
pub(super) fn discovery_entrypoint_shape(style: Style, child: &str, file: &str) -> bool {
    let relative = style.relative(child, file);
    if relative.is_empty() {
        return child.ends_with(".ts") || child.ends_with(".js");
    }
    if escapes(style, &relative) || relative.contains('/') || relative.contains('\\') {
        return false;
    }
    let ext = extname(&relative);
    if !ENTRYPOINT_EXTENSIONS.contains(&ext) {
        return false;
    }
    let stem = &relative[..relative.len() - ext.len()];
    matches!(stem, "server" | "index")
}

/// Three-valued selection: `Some(Some(path))` = exact selected entrypoint,
/// `Some(None)` = provably skipped / empty, `None` = uncertain.
pub(super) fn selected_entrypoint(directory: &Path) -> Option<Option<PathBuf>> {
    let entries: Vec<fs::DirEntry> = fs::read_dir(directory).ok()?.collect::<Result<Vec<_>, _>>().ok()?;
    if entries.len() > DISCOVERY_MAX_CHILDREN {
        return None;
    }
    let style = Style::host();
    for base in ["server", "index"] {
        let prefix = format!("{base}.");
        let found: Vec<String> = entries
            .iter()
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_owned();
                let lower = name.to_ascii_lowercase();
                (lower == base || lower.starts_with(&prefix)).then_some(name)
            })
            .collect();
        if found.is_empty() {
            continue;
        }
        if found.len() > 1 {
            return None;
        }
        let only = &found[0];
        let ext = extname(only);
        if only != &format!("{base}{ext}") || !ENTRYPOINT_EXTENSIONS.contains(&ext) {
            return None;
        }
        let file = directory.join(only);
        let meta = fs::metadata(&file).ok()?;
        if !meta.is_file() {
            return None;
        }
        let root = dunce::canonicalize(directory).ok()?;
        let server = dunce::canonicalize(&file).ok()?;
        let rel = style.relative(&root.to_string_lossy(), &server.to_string_lossy());
        if escapes(style, &rel) {
            return None;
        }
        return Some(Some(file));
    }
    Some(None)
}

/// `discoveryEntrypointOf` (`plugin-discovery-loaders.ts:35`).
pub(super) fn discovery_entrypoint_of(child: &Path) -> Option<Option<PathBuf>> {
    let meta = match fs::metadata(child) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Some(None),
        Err(_) => return None,
    };
    if meta.is_file() {
        let name = child.file_name().and_then(|n| n.to_str()).unwrap_or("");
        return if name.ends_with(".ts") || name.ends_with(".js") {
            Some(Some(child.to_path_buf()))
        } else {
            Some(None)
        };
    }
    if !meta.is_dir() {
        return Some(None);
    }
    selected_entrypoint(child)
}

/// `declaredEntrypointOf` (`plugin-discovery-loaders.ts:54`).
pub(super) fn declared_entrypoint_of(target: &Path) -> Option<Option<PathBuf>> {
    let meta = match fs::metadata(target) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Some(None),
        Err(_) => return None,
    };
    if meta.is_dir() { selected_entrypoint(target) } else { Some(None) }
}

pub(super) struct ResolvedInventoryItem {
    pub(super) id: String,
    pub(super) service: String,
    pub(super) path: PathBuf,
    pub(super) real: PathBuf,
}

pub(super) fn resolve_inventory_item(id: String, service: String) -> ResolvedInventoryItem {
    let path = PathBuf::from(&service);
    let real = dunce::canonicalize(&path).unwrap_or_else(|_| path.clone());
    ResolvedInventoryItem { id, service, path, real }
}

/// `reportingEntries` (`plugin-discovery-loaders.ts:144`).
pub(super) fn reporting_entries<'a>(
    entrypoint: &Path,
    inventory: &'a [ResolvedInventoryItem],
) -> Vec<&'a ResolvedInventoryItem> {
    let real = dunce::canonicalize(entrypoint).unwrap_or_else(|_| entrypoint.to_path_buf());
    inventory.iter().filter(|entry| entry.path == entrypoint || entry.real == real).collect()
}

/// `discoveryLoaders` (`plugin-discovery-loaders.ts:106`) on the host filesystem.
pub(super) fn discovery_loaders(
    folders: &[String],
    inventory: &[ResolvedInventoryItem],
    managed: &[ManagedDesktopPlugin],
    style: Style,
) -> Option<Vec<Vec<String>>> {
    let mut loaders = Vec::new();
    for folder in folders {
        let host_folder = Path::new(folder);
        let children = match fs::read_dir(host_folder) {
            Ok(rd) => rd.collect::<Result<Vec<_>, _>>().ok()?,
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => continue,
            Err(_) => return None,
        };
        if children.len() > DISCOVERY_MAX_CHILDREN {
            return None;
        }
        for child in children {
            let Some(name) = child.file_name().to_str().map(str::to_owned) else {
                loaders.push(Vec::new());
                continue;
            };
            let entrypoint = match discovery_entrypoint_of(&host_folder.join(&name)) {
                Some(None) => continue,
                None => {
                    loaders.push(Vec::new());
                    continue;
                }
                Some(Some(ep)) => ep,
            };
            let mut ids = BTreeSet::new();
            let service_child = style.join(folder, &name);
            if let Some(m) = managed_desktop_plugin_for_source(managed, &service_child, style) {
                for id in &m.ids {
                    ids.insert(id.clone());
                }
            }
            for entry in reporting_entries(&entrypoint, inventory) {
                ids.insert(entry.id.clone());
            }
            loaders.push(ids.into_iter().collect());
        }
    }
    Some(loaders)
}

/// Strictly validates and decodes percent-escapes as Node `decodeURIComponent` / `fileURLToPath` does
/// (rejecting malformed `%` sequences such as `%zz` or truncated `%2`, as well as invalid UTF-8).
fn strict_percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = |b: u8| match b {
                b'0'..=b'9' => Some(b - b'0'),
                b'a'..=b'f' => Some(b - b'a' + 10),
                b'A'..=b'F' => Some(b - b'A' + 10),
                _ => None,
            };
            let hi = hex(bytes[i + 1])?;
            let lo = hex(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Converts a `file://` URL to a local path using Node `fileURLToPath` semantics.
pub(super) fn file_url_to_path(raw: &str, style: Style) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "file" || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    // Node `fileURLToPath` rejects percent-encoded path separators (`%2f`/`%2F`, and `%5c`/`%5C` on Windows)
    // and malformed `%` escapes (e.g. `%zz`).
    let raw_path = url.path();
    let lower_path = raw_path.to_ascii_lowercase();
    if lower_path.contains("%2f") || (style == Style::Win32 && lower_path.contains("%5c")) {
        return None;
    }
    let decoded = strict_percent_decode(raw_path)?;
    if decoded.contains('\0') {
        return None;
    }
    if style == Style::Posix {
        if url.host_str().is_some_and(|h| !h.is_empty() && !h.eq_ignore_ascii_case("localhost")) {
            return None;
        }
        return Some(decoded);
    }
    let path = url.to_file_path().ok()?;
    Some(path.to_string_lossy().into_owned())
}

pub(super) fn managed_desktop_plugin_for_source<'a>(
    installations: &'a [ManagedDesktopPlugin],
    source: &str,
    style: Style,
) -> Option<&'a ManagedDesktopPlugin> {
    let local = if source.as_bytes().get(..5).is_some_and(|p| p.eq_ignore_ascii_case(b"file:")) {
        file_url_to_path(source, style)?
    } else {
        source.to_owned()
    };
    if !style.valid_absolute(&local) {
        return None;
    }
    let identity = style.fold(&style.normalize(&local));
    installations.iter().find(|entry| {
        style.fold(&style.normalize(&entry.entry)) == identity
            || style.fold(&style.normalize(&entry.plugin)) == identity
    })
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn parse_managed_desktop_plugin_entry(feature: &str, source: &str, style: Style) -> Option<String> {
    let marker = format!("// Managed by CodeNomad: {} lifecycle v1\n", feature.replace('-', " "));
    let body = source.strip_prefix(&marker)?;
    let (import_line, export_line) = body.split_once('\n')?;
    let spec_json = import_line.strip_prefix("import { desktopPlugin } from ")?;
    let rest = export_line.strip_prefix("export default desktopPlugin(")?.strip_suffix(")\n")?;

    let url_str: String = serde_json::from_str(spec_json).ok()?;
    let args: Vec<Value> = serde_json::from_str(&format!("[{rest}]")).ok()?;
    if args.is_empty() || args.len() > 2 {
        return None;
    }
    let presence_dirs: Vec<&str> = match &args[0] {
        Value::String(s) => vec![s.as_str()],
        Value::Array(items) => {
            if items.is_empty() || items.len() > 8 {
                return None;
            }
            items.iter().map(Value::as_str).collect::<Option<Vec<_>>>()?
        }
        _ => return None,
    };
    if !presence_dirs.iter().all(|dir| {
        style.is_absolute(dir)
            && !dir.contains('\0')
            && style.basename(dir) == "presence"
            && style.basename(&style.dirname(dir)) == feature
    }) {
        return None;
    }
    let native_dir = style.dirname(presence_dirs[0]);
    let plugin = file_url_to_path(&url_str, style)?;
    let plugin_base = style.basename(&plugin);
    let plugin_hash = plugin_base.strip_suffix(".mjs")?;
    if style.dirname(&plugin) != native_dir || !is_sha256_hex(plugin_hash) {
        return None;
    }
    if args.len() == 2 {
        if feature != "missions" {
            return None;
        }
        let artifacts = args[1].as_object()?;
        if artifacts.len() != 2 || !artifacts.contains_key("provider") || !artifacts.contains_key("runtime") {
            return None;
        }
        for role in ["provider", "runtime"] {
            let art = artifacts.get(role)?.as_object()?;
            if art.len() != 2 {
                return None;
            }
            let file = art.get("file")?.as_str()?;
            let sha = art.get("sha256")?.as_str()?;
            if !is_sha256_hex(sha) || style.dirname(file) != native_dir {
                return None;
            }
            let expected_name = if role == "provider" { format!("{sha}.provider.mjs") } else { format!("{sha}.mjs") };
            if style.basename(file) != expected_name || (role == "runtime" && file != plugin) {
                return None;
            }
        }
    }
    Some(plugin)
}

fn desktop_plugin_ids(bundle: &[u8]) -> Vec<String> {
    let head = &bundle[..bundle.len().min(4096)];
    let header_line = String::from_utf8_lossy(head);
    let first = header_line.split('\n').next().unwrap_or("");
    let Some(rest) = first.strip_prefix("// CodeNomad plugin IDs: ") else { return Vec::new() };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(rest) else { return Vec::new() };
    if items.len() > 32 {
        return Vec::new();
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for item in items {
        let Some(id) = item.as_str() else { return Vec::new() };
        if !super::order::valid_plugin_id(id) {
            return Vec::new();
        }
        if seen.insert(id.to_owned()) {
            out.push(id.to_owned());
        }
    }
    out
}

/// `readManagedDesktopPlugins` (`desktop-plugin-managed.ts:79`) on the host filesystem.
pub(super) fn read_managed_desktop_plugins(global_dir: &str, style: Style) -> Vec<ManagedDesktopPlugin> {
    let directory = style.join(global_dir, "plugins");
    let Ok(entries) = fs::read_dir(&directory) else { return Vec::new() };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        let Some(feature) = name.strip_prefix("codenomad-").and_then(|s| s.strip_suffix(".ts")) else { continue };
        if feature.is_empty()
            || !feature.as_bytes()[0].is_ascii_lowercase()
            || !feature.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            continue;
        }
        let Some(source_bytes) = artifact::read_regular_nofollow(&Path::new(&directory).join(&name), 64 * 1024) else {
            continue;
        };
        let Ok(source_text) = std::str::from_utf8(&source_bytes) else { continue };
        let Some(plugin) = parse_managed_desktop_plugin_entry(feature, source_text, style) else { continue };
        let plugin_base = style.basename(&plugin);
        let Some(expected_hash) = plugin_base.strip_suffix(".mjs") else { continue };
        let Some(bundle) = artifact::read_regular_nofollow(Path::new(&plugin), 32 * 1024 * 1024) else { continue };
        let actual_hash = format!("{:x}", Sha256::digest(&bundle));
        if actual_hash != expected_hash {
            continue;
        }
        result.push(ManagedDesktopPlugin {
            entry: style.join(&directory, &name),
            plugin,
            ids: desktop_plugin_ids(&bundle),
        });
    }
    result
}
