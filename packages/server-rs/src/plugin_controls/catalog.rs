//! Reviewed OpenCode integration catalog (`opencode/integrations/catalog.ts`,
//! `contract.ts`, `recognition.ts`) consumed by `POST /api/workspaces/:id/plugin-sources`
//! for `global-only` and cross-spec/runtime `duplicate` enforcement.

use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::{Client, Url, header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify};

use super::spec::registry_package_name;

pub(crate) const INTEGRATION_CATALOG_RELEASES_URL: &str =
    "https://api.github.com/repos/NeuralNomadsAI/opencode-integrations/releases?per_page=100";
const INTEGRATION_CATALOG_ASSET: &str = "catalog.json";
const INTEGRATION_CATALOG_CACHE_MS: u64 = 30_000;
const INTEGRATION_CATALOG_TIMEOUT_MS: u64 = 10_000;
const INTEGRATION_CATALOG_MAX_BYTES: usize = 256 * 1024;
const INTEGRATION_CATALOG_MAX_ENTRIES: usize = 64;
const INTEGRATION_CATALOG_MAX_PAGES: usize = 5;
const RELEASE_LIST_MAX_BYTES: usize = 1024 * 1024;
const RATE_LIMIT_MAX_WAIT_MS: u64 = 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CatalogAvailability {
    Fresh,
    Stale,
    Unavailable,
}

#[derive(Clone, Debug)]
pub(crate) struct IntegrationCatalogView {
    pub(crate) state: CatalogAvailability,
    pub(crate) fetched_at: Option<String>,
    pub(crate) catalog: IntegrationCatalog,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct IntegrationCatalog {
    pub(crate) integrations: Vec<IntegrationCatalogEntry>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationCatalogApp {
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) versions: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationCatalogEntry {
    pub(crate) id: String,
    pub(crate) family: String,
    pub(crate) package: String,
    #[serde(default)]
    pub(crate) range: String,
    #[serde(default)]
    pub(crate) display_name: String,
    pub(crate) plugin: String,
    pub(crate) rpc: String,
    #[serde(default)]
    pub(crate) summary: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) app: IntegrationCatalogApp,
    #[serde(default)]
    pub(crate) docs: String,
    #[serde(default)]
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) sources: Option<IntegrationCatalogSources>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct IntegrationCatalogSources {
    #[serde(default)]
    pub(crate) git: Vec<String>,
}

#[derive(Clone)]
struct KnownCatalog {
    catalog: IntegrationCatalog,
    /// Full validated `catalog.json` document persisted verbatim so both Rust and TS reload it identically.
    raw_document: Value,
    fetched_at: String,
    revision: String,
}

#[derive(Clone)]
struct Release {
    revision: String,
    asset_url: String,
}

#[derive(Clone)]
struct Attempt {
    at_ms: u64,
    ok: bool,
    until_ms: Option<u64>,
}

struct ListTag {
    etag: String,
    release: Option<Release>,
}

#[derive(Default)]
struct CatalogState {
    loaded: bool,
    known: Option<KnownCatalog>,
    attempt: Option<Attempt>,
    list_tag: Option<ListTag>,
    releases_url: Option<String>,
    /// Detached in-flight refresh task; held until download + persistence finish so dropping a caller
    /// never lets a second refresh race an older disk write.
    refreshing: Option<Arc<Notify>>,
}

impl CatalogState {
    fn view(&self) -> IntegrationCatalogView {
        let Some(ref known) = self.known else {
            return IntegrationCatalogView {
                state: CatalogAvailability::Unavailable,
                fetched_at: None,
                catalog: IntegrationCatalog::default(),
            };
        };
        let state = if self.attempt.as_ref().is_some_and(|a| a.ok) {
            CatalogAvailability::Fresh
        } else {
            CatalogAvailability::Stale
        };
        IntegrationCatalogView { state, fetched_at: Some(known.fetched_at.clone()), catalog: known.catalog.clone() }
    }
}

pub(crate) struct CatalogSource {
    state_file: Option<PathBuf>,
    state: Arc<Mutex<CatalogState>>,
}

impl CatalogSource {
    pub(crate) fn new(state_file: Option<PathBuf>) -> Self {
        let releases_url = if cfg!(test) { None } else { Some(INTEGRATION_CATALOG_RELEASES_URL.to_owned()) };
        Self { state_file, state: Arc::new(Mutex::new(CatalogState { releases_url, ..Default::default() })) }
    }

