//! Release selection for the two update feeds. It follows the server's
//! notification rules (`packages/server/src/releases/dev-release-monitor.ts`):
//! stable offers GitHub's latest final release when newer; preview offers the
//! newest publication of any kind. Only releases carrying their signed
//! `latest.json` are installable.
use reqwest::{header::ACCEPT, StatusCode};
use serde::{de::DeserializeOwned, Deserialize};
use std::time::Duration;
use url::Url;

pub(crate) const REPOSITORY: &str = "NeuralNomadsAI/CodeNomad";
const MANIFEST: &str = "latest.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpdateFeed {
    Stable,
    Preview,
}

impl UpdateFeed {
    /// The saved feed wins; otherwise the installed build label decides.
    pub(crate) fn resolve(saved: Option<Self>, current_version: &str) -> Self {
        let label = current_version.to_ascii_lowercase();
        saved.unwrap_or(if label.contains("-dev-") || label.contains("-dev.") {
            Self::Preview
        } else {
            Self::Stable
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct GithubRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Clone, Debug, Deserialize)]
struct GithubAsset {
    name: String,
}

impl GithubRelease {
    fn version(&self) -> Option<&str> {
        let version = self.tag_name.strip_prefix('v').unwrap_or(&self.tag_name);
        version.starts_with(|c: char| c.is_ascii_digit()).then_some(version)
    }

    /// GitHub reports UTC `YYYY-MM-DDTHH:MM:SSZ`, which orders lexically.
    fn published(&self) -> Option<&str> {
        self.published_at.as_deref().filter(|value| value.len() == 20 && value.ends_with('Z'))
    }

    fn is_listed(&self) -> bool {
        !self.draft && self.version().is_some() && self.published().is_some()
    }

    fn is_installed(&self, current_version: &str) -> bool {
        self.is_listed() && self.version() == Some(current_version)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub tag: String,
    pub version: String,
    /// Preview releases are ordered by publication: a newer preview may carry a
    /// lower SemVer label than its base release. Otherwise the version must rise.
    pub by_publication: bool,
}

impl Candidate {
    pub(crate) fn manifest_url(&self) -> Url {
        let mut url = Url::parse("https://github.com").expect("static URL");
        url.path_segments_mut()
            .expect("base URL")
            .extend(REPOSITORY.split('/'))
            .extend(["releases", "download", &self.tag, MANIFEST]);
        url
    }
}

fn newest(releases: &[GithubRelease], feed: UpdateFeed) -> Option<&GithubRelease> {
    releases
        .iter()
        .filter(|release| {
            release.is_listed()
                && (feed == UpdateFeed::Preview || !release.prerelease)
                && release.assets.iter().any(|asset| asset.name == MANIFEST)
        })
        .max_by(|a, b| a.published().cmp(&b.published()))
}

fn decide(
    newest: Option<&GithubRelease>,
    installed: Option<&GithubRelease>,
    current_version: &str,
    feed: UpdateFeed,
) -> Option<Candidate> {
    let newest = newest?;
    let version = newest.version()?;
    if version == current_version {
        return None;
    }
    let candidate = |by_publication| Candidate {
        tag: newest.tag_name.clone(),
        version: version.to_string(),
        by_publication,
    };
    match (feed, installed) {
        (UpdateFeed::Preview, Some(installed)) => {
            (newest.published() > installed.published()).then(|| candidate(true))
        }
        // Builds GitHub does not know fall back to version order, as on the server.
        _ => Some(candidate(false)),
    }
}

fn api_url(segments: &[&str]) -> Url {
    let mut url = Url::parse("https://api.github.com").expect("static URL");
    url.path_segments_mut()
        .expect("base URL")
        .push("repos")
        .extend(REPOSITORY.split('/'))
        .extend(segments);
    url
}

async fn get<T: DeserializeOwned>(client: &reqwest::Client, url: Url) -> Result<Option<T>, String> {
    let response = client
        .get(url)
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let response = response.error_for_status().map_err(|error| error.to_string())?;
    response.json().await.map(Some).map_err(|error| error.to_string())
}

pub(crate) async fn find_candidate(
    feed: UpdateFeed,
    current_version: &str,
) -> Result<Option<Candidate>, String> {
    let client = reqwest::Client::builder()
        .user_agent("CodeNomad-Desktop")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let releases: Vec<GithubRelease> = match feed {
        // Prereleases can push the stable release beyond any listed page.
        UpdateFeed::Stable => get(&client, api_url(&["releases", "latest"])).await?.into_iter().collect(),
        // The newest publication of any kind leads the newest-first list.
        UpdateFeed::Preview => {
            let mut list = api_url(&["releases"]);
            list.set_query(Some("per_page=30"));
            get(&client, list).await?.unwrap_or_default()
        }
    };
    let newest = newest(&releases, feed);
    let listed = releases.iter().find(|release| release.is_installed(current_version));
    // The installed release may be older than the fetched page.
    let lookup = if listed.is_none() && newest.is_some() && feed == UpdateFeed::Preview {
        let tag = format!("v{current_version}");
        get::<GithubRelease>(&client, api_url(&["releases", "tags", &tag])).await.ok().flatten()
    } else {
        None
    };
    let installed = listed.or(lookup.as_ref().filter(|release| release.is_installed(current_version)));
    Ok(decide(newest, installed, current_version, feed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, published: &str, prerelease: bool, manifest: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag.into(),
            draft: false,
            prerelease,
            published_at: Some(published.into()),
            assets: manifest.then(|| GithubAsset { name: MANIFEST.into() }).into_iter().collect(),
        }
    }

    fn select(releases: &[GithubRelease], current: &str, feed: UpdateFeed) -> Option<Candidate> {
        let installed = releases.iter().find(|release| release.is_installed(current));
        decide(newest(releases, feed), installed, current, feed)
    }

    #[test]
    fn feed_defaults_follow_the_installed_build_label() {
        assert_eq!(UpdateFeed::resolve(None, "0.20.1"), UpdateFeed::Stable);
        assert_eq!(UpdateFeed::resolve(None, "0.20.1-dev-20261013-031eb843"), UpdateFeed::Preview);
        assert_eq!(UpdateFeed::resolve(None, "0.20.0-DEV.1"), UpdateFeed::Preview);
        assert_eq!(UpdateFeed::resolve(Some(UpdateFeed::Stable), "0.20.1-dev-20261013-031eb843"), UpdateFeed::Stable);
        assert_eq!(UpdateFeed::resolve(Some(UpdateFeed::Preview), "0.20.1"), UpdateFeed::Preview);
    }

    #[test]
    fn stable_offers_only_final_releases_with_a_manifest() {
        let releases = [
            release("v0.21.1-dev-20261020-aaaaaaaa", "2026-10-20T01:00:00Z", true, true),
            release("v0.21.1", "2026-10-19T01:00:00Z", false, false),
            release("v0.21.0", "2026-10-18T01:00:00Z", false, true),
        ];
        let candidate = select(&releases, "0.20.1", UpdateFeed::Stable).unwrap();
        assert_eq!((candidate.tag.as_str(), candidate.by_publication), ("v0.21.0", false));
        assert_eq!(select(&releases, "0.21.0", UpdateFeed::Stable), None);
    }

    #[test]
    fn preview_offers_the_newest_publication_of_any_kind() {
        let releases = [
            release("v0.20.1-dev-20261013-ffffffff", "2026-10-13T09:00:00Z", true, true),
            release("v0.20.1-dev-20261013-00000000", "2026-10-13T08:00:00Z", true, true),
            release("v0.20.1", "2026-10-03T01:00:00Z", false, true),
        ];
        // Same-day previews order by publication, not by their hash label.
        let candidate = select(&releases, "0.20.1-dev-20261013-00000000", UpdateFeed::Preview).unwrap();
        assert_eq!(candidate.version, "0.20.1-dev-20261013-ffffffff");
        assert!(candidate.by_publication);
        // A stable user who chose preview moves to the newer preview.
        assert!(select(&releases, "0.20.1", UpdateFeed::Preview).unwrap().by_publication);
        assert_eq!(select(&releases, "0.20.1-dev-20261013-ffffffff", UpdateFeed::Preview), None);
    }

    #[test]
    fn preview_offers_a_later_stable_release_but_never_an_older_publication() {
        let releases = [
            release("v0.21.0", "2026-10-20T01:00:00Z", false, true),
            release("v0.21.0-dev-20261019-aaaaaaaa", "2026-10-19T01:00:00Z", true, true),
        ];
        assert_eq!(select(&releases, "0.21.0-dev-20261019-aaaaaaaa", UpdateFeed::Preview).unwrap().tag, "v0.21.0");
        // The installed build was published after the newest installable release.
        let newer_installed = [release("v0.21.1-dev-20261021-bbbbbbbb", "2026-10-21T01:00:00Z", true, false), releases[0].clone()];
        assert_eq!(select(&newer_installed, "0.21.1-dev-20261021-bbbbbbbb", UpdateFeed::Preview), None);
    }

    #[test]
    fn unknown_installed_builds_fall_back_to_version_order() {
        let releases = [release("v0.20.1-dev-20261013-aaaaaaaa", "2026-10-13T01:00:00Z", true, true)];
        let candidate = select(&releases, "0.20.0-dev-local", UpdateFeed::Preview).unwrap();
        assert!(!candidate.by_publication);
    }

    #[test]
    fn drafts_and_unusable_tags_are_ignored() {
        let mut draft = release("v0.22.0", "2026-10-22T01:00:00Z", false, true);
        draft.draft = true;
        let releases = [
            draft,
            release("nightly", "2026-10-21T01:00:00Z", false, true),
            release("v0.21.0", "not-a-date", false, true),
        ];
        assert_eq!(select(&releases, "0.20.1", UpdateFeed::Stable), None);
        assert_eq!(select(&releases, "0.20.1", UpdateFeed::Preview), None);
    }

    #[test]
    fn urls_stay_on_the_repository_and_encode_the_tag() {
        let candidate = Candidate { tag: "v0.20.1-dev-20261013-031eb843".into(), version: String::new(), by_publication: true };
        assert_eq!(
            candidate.manifest_url().as_str(),
            "https://github.com/NeuralNomadsAI/CodeNomad/releases/download/v0.20.1-dev-20261013-031eb843/latest.json",
        );
        assert_eq!(
            api_url(&["releases", "latest"]).as_str(),
            "https://api.github.com/repos/NeuralNomadsAI/CodeNomad/releases/latest",
        );
        assert_eq!(
            api_url(&["releases", "tags", "v1.0.0+a/b"]).as_str(),
            "https://api.github.com/repos/NeuralNomadsAI/CodeNomad/releases/tags/v1.0.0+a%2Fb",
        );
    }
}
