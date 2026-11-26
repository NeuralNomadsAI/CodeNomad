//! Reviewed OpenCode integration catalog (`opencode/integrations/catalog.ts`,
//! `contract.ts`, `recognition.ts`) consumed by `POST /api/workspaces/:id/plugin-sources`
//! for `global-only` and cross-spec/runtime `duplicate` enforcement.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::{Client, Url, header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationCatalog {
    pub(crate) schema_version: u64,
    pub(crate) integrations: Vec<IntegrationCatalogEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationCatalogEntry {
    pub(crate) id: String,
    pub(crate) family: String,
    pub(crate) package: String,
    pub(crate) plugin: String,
    pub(crate) rpc: String,
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
}

pub(crate) struct CatalogSource {
    state_file: Option<PathBuf>,
    state: Arc<Mutex<CatalogState>>,
    refresh_gate: Arc<Mutex<()>>,
}

impl CatalogSource {
    pub(crate) fn new(state_file: Option<PathBuf>) -> Self {
        let releases_url = if cfg!(test) { None } else { Some(INTEGRATION_CATALOG_RELEASES_URL.to_owned()) };
        Self {
            state_file,
            state: Arc::new(Mutex::new(CatalogState { releases_url, ..Default::default() })),
            refresh_gate: Arc::new(Mutex::new(())),
        }
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
        let mut st = self.state.lock().await;
        st.loaded = true;
        st.known = Some(KnownCatalog {
            catalog,
            fetched_at: chrono::Utc::now().to_rfc3339(),
            revision: "catalog-v1#1@2026-01-01T00:00:00Z".to_owned(),
        });
        st.attempt = Some(Attempt { at_ms: now_ms(), until_ms: None });
    }