    #[cfg(test)]
    pub(crate) async fn set_releases_url(&self, url: Option<String>) {
        let mut st = self.state.lock().await;
        st.releases_url = url;
        st.attempt = None;
        st.list_tag = None;
    }

    #[cfg(test)]
    pub(crate) async fn seed_for_test(&self, catalog: IntegrationCatalog) {
        self.seed_view_for_test(
            CatalogAvailability::Fresh,
            Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            catalog,
        )
        .await;
    }

    #[cfg(test)]
    pub(crate) async fn seed_view_for_test(
        &self,
        state: CatalogAvailability,
        fetched_at: Option<String>,
        catalog: IntegrationCatalog,
    ) {
        let mut st = self.state.lock().await;
        st.loaded = true;
        st.releases_url = None;
        match state {
            CatalogAvailability::Unavailable => {
                st.known = None;
                st.attempt = Some(Attempt { at_ms: now_ms(), ok: false, until_ms: None });
            }
            CatalogAvailability::Fresh | CatalogAvailability::Stale => {
                st.known = Some(KnownCatalog {
                    catalog,
                    raw_document: json!({ "schemaVersion": 1, "integrations": [] }),
                    fetched_at: fetched_at
                        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                    revision: "catalog-v1#1@2026-01-01T00:00:00Z".to_owned(),
                });
                st.attempt = Some(Attempt { at_ms: now_ms(), ok: state == CatalogAvailability::Fresh, until_ms: None });
            }
        }
    }

    pub(crate) async fn read(&self) -> IntegrationCatalog {
        self.read_view(true).await.catalog
    }

    pub(crate) async fn read_view(&self, refresh: bool) -> IntegrationCatalogView {
        self.ensure_loaded().await;
        if !refresh {
            return self.state.lock().await.view();
        }
        let now = now_ms();
        let waiter = {
            let mut st = self.state.lock().await;
            let fresh = st.attempt.as_ref().is_some_and(|a| {
                now < a.at_ms.saturating_add(INTEGRATION_CATALOG_CACHE_MS).max(a.until_ms.unwrap_or(0))
            });
            let Some(url) = st.releases_url.clone() else {
                return st.view();
            };
            if fresh {
                return st.view();
            }
            if let Some(notify) = st.refreshing.clone() {
                notify
            } else {
                let notify = Arc::new(Notify::new());
                st.refreshing = Some(notify.clone());
                let state = self.state.clone();
                let state_file = self.state_file.clone();
                let known_rev = st.known.as_ref().map(|k| k.revision.clone());
                let list_etag = st.list_tag.as_ref().map(|t| t.etag.clone());
                let list_release = st.list_tag.as_ref().and_then(|t| t.release.clone());
                let notify_done = notify.clone();
                tokio::spawn(async move {
                    run_refresh(state, state_file, url, known_rev, list_etag, list_release, notify_done).await;
                });
                notify
            }
        };
        let notified = waiter.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let still_running = {
            let st = self.state.lock().await;
            st.refreshing.as_ref().is_some_and(|cur| Arc::ptr_eq(cur, &waiter))
        };
        if still_running {
            notified.await;
        }
        self.state.lock().await.view()
    }

    async fn ensure_loaded(&self) {
        {
            let st = self.state.lock().await;
            if st.loaded {
                return;
            }
        }
        let loaded = match &self.state_file {
            Some(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || load_persisted(&path)).await.ok().flatten()
            }
            None => None,
        };
        let mut st = self.state.lock().await;
        if !st.loaded {
            st.loaded = true;
            if st.known.is_none() {
                st.known = loaded;
            }
        }
    }
}

