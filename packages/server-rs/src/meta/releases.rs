//! Background offer for the Preview feed, separate from the desktop installer.
use std::{
    cmp::Ordering,
    sync::{LazyLock, Mutex},
    time::Duration,
};

use reqwest::{Client, Url};
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::{
    Shared,
    config::VERSION,
    settings::{Kind, Settings},
};

const REPO: &str = "NeuralNomadsAI/CodeNomad";
const INTERVAL: Duration = Duration::from_secs(15 * 60);

struct State {
    feed: &'static str,
    update: Option<Value>,
    latest_stable: Option<(String, String)>,
    latest_stable_generation: u64,
    /// True on initial startup in `stable` mode and on periodic poll ticks; switching
    /// `preview -> stable` never fires an extra stable-only request because any in-flight
    /// Preview fetch is detached (not aborted) and still populates `latest_stable`.
    stable_due: bool,
    generation: u64,
}

pub(crate) struct Monitor {
    state: Mutex<State>,
    changed: Notify,
}

impl Monitor {
    pub(crate) fn new(settings: &Settings) -> Self {
        let feed = read_feed(settings);
        Self {
            state: Mutex::new(State {
                feed,
                update: (feed == "stable").then_some(Value::Null),
                latest_stable: None,
                latest_stable_generation: 0,
                stable_due: feed == "stable",
                generation: 0,
            }),
            changed: Notify::new(),
        }
    }

    pub(crate) fn snapshot(&self) -> (&'static str, Option<Value>, Option<(String, String)>) {
        let state = self.state.lock().unwrap();
        (state.feed, state.update.clone(), state.latest_stable.clone())
    }

    pub(crate) fn update_feed(&self, settings: &Settings) {
        settings.with_server_owner_locked(|server| {
            self.set_feed(super::update_feed(server));
        });
    }

    pub(crate) fn set_feed(&self, feed: &'static str) {
        let mut state = self.state.lock().unwrap();
        if state.feed != feed {
            state.feed = feed;
            state.generation = state.generation.wrapping_add(1);
            state.stable_due = false;
            if feed == "stable" {
                state.update = Some(Value::Null);
            }
            self.changed.notify_one();
        }
    }
}

fn read_feed(settings: &Settings) -> &'static str {
    super::update_feed(&settings.owner(Kind::Config, "server"))
}

pub(crate) async fn run(app: Shared, shutdown: CancellationToken) {
    let url = crate::bench::releases_fixture().unwrap_or_else(|| Url::parse("https://api.github.com/").unwrap());
    let repo = std::env::var("CODENOMAD_GITHUB_REPO").unwrap_or_else(|_| REPO.into());
    run_with_base(app, shutdown, url, repo).await;
}

pub(crate) async fn run_with_base(app: Shared, shutdown: CancellationToken, url: Url, repo: String) {
    let monitor = &app.releases;
    let repo = repo.trim().to_owned();
    let parts: Vec<_> = repo.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty() || p.chars().any(char::is_whitespace)) {
        return;
    }
    let mut client = Client::builder().user_agent("CodeNomad-CLI").timeout(Duration::from_secs(15));
    if url.scheme() == "http" {
        client = client.no_proxy().redirect(reqwest::redirect::Policy::none());
    }
    let Ok(client) = client.build() else { return };
    loop {
        let (feed, generation, need_stable) = {
            let state = monitor.state.lock().unwrap();
            (state.feed, state.generation, state.stable_due)
        };
        if feed == "preview" {
            // Spawn so a mid-flight `preview -> stable` switch detaches rather than aborting:
            // `state.update` stays strictly fenced by `generation`/`feed`, while `latest_stable`
            // still populates from the already-started response without firing an extra request.
            let app_task = app.clone();
            let client_task = client.clone();
            let url_task = url.clone();
            let repo_task = repo.clone();
            let shutdown_task = shutdown.clone();
            let handle = tokio::spawn(async move {
                let result = tokio::select! {
                    biased;
                    _ = shutdown_task.cancelled() => return,
                    result = latest(&client_task, url_task, &repo_task, VERSION) => result,
                };
                if let Ok((update, stable)) = result {
                    let mut state = app_task.releases.state.lock().unwrap();
                    if state.generation == generation && state.feed == "preview" {
                        state.update = Some(update.unwrap_or(Value::Null));
                    }
                    if let Some(stable) = stable
                        && (state.latest_stable.is_none() || generation >= state.latest_stable_generation)
                    {
                        state.latest_stable = Some(stable);
                        state.latest_stable_generation = generation;
                        state.stable_due = false;
                    }
                }
            });
            let abort = handle.abort_handle();
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => {
                    abort.abort();
                    return;
                }
                _ = monitor.changed.notified() => continue,
                _ = handle => {}
            }
        } else if need_stable {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => return,
                _ = monitor.changed.notified() => continue,
                result = latest_stable_only(&client, url.clone(), &repo) => {
                    if let Ok(stable) = result {
                        let mut state = monitor.state.lock().unwrap();
                        if state.generation == generation && state.feed == "stable" {
                            if let Some(stable) = stable
                                && (state.latest_stable.is_none() || generation >= state.latest_stable_generation)
                            {
                                state.latest_stable = Some(stable);
                                state.latest_stable_generation = generation;
                            }
                            state.stable_due = false;
                        }
                    }
                }
            }
        }
        tokio::select! {
            _ = shutdown.cancelled() => return,
            _ = monitor.changed.notified() => (),
            _ = tokio::time::sleep(INTERVAL) => {
                let mut state = monitor.state.lock().unwrap();
                if state.feed == "stable" {
                    state.stable_due = true;
                }
            }
        }
    }
}