    pub(crate) async fn read(&self) -> IntegrationCatalog {
        self.ensure_loaded().await;
        let now = now_ms();
        let needs_refresh = {
            let st = self.state.lock().await;
            if st.releases_url.is_none() {
                false
            } else {
                match &st.attempt {
                    Some(a) => now >= a.at_ms.saturating_add(INTEGRATION_CATALOG_CACHE_MS).max(a.until_ms.unwrap_or(0)),
                    None => true,
                }
            }
        };
        if needs_refresh {
            let _gate = self.refresh_gate.lock().await;
            let now = now_ms();
            let (url, known_rev, list_etag, list_release) = {
                let st = self.state.lock().await;
                let fresh = st.attempt.as_ref().is_some_and(|a| {
                    now < a.at_ms.saturating_add(INTEGRATION_CATALOG_CACHE_MS).max(a.until_ms.unwrap_or(0))
                });
                if fresh {
                    return st.known.as_ref().map(|k| k.catalog.clone()).unwrap_or_default();
                }
                (
                    st.releases_url.clone(),
                    st.known.as_ref().map(|k| k.revision.clone()),
                    st.list_tag.as_ref().map(|t| t.etag.clone()),
                    st.list_tag.as_ref().and_then(|t| t.release.clone()),
                )
            };
            if let Some(url) = url {
                self.refresh(&url, known_rev.as_deref(), list_etag.as_deref(), list_release).await;
            }
        }
        let st = self.state.lock().await;
        st.known.as_ref().map(|k| k.catalog.clone()).unwrap_or_default()
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

    async fn refresh(
        &self,
        releases_url: &str,
        known_revision: Option<&str>,
        cached_etag: Option<&str>,
        cached_release: Option<Release>,
    ) {
        let client = match Client::builder().timeout(Duration::from_millis(INTEGRATION_CATALOG_TIMEOUT_MS)).build() {
            Ok(c) => c,
            Err(_) => {
                let mut st = self.state.lock().await;
                st.attempt = Some(Attempt { at_ms: now_ms(), until_ms: None });
                return;
            }
        };
        let result = fetch_newest_release(&client, releases_url, cached_etag, cached_release).await;
        match result {
            Ok((release_opt, new_tag)) => {
                let Some(release) = release_opt else {
                    let mut st = self.state.lock().await;
                    st.list_tag = new_tag;
                    st.attempt = Some(Attempt { at_ms: now_ms(), until_ms: None });
                    return;
                };
                if known_revision == Some(release.revision.as_str()) {
                    let mut st = self.state.lock().await;
                    st.list_tag = new_tag;
                    st.attempt = Some(Attempt { at_ms: now_ms(), until_ms: None });
                    return;
                }
                match download_catalog(&client, &release.asset_url).await {
                    Ok(catalog) => {
                        let known = KnownCatalog {
                            catalog,
                            fetched_at: chrono::Utc::now().to_rfc3339(),
                            revision: release.revision,
                        };
                        if let Some(path) = self.state_file.clone() {
                            let persist_known = known.clone();
                            let _ = tokio::task::spawn_blocking(move || persist_catalog(&path, &persist_known)).await;
                        }
                        let mut st = self.state.lock().await;
                        st.list_tag = new_tag;
                        st.known = Some(known);
                        st.attempt = Some(Attempt { at_ms: now_ms(), until_ms: None });
                    }
                    Err(retry_at) => {
                        let now = now_ms();
                        let mut st = self.state.lock().await;
                        st.list_tag = new_tag;
                        st.attempt = Some(Attempt {
                            at_ms: now,
                            until_ms: retry_at.map(|r| r.min(now.saturating_add(RATE_LIMIT_MAX_WAIT_MS))),
                        });
                    }
                }
            }
            Err(retry_at) => {
                let now = now_ms();
                let mut st = self.state.lock().await;
                st.attempt = Some(Attempt {
                    at_ms: now,
                    until_ms: retry_at.map(|r| r.min(now.saturating_add(RATE_LIMIT_MAX_WAIT_MS))),
                });
            }
        }
    }
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

fn valid_integration_id(s: &str) -> bool {
    let bytes = s.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn valid_neuralnomads_id(s: &str) -> bool {
    s.strip_prefix("neuralnomads.").is_some_and(valid_integration_id)
}

/// Validates a catalog JSON value matching `integrationCatalogSchema` (`opencode/integrations/contract.ts`).
pub(crate) fn parse_catalog_value(value: &Value) -> Option<IntegrationCatalog> {
    let obj = value.as_object()?;
    if obj.len() != 2 || obj.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let list = obj.get("integrations")?.as_array()?;
    if list.len() > INTEGRATION_CATALOG_MAX_ENTRIES {
        return None;
    }
    let mut ids = HashSet::new();
    let mut packages = HashSet::new();
    let mut plugins = HashSet::new();
    let mut rpcs = HashSet::new();
    let mut out = Vec::with_capacity(list.len());

    for item in list {
        let entry = item.as_object()?;
        let id = entry.get("id")?.as_str()?;
        let family = entry.get("family")?.as_str()?;
        let package = entry.get("package")?.as_str()?;
        let plugin = entry.get("plugin")?.as_str()?;
        let rpc = entry.get("rpc")?.as_str()?;
        if !valid_integration_id(id)
            || !matches!(family, "native" | "vendor-mcp" | "api")
            || !valid_neuralnomads_id(plugin)
            || !valid_neuralnomads_id(rpc)
            || package.is_empty()
            || package.len() > 214
            || package != package.to_ascii_lowercase()
        {
            return None;
        }
        let has_host = entry.contains_key("host");
        let has_vendor = entry.contains_key("vendor");
        if (family == "native") != has_host || (family != "vendor-mcp" && has_vendor) {
            return None;
        }
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
            plugin: plugin.to_owned(),
            rpc: rpc.to_owned(),
            sources,
        });
    }
    Some(IntegrationCatalog { schema_version: 1, integrations: out })
}

fn load_persisted(path: &Path) -> Option<KnownCatalog> {
    let raw_bytes = std::fs::read(path).ok()?;
    if raw_bytes.len() > INTEGRATION_CATALOG_MAX_BYTES * 2 {
        return None;
    }
    let val: Value = serde_json::from_slice(&raw_bytes).ok()?;
    let revision = val.get("revision")?.as_str()?;
    let fetched_at = val.get("fetchedAt")?.as_str()?;
    if !valid_revision(revision) || chrono::DateTime::parse_from_rfc3339(fetched_at).is_err() {
        return None;
    }
    let catalog_val = val.get("catalog")?;
    let catalog_bytes = serde_json::to_vec(catalog_val).ok()?;
    if catalog_bytes.len() > INTEGRATION_CATALOG_MAX_BYTES {
        return None;
    }
    let catalog = parse_catalog_value(catalog_val)?;
    Some(KnownCatalog { catalog, fetched_at: fetched_at.to_owned(), revision: revision.to_owned() })
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
            "catalog": known.catalog,
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
        if let Some(size) = asset.get("size").and_then(Value::as_u64)
            && size as usize > INTEGRATION_CATALOG_MAX_BYTES
        {
            continue;
        }
        let Some(asset_id) = asset.get("id").and_then(Value::as_u64) else { continue };
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
        let json: Value = serde_json::from_slice(&bytes).map_err(|_| None)?;
        release = select_catalog_release(&json, &origin);
        url = next;
        page += 1;
    }

    let list_tag =
        etag.filter(|_| release.is_none() || page == 1).map(|e| ListTag { etag: e, release: release.clone() });
    Ok((release, list_tag))
}

async fn download_catalog(client: &Client, asset_url: &str) -> Result<IntegrationCatalog, Option<u64>> {
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
    let val: Value = serde_json::from_slice(&bytes).map_err(|_| None)?;
    parse_catalog_value(&val).ok_or(None)
}