/// Detached single-flight refresh holding `CatalogState::refreshing` through download and disk
/// persistence, matching TS `this.refreshing ??= this.refresh().finally(...)`.
async fn run_refresh(
    state: Arc<Mutex<CatalogState>>,
    state_file: Option<PathBuf>,
    releases_url: String,
    known_revision: Option<String>,
    cached_etag: Option<String>,
    cached_release: Option<Release>,
    notify_done: Arc<Notify>,
) {
    let total_budget = Duration::from_millis(INTEGRATION_CATALOG_TIMEOUT_MS);
    let outcome = match Client::builder().build() {
        Ok(client) => {
            tokio::time::timeout(total_budget, async {
                let (release_opt, new_tag) =
                    fetch_newest_release(&client, &releases_url, cached_etag.as_deref(), cached_release).await?;
                let Some(release) = release_opt else {
                    return Ok::<_, Option<u64>>((None, new_tag));
                };
                if known_revision.as_deref() == Some(release.revision.as_str()) {
                    return Ok((Some(RefreshMatch::Unchanged), new_tag));
                }
                let (catalog, raw_document) = download_catalog(&client, &release.asset_url).await?;
                Ok((
                    Some(RefreshMatch::Updated(KnownCatalog {
                        catalog,
                        raw_document,
                        fetched_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        revision: release.revision,
                    })),
                    new_tag,
                ))
            })
            .await
        }
        Err(_) => Ok(Err(None)),
    };

    match outcome {
        Ok(Ok((Some(RefreshMatch::Updated(known)), new_tag))) => {
            if let Some(path) = state_file {
                let persist_known = known.clone();
                let _ = tokio::task::spawn_blocking(move || persist_catalog(&path, &persist_known)).await;
            }
            let mut st = state.lock().await;
            st.list_tag = new_tag;
            st.known = Some(known);
            st.attempt = Some(Attempt { at_ms: now_ms(), ok: true, until_ms: None });
            st.refreshing = None;
        }
        Ok(Ok((Some(RefreshMatch::Unchanged), new_tag))) => {
            let mut st = state.lock().await;
            st.list_tag = new_tag;
            st.attempt = Some(Attempt { at_ms: now_ms(), ok: true, until_ms: None });
            st.refreshing = None;
        }
        Ok(Ok((None, new_tag))) => {
            let mut st = state.lock().await;
            st.list_tag = new_tag;
            st.attempt = Some(Attempt { at_ms: now_ms(), ok: false, until_ms: None });
            st.refreshing = None;
        }
        Ok(Err(retry_at)) => {
            let now = now_ms();
            let mut st = state.lock().await;
            st.attempt = Some(Attempt {
                at_ms: now,
                ok: false,
                until_ms: retry_at.map(|r| r.min(now.saturating_add(RATE_LIMIT_MAX_WAIT_MS))),
            });
            st.refreshing = None;
        }
        Err(_) => {
            let mut st = state.lock().await;
            st.attempt = Some(Attempt { at_ms: now_ms(), ok: false, until_ms: None });
            st.refreshing = None;
        }
    }
    notify_done.notify_waiters();
}

enum RefreshMatch {
    Unchanged,
    Updated(KnownCatalog),
}

/// Catalog integrations a source spec designates by registry package name (way 1) or Git prefix (way 3)
/// (`integrationsForSpec` in `opencode/integrations/recognition.ts`).
pub(crate) fn integrations_for_spec<'a>(
    catalog: &'a IntegrationCatalog,
    spec: &str,
) -> Vec<&'a IntegrationCatalogEntry> {
    let pkg = registry_package_name(spec);
    catalog
        .integrations
        .iter()
        .filter(|entry| {
            pkg.as_deref() == Some(entry.package.as_str())
                || entry.sources.as_ref().is_some_and(|s| s.git.iter().any(|prefix| spec.starts_with(prefix.as_str())))
        })
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn valid_revision(value: &str) -> bool {
    let Some((tag, rest)) = value.split_once('#') else { return false };
    if valid_catalog_tag(tag).is_none() {
        return false;
    }
    let Some((id, updated)) = rest.split_once('@') else { return false };
    (1..=20).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_digit())
        && (1..=64).contains(&updated.len())
        && !updated.chars().any(char::is_whitespace)
}

fn valid_catalog_tag(tag: &str) -> Option<u64> {
    let num = tag.strip_prefix("catalog-v")?;
    if num == "0" {
        return Some(0);
    }
    if !(1..=9).contains(&num.len()) || !num.bytes().all(|b| b.is_ascii_digit()) || num.starts_with('0') {
        return None;
    }
    num.parse::<u64>().ok()
}

