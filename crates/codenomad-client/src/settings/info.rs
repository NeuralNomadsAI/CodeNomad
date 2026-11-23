use crate::{
    backend::{Backend, read_json_limited},
    history::Result,
};
use reqwest::Url;
use serde_json::Value;
use std::time::Duration;

pub const BUG_FIELDS: [&str; 4] = [
    "codenomad-version",
    "opencode-version",
    "os-version",
    "extra",
];
const BUG_TEMPLATE: &str = "bug_report.yml";
const BUG_PAGE: &str = "https://github.com/NeuralNomadsAI/CodeNomad/issues/new";
const BUG_SOURCE: &str = "https://raw.githubusercontent.com/NeuralNomadsAI/CodeNomad/dev/.github/ISSUE_TEMPLATE/bug_report.yml";

pub async fn metadata(backend: &Backend) -> Result<Value> {
    let request = backend.client.get(format!("{}api/meta", backend.base));
    #[cfg(target_arch = "wasm32")]
    let request = request.fetch_cache_no_store();
    let response = request.send().await?.error_for_status()?;
    // Release offers may include GitHub release notes alongside the metadata.
    let meta = read_json_limited(response, 256 * 1024).await?;
    if !meta.is_object()
        || backend
            .client
            .server_identity()
            .is_some_and(|id| meta["serverId"] != id)
    {
        return Err("Host information belongs to another server".into());
    }
    Ok(meta)
}

/// The updater publishes a GitHub release page, not an executable to run.
pub fn release_link(text: &str) -> Option<String> {
    let url = public_https(text)?;
    let mut parts = url.path_segments()?;
    if url.host_str() != Some("github.com")
        || !parts.next().is_some_and(|owner| !owner.is_empty())
        || !parts.next().is_some_and(|repo| !repo.is_empty())
        || parts.next() != Some("releases")
        || parts.next() != Some("tag")
        || !parts.next().is_some_and(|tag| !tag.is_empty())
        || parts.next().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url.into())
}

pub fn listener_origin(text: &str) -> Option<String> {
    let url = Url::parse(text).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.origin().ascii_serialization())
}

fn public_https(text: &str) -> Option<Url> {
    let url = Url::parse(text).ok()?;
    (url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

pub fn utc_stamp() -> Option<String> {
    let seconds = web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let time = time::OffsetDateTime::from_unix_timestamp(i64::try_from(seconds).ok()?).ok()?;
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        time.year(),
        u8::from(time.month()),
        time.day(),
        time.hour(),
        time.minute(),
        time.second()
    ))
}

pub async fn published_bug_form() -> Option<bool> {
    use futures_lite::StreamExt;
    static KNOWN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if let Some(known) = KNOWN.get() {
        return Some(*known);
    }
    let response = crate::http::Http::new()
        .ok()?
        .get(BUG_SOURCE)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .ok()?;
    let compatible = if response.status() == reqwest::StatusCode::NOT_FOUND {
        false
    } else {
        let mut stream = response.error_for_status().ok()?.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.ok()?;
            if chunk.len() > 64_000_usize.saturating_sub(bytes.len()) {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        inspect_form(std::str::from_utf8(&bytes).ok()?)?
    };
    Some(*KNOWN.get_or_init(|| compatible))
}

fn inspect_form(text: &str) -> Option<bool> {
    // Recognize the published block-format fields. Other YAML layouts stay unknown.
    let body = text.lines().skip_while(|line| *line != "body:").nth(1)?;
    if !body.starts_with("  - type: ") {
        return None;
    }
    let mut kind = "";
    let mut found = [false; 4];
    for line in text.lines().skip_while(|line| *line != "body:").skip(1) {
        if let Some(value) = line.strip_prefix("  - type: ") {
            kind = value.trim();
        } else if let Some(id) = line.strip_prefix("    id: ") {
            if let Some(index) = BUG_FIELDS
                .iter()
                .position(|expected| id.trim() == *expected)
            {
                found[index] = matches!(kind, "input" | "textarea");
            }
        } else if !line.is_empty() && !line.starts_with(' ') {
            break;
        }
    }
    Some(found.into_iter().all(|field| field))
}

pub fn bug_report_link(environment: [&str; 4], compatible: Option<bool>) -> String {
    let mut url = Url::parse(BUG_PAGE).expect("fixed GitHub URL");
    let mut query = url.query_pairs_mut();
    if compatible == Some(false) {
        let [codenomad, opencode, os, context] = environment;
        let body = format!(
            "### Issue Summary\n\n\n### Steps to Reproduce\n\n1. \n\n### Expected Behavior\n\n\n### Environment\n\n- CodeNomad Version: {codenomad}\n- OpenCode Version: {opencode}\n- Operating System: {os}\n{context}\n"
        );
        query
            .append_pair("title", "[Bug]: ")
            .append_pair("body", &body);
    } else {
        query.append_pair("template", BUG_TEMPLATE);
        for (field, value) in BUG_FIELDS.into_iter().zip(environment) {
            if !value.is_empty() {
                query.append_pair(field, value);
            }
        }
    }
    drop(query);
    url.into()
}

#[cfg(test)]
#[test]
fn release_and_bug_form_follow_the_server_and_published_contracts() {
    let good = "https://github.com/NeuralNomadsAI/CodeNomad/releases/tag/v1.2.0";
    assert_eq!(release_link(good).as_deref(), Some(good));
    assert!(release_link("https://evil.test/CodeNomad/releases/tag/v1.2.0").is_none());
    assert!(release_link("https://me@github.com/a/b/releases/tag/v1").is_none());
    let form = include_str!("../../../../.github/ISSUE_TEMPLATE/bug_report.yml");
    assert_eq!(inspect_form(form), Some(true));
    assert_eq!(
        inspect_form(&form.replace("id: extra", "id: extra-removed")),
        Some(false)
    );
    let bug = bug_report_link(["1.2", "2.3", "Windows", "Rune"], None);
    assert!(bug.contains("template=bug_report.yml&codenomad-version=1.2"));
    assert!(bug_report_link(["1.2", "2.3", "Windows", "Rune"], Some(false)).contains("&body="));
}