fn tag(value: &Value) -> &str {
    value["tag_name"].as_str().filter(|s| !s.is_empty()).or(value["name"].as_str()).unwrap_or_default()
}
fn version(tag: &str) -> &str {
    let tag = crate::shared::js_trim(tag);
    tag.strip_prefix(['v', 'V']).unwrap_or(tag)
}
fn timestamp(release: &Value) -> i64 {
    release["published_at"]
        .as_str()
        .or(release["created_at"].as_str())
        .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
        .map_or(0, |value| value.timestamp_millis())
}
fn listed(release: &Value) -> bool {
    release["draft"] != true && !version(tag(release)).is_empty()
}

fn compare_versions(a: &str, b: &str) -> Ordering {
    fn parse(input: &str) -> ([i64; 3], Option<&str>) {
        let version = version(input);
        let (core, suffix) = version.split_once('-').map_or((version, None), |(core, suffix)| (core, Some(suffix)));
        let mut parts = core.split('.');
        let numbers = std::array::from_fn(|_| {
            let part = parts.next().unwrap_or_default().trim_start();
            let start = usize::from(part.starts_with(['+', '-']));
            let count = part.as_bytes()[start..].iter().take_while(|c| c.is_ascii_digit()).count();
            part[..start + count].parse().unwrap_or(0)
        });
        (numbers, suffix.filter(|s| !s.is_empty()))
    }
    let (a, a_suffix) = parse(a);
    let (b, b_suffix) = parse(b);
    a.cmp(&b).then_with(|| match (a_suffix, b_suffix) {
        (Some(a), Some(b)) => collation().compare(a, b),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (None, None) => Ordering::Equal,
    })
}

fn collation() -> &'static icu_collator::CollatorBorrowed<'static> {
    static COLLATOR: LazyLock<icu_collator::CollatorBorrowed<'static>> = LazyLock::new(|| {
        let locale = sys_locale::get_locale().and_then(|locale| locale.parse::<icu_locale_core::Locale>().ok());
        icu_collator::Collator::try_new(locale.map(Into::into).unwrap_or_default(), Default::default()).unwrap_or_else(
            |_| {
                icu_collator::Collator::try_new(Default::default(), Default::default())
                    .expect("the compiled root collation is available")
            },
        )
    });
    &COLLATOR
}

async fn get(client: &Client, url: Url, bytes: usize) -> Result<Value, ()> {
    let response = client
        .get(url)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| ())?;
    crate::opencode::read_json(response, bytes).await
}

fn release_url(repo: &str, release: &Value, release_tag: &str) -> String {
    if let Some(url) = release.get("html_url").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return url.to_owned();
    }
    let mut url = Url::parse("https://github.com/").unwrap();
    url.path_segments_mut().unwrap().clear().extend(repo.split('/')).extend(["releases", "tag", release_tag]);
    url.to_string()
}

fn stable_release(release: &Value, repo: &str) -> Option<(String, String)> {
    if !listed(release) || release["prerelease"] == true {
        return None;
    }
    let release_tag = tag(release);
    let ver = version(release_tag);
    if ver.is_empty() {
        return None;
    }
    Some((ver.to_owned(), release_url(repo, release, release_tag)))
}

fn stable_from_list(list: &[Value], repo: &str) -> Option<(String, String)> {
    let best = list.iter().filter(|r| listed(r) && r["prerelease"] != true).reduce(|best, r| {
        let ordering =
            timestamp(r).cmp(&timestamp(best)).then_with(|| compare_versions(version(tag(r)), version(tag(best))));
        if ordering.is_gt() { r } else { best }
    })?;
    stable_release(best, repo)
}