pub(crate) fn valid_integration_id(s: &str) -> bool {
    let bytes = s.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn valid_neuralnomads_id(s: &str) -> bool {
    s.strip_prefix("neuralnomads.").is_some_and(valid_integration_id)
}

fn valid_package_name(s: &str) -> bool {
    s.strip_prefix("@neuralnomads/opencode-").is_some_and(valid_integration_id)
}

pub(crate) fn valid_range(s: &str) -> bool {
    let len = s.chars().count();
    (1..=64).contains(&len)
        && s.bytes().all(|b| {
            b.is_ascii_digit()
                || matches!(b, b'x' | b'X' | b'*' | b'^' | b'~' | b'<' | b'>' | b'=' | b'|' | b'.' | b' ' | b'-')
        })
}

fn valid_display_name(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("OpenCode for ") else { return false };
    let mut chars = rest.chars();
    let Some(first) = chars.next() else { return false };
    // ECMAScript `\S` rejects all JS whitespace (including U+FEFF), and `.` excludes line terminators.
    !crate::shared::js_space(first)
        && !rest.chars().any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
        && s.chars().count() <= 60
}

fn valid_locale_key(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_lowercase() || !bytes[1].is_ascii_lowercase() {
        return false;
    }
    if bytes.len() == 2 {
        return true;
    }
    if bytes[2] != b'-' {
        return false;
    }
    let region = &bytes[3..];
    (2..=4).contains(&region.len()) && region[0].is_ascii_uppercase() && region[1..].iter().all(u8::is_ascii_alphabetic)
}

fn valid_min_app_version(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    (1..=3).contains(&parts.len()) && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn valid_positive_safe_int(value: &Value) -> bool {
    let Some(n) = value.as_f64() else { return false };
    n.is_finite() && n.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&n)
}

/// Validates the complete `integrationCatalogSchema` (`opencode/integrations/contract.ts:95-131`).
pub(crate) fn parse_catalog_value(value: &Value) -> Option<IntegrationCatalog> {
    let obj = value.as_object()?;
    if obj.len() != 2 || obj.get("schemaVersion").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let list = obj.get("integrations")?.as_array()?;
    if list.len() > INTEGRATION_CATALOG_MAX_ENTRIES {
        return None;
    }
    let serialized = serde_json::to_vec(value).ok()?;
    if serialized.len() > INTEGRATION_CATALOG_MAX_BYTES {
        return None;
    }

    let mut ids = HashSet::new();
    let mut packages = HashSet::new();
    let mut plugins = HashSet::new();
    let mut rpcs = HashSet::new();
    let mut out = Vec::with_capacity(list.len());

    for item in list {
        let entry = item.as_object()?;
        if entry.keys().any(|k| {
            !matches!(
                k.as_str(),
                "id" | "package"
                    | "range"
                    | "displayName"
                    | "family"
                    | "plugin"
                    | "rpc"
                    | "summary"
                    | "app"
                    | "host"
                    | "vendor"
                    | "docs"
                    | "status"
                    | "sources"
            )
        }) {
            return None;
        }
        let id = entry.get("id")?.as_str()?;
        let package = entry.get("package")?.as_str()?;
        let range = entry.get("range")?.as_str()?;
        let display_name = entry.get("displayName")?.as_str()?;
        let family = entry.get("family")?.as_str()?;
        let plugin = entry.get("plugin")?.as_str()?;
        let rpc = entry.get("rpc")?.as_str()?;
        let docs = entry.get("docs")?.as_str()?;
        let status = entry.get("status")?.as_str()?;

        if !valid_integration_id(id)
            || !valid_package_name(package)
            || !valid_range(range)
            || !valid_display_name(display_name)
            || !matches!(family, "native" | "vendor-mcp" | "api")
            || !valid_neuralnomads_id(plugin)
            || !valid_neuralnomads_id(rpc)
            || !docs.starts_with("https://github.com/NeuralNomadsAI/opencode-integrations/")
            || docs.chars().count() > 300
            || !matches!(status, "preview" | "stable" | "deprecated")
        {
            return None;
        }

        // `summary`: record of locale -> 1..=300 code points, must include `"en"`, max 16 keys.
        let summary = entry.get("summary")?.as_object()?;
        if summary.is_empty() || summary.len() > 16 || !summary.contains_key("en") {
            return None;
        }
        let mut parsed_summary = BTreeMap::new();
        for (locale, text) in summary {
            let text_str = text.as_str()?;
            let cp = text_str.chars().count();
            if !valid_locale_key(locale) || !(1..=300).contains(&cp) {
                return None;
            }
            parsed_summary.insert(locale.clone(), text_str.to_owned());
        }

        // `app`: strict `{ name: 1..=60, versions?: range }`.
        let app = entry.get("app")?.as_object()?;
        if app.keys().any(|k| !matches!(k.as_str(), "name" | "versions")) {
            return None;
        }
        let app_name = app.get("name")?.as_str()?;
        if !(1..=60).contains(&app_name.chars().count()) {
            return None;
        }
        let app_versions = match app.get("versions") {
            None => None,
            Some(versions) => {
                let s = versions.as_str().filter(|v| valid_range(v))?;
                Some(s.to_owned())
            }
        };

        // `host`: required iff `family == "native"`; strict `{ protocol: int >= 1, range: range }`.
        let host = entry.get("host");
        if (family == "native") != host.is_some() {
            return None;
        }
        if let Some(host_val) = host {
            let hobj = host_val.as_object()?;
            if hobj.len() != 2
                || !hobj.get("protocol").is_some_and(valid_positive_safe_int)
                || !hobj.get("range").and_then(Value::as_str).is_some_and(valid_range)
            {
                return None;
            }
        }

        // `vendor`: only allowed for `vendor-mcp`; strict `{ server: 1..=80, minAppVersion?: ... }`.
        let vendor = entry.get("vendor");
        if family != "vendor-mcp" && vendor.is_some() {
            return None;
        }
        if let Some(vendor_val) = vendor {
            let vobj = vendor_val.as_object()?;
            if vobj.keys().any(|k| !matches!(k.as_str(), "server" | "minAppVersion")) {
                return None;
            }
            let server = vobj.get("server")?.as_str()?;
            if !(1..=80).contains(&server.chars().count()) {
                return None;
            }
            if let Some(min_v) = vobj.get("minAppVersion")
                && !min_v.as_str().is_some_and(valid_min_app_version)
            {
                return None;
            }
        }

        // `sources`: optional strict `{ git?: string[] <= 8 }`.
        let sources = match entry.get("sources") {
            None => None,
            Some(v) => {
                let sobj = v.as_object()?;
                if sobj.keys().any(|k| k != "git") {
                    return None;
                }
                let git = match sobj.get("git") {
                    None => Vec::new(),
                    Some(g) => {
                        let arr = g.as_array()?;
                        if arr.len() > 8 {
                            return None;
                        }
                        let mut prefixes = Vec::with_capacity(arr.len());
                        for p in arr {
                            let ps = p.as_str()?;
                            if !ps.starts_with("github:NeuralNomadsAI/opencode-integrations#")
                                || ps.chars().count() > 200
                            {
                                return None;
                            }
                            prefixes.push(ps.to_owned());
                        }
                        prefixes
                    }
                };
                Some(IntegrationCatalogSources { git })
            }
        };

        if !ids.insert(id.to_owned())
            || !packages.insert(package.to_owned())
            || !plugins.insert(plugin.to_owned())
            || !rpcs.insert(rpc.to_owned())
        {
            return None;
        }
        out.push(IntegrationCatalogEntry {
            id: id.to_owned(),
            family: family.to_owned(),
            package: package.to_owned(),
            range: range.to_owned(),
            display_name: display_name.to_owned(),
            plugin: plugin.to_owned(),
            rpc: rpc.to_owned(),
            summary: parsed_summary,
            app: IntegrationCatalogApp { name: app_name.to_owned(), versions: app_versions },
            docs: docs.to_owned(),
            status: status.to_owned(),
            sources,
        });
    }
    Some(IntegrationCatalog { integrations: out })
}

fn parse_utf8_json_strip_bom(bytes: &[u8]) -> Option<Value> {
    // Matches JS `new TextDecoder("utf-8", { fatal: true }).decode(bytes)` which strips a leading UTF-8 BOM.
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    serde_json::from_slice(body).ok()
}

fn load_persisted(path: &Path) -> Option<KnownCatalog> {
    let raw_bytes = std::fs::read(path).ok()?;
    if raw_bytes.len() > INTEGRATION_CATALOG_MAX_BYTES * 2 {
        return None;
    }
    let val: Value = parse_utf8_json_strip_bom(&raw_bytes)?;
    let revision = val.get("revision")?.as_str()?;
    let fetched_at = val.get("fetchedAt")?.as_str()?;
    if !valid_revision(revision) || chrono::DateTime::parse_from_rfc3339(fetched_at).is_err() {
        return None;
    }
    let catalog_val = val.get("catalog")?;
    let catalog = parse_catalog_value(catalog_val)?;
    Some(KnownCatalog {
        catalog,
        raw_document: catalog_val.clone(),
        fetched_at: fetched_at.to_owned(),
        revision: revision.to_owned(),
    })
}

fn persist_catalog(path: &Path, known: &KnownCatalog) {
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let payload = format!(
        "{}\n",
        json!({
            "version": 1,
            "revision": known.revision,
            "fetchedAt": known.fetched_at,
            "catalog": known.raw_document,
        })
    );
    let tmp = path.with_extension(format!("{}.{}.tmp", std::process::id(), uuid::Uuid::new_v4()));
    let write_res = {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(&tmp).and_then(|mut f| std::io::Write::write_all(&mut f, payload.as_bytes()))
    };
    if write_res.is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
    let _ = std::fs::remove_file(&tmp);
}

fn same_origin(url: &str, origin: &str) -> bool {
    Url::parse(url).ok().is_some_and(|u| u.origin().ascii_serialization() == origin)
}

fn next_page(link: Option<&str>, origin: &str) -> Option<String> {
    for part in link?.split(',') {
        let trimmed = part.trim();
        let Some(rest) = trimmed.strip_prefix('<') else { continue };
        let Some((url, params)) = rest.split_once('>') else { continue };
        let params = params.trim();
        if let Some(after_semi) = params.strip_prefix(';')
            && after_semi.trim() == "rel=\"next\""
            && same_origin(url, origin)
        {
            return Some(url.to_owned());
        }
    }
    None
}

fn rate_limit_retry_at(headers: &header::HeaderMap, status: u16, now: u64) -> Option<u64> {
    if status != 403 && status != 429 {
        return None;
    }
    if let Some(ra) = headers.get("retry-after").and_then(|v| v.to_str().ok())
        && let Ok(secs) = ra.trim().parse::<f64>()
        && secs.is_finite()
        && secs >= 0.0
    {
        return Some(now.saturating_add((secs * 1000.0) as u64));
    }
    if headers.get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()) == Some("0")
        && let Some(reset) = headers.get("x-ratelimit-reset").and_then(|v| v.to_str().ok())
        && let Ok(epoch_secs) = reset.trim().parse::<f64>()
        && epoch_secs.is_finite()
        && epoch_secs >= 0.0
    {
        return Some((epoch_secs * 1000.0) as u64);
    }
    (status == 429).then_some(now.saturating_add(INTEGRATION_CATALOG_CACHE_MS * 2))
}

fn select_catalog_release(list: &Value, api_origin: &str) -> Option<Release> {
    let items = list.as_array()?;
    let mut best: Option<(u64, Release)> = None;
    for item in items {
        let Some(obj) = item.as_object() else { continue };
        let Some(tag_name) = obj.get("tag_name").and_then(Value::as_str) else { continue };
        let Some(number) = valid_catalog_tag(tag_name) else { continue };
        if obj.get("draft").and_then(Value::as_bool) != Some(false)
            || obj.get("prerelease").and_then(Value::as_bool) != Some(false)
        {
            continue;
        }
        let Some(assets) = obj.get("assets").and_then(Value::as_array) else { continue };
        let Some(asset) =
            assets.iter().find(|a| a.get("name").and_then(Value::as_str) == Some(INTEGRATION_CATALOG_ASSET))
        else {
            continue;
        };
        let Some(asset_url) = asset.get("url").and_then(Value::as_str) else { continue };
        if !same_origin(asset_url, api_origin) {
            continue;
        }
        if let Some(size) = asset.get("size").and_then(Value::as_f64)
            && size.is_finite()
            && size > INTEGRATION_CATALOG_MAX_BYTES as f64
        {
            continue;
        }
        let Some(asset_id_f) = asset.get("id").and_then(Value::as_f64) else { continue };
        if !asset_id_f.is_finite()
            || asset_id_f.fract() != 0.0
            || !(0.0..=9_007_199_254_740_991.0).contains(&asset_id_f)
        {
            continue;
        }
        let asset_id = asset_id_f as u64;
        let Some(updated_at) = asset.get("updated_at").and_then(Value::as_str) else { continue };
        let revision = format!("{tag_name}#{asset_id}@{updated_at}");
        if !valid_revision(&revision) {
            continue;
        }
        if best.as_ref().is_none_or(|(n, _)| number > *n) {
            best = Some((number, Release { revision, asset_url: asset_url.to_owned() }));
        }
    }
    best.map(|(_, r)| r)
}