async fn latest_stable_endpoint(client: &Client, mut base: Url, repo: &str) -> Result<Option<(String, String)>, ()> {
    base.path_segments_mut()
        .map_err(|_| ())?
        .clear()
        .push("repos")
        .extend(repo.split('/'))
        .extend(["releases", "latest"]);
    let response = client.get(base).header("accept", "application/vnd.github+json").send().await.map_err(|_| ())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let response = response.error_for_status().map_err(|_| ())?;
    let release = crate::opencode::read_json(response, 2 << 20).await?;
    Ok(stable_release(&release, repo))
}

async fn latest_stable_only(client: &Client, base: Url, repo: &str) -> Result<Option<(String, String)>, ()> {
    if let Ok(Some(stable)) = latest_stable_endpoint(client, base.clone(), repo).await {
        return Ok(Some(stable));
    }
    let mut list_url = base;
    list_url.path_segments_mut().map_err(|_| ())?.clear().push("repos").extend(repo.split('/')).push("releases");
    list_url.query_pairs_mut().append_pair("per_page", "30");
    let page = get(client, list_url, 16 << 20).await?;
    let list = page.as_array().map(Vec::as_slice).unwrap_or_default();
    Ok(stable_from_list(list, repo))
}

async fn latest(
    client: &Client,
    mut base: Url,
    repo: &str,
    installed: &str,
) -> Result<(Option<Value>, Option<(String, String)>), ()> {
    let origin = base.clone();
    base.path_segments_mut().map_err(|_| ())?.clear().push("repos").extend(repo.split('/')).push("releases");
    let mut list_url = base.clone();
    list_url.query_pairs_mut().append_pair("per_page", "30");
    let page = get(client, list_url, 16 << 20).await?;
    let list = page.as_array().map(Vec::as_slice).unwrap_or_default();
    let mut stable = stable_from_list(list, repo);
    if stable.is_none() && crate::bench::releases_fixture().is_none() {
        stable = latest_stable_endpoint(client, origin, repo).await.ok().flatten();
    }
    let Some(latest) = list
        .iter()
        .filter(|r| {
            listed(r)
                && r["assets"]
                    .as_array()
                    .is_some_and(|assets| assets.iter().any(|asset| asset["name"] == "latest.json"))
        })
        .reduce(|best, r| if timestamp(r) > timestamp(best) { r } else { best })
    else {
        return Ok((None, stable));
    };
    let current = version(installed);
    let newest_tag = tag(latest);
    let newest = version(newest_tag);
    if current.is_empty() || newest == current {
        return Ok((None, stable));
    }
    let known = if let Some(known) = list.iter().find(|r| listed(r) && version(tag(r)) == current) {
        Some(timestamp(known))
    } else {
        base.path_segments_mut().map_err(|_| ())?.extend(["tags", &format!("v{current}")]);
        get(client, base, 2 << 20)
            .await
            .ok()
            .filter(|r| listed(r) && version(tag(r)) == current && timestamp(r) != 0)
            .map(|r| timestamp(&r))
    };
    if !known.map_or_else(|| compare_versions(newest, installed).is_gt(), |known| timestamp(latest) > known) {
        return Ok((None, stable));
    }
    let mut offer = json!({"version": newest, "tag": newest_tag,
        "url": latest.get("html_url").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!(release_url(repo, latest, newest_tag))),
        "channel": if latest["prerelease"] == true { "preview" } else { "stable" }});
    if let Some(date) = latest.get("published_at").filter(|v| !v.is_null()).or_else(|| latest.get("created_at")) {
        offer["publishedAt"] = date.clone();
    }
    if let Some(notes) = latest.get("body") {
        offer["notes"] = notes.clone();
    }
    Ok((Some(offer), stable))
}

#[cfg(test)]
mod tests {
    #[test]
    fn fallback_version_order_matches_collated_prereleases() {
        use super::compare_versions;
        assert!(compare_versions("v1.2.3-dev-éclair", "1.2.3-dev-z").is_lt());
        assert!(compare_versions("1.2.3-dev-1-next", "1.2.3-dev-1+local").is_lt());
        assert!(compare_versions("1.2.3-dev-10", "1.2.3-dev-2").is_lt());
        assert!(compare_versions("1.2.3", "1.2.3-dev-local").is_gt());
        assert!(compare_versions("1.2.4-dev-local", "1.2.3").is_gt());
    }
}