async fn read_bounded(mut resp: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, Option<u64>> {
    if resp.content_length().is_some_and(|len| len > max_bytes as u64) {
        return Err(None);
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| None)? {
        if buf.len().saturating_add(chunk.len()) > max_bytes {
            return Err(None);
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

async fn fetch_newest_release(
    client: &Client,
    releases_url: &str,
    cached_etag: Option<&str>,
    cached_release: Option<Release>,
) -> Result<(Option<Release>, Option<ListTag>), Option<u64>> {
    let origin = Url::parse(releases_url).map_err(|_| None)?.origin().ascii_serialization();
    let mut url = Some(releases_url.to_owned());
    let mut etag: Option<String> = None;
    let mut release: Option<Release> = None;
    let mut page = 0usize;

    while let Some(current_url) = url.take() {
        if page >= INTEGRATION_CATALOG_MAX_PAGES || release.is_some() {
            break;
        }
        let mut req = client
            .get(&current_url)
            .header(header::ACCEPT, "application/vnd.github+json")
            .header(header::USER_AGENT, "CodeNomad")
            .header("x-github-api-version", "2022-11-28");
        if page == 0
            && let Some(tag) = cached_etag
        {
            req = req.header(header::IF_NONE_MATCH, tag);
        }
        let resp = req.send().await.map_err(|_| None)?;
        let status = resp.status().as_u16();
        if status == 304
            && page == 0
            && let Some(tag) = cached_etag
        {
            let kept = ListTag { etag: tag.to_owned(), release: cached_release.clone() };
            return Ok((cached_release, Some(kept)));
        }
        if status != 200 {
            return Err(rate_limit_retry_at(resp.headers(), status, now_ms()));
        }
        if page == 0 {
            etag = resp.headers().get(header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_owned);
        }
        let next = next_page(resp.headers().get(header::LINK).and_then(|v| v.to_str().ok()), &origin);
        let bytes = read_bounded(resp, RELEASE_LIST_MAX_BYTES).await?;
        let json: Value = parse_utf8_json_strip_bom(&bytes).ok_or(None)?;
        release = select_catalog_release(&json, &origin);
        url = next;
        page += 1;
    }

    let list_tag =
        etag.filter(|_| release.is_none() || page == 1).map(|e| ListTag { etag: e, release: release.clone() });
    Ok((release, list_tag))
}

async fn download_catalog(client: &Client, asset_url: &str) -> Result<(IntegrationCatalog, Value), Option<u64>> {
    let resp = client
        .get(asset_url)
        .header(header::ACCEPT, "application/octet-stream")
        .header(header::USER_AGENT, "CodeNomad")
        .send()
        .await
        .map_err(|_| None)?;
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(rate_limit_retry_at(resp.headers(), status, now_ms()));
    }
    let bytes = read_bounded(resp, INTEGRATION_CATALOG_MAX_BYTES).await?;
    let val: Value = parse_utf8_json_strip_bom(&bytes).ok_or(None)?;
    let catalog = parse_catalog_value(&val).ok_or(None)?;
    Ok((catalog, val))
}
