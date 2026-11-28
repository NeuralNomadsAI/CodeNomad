//! Release feed selection, strict `latest.json` parsing, HTTPS URL policy, and SemVer
//! downgrade refusal aligned with `dev-docs/TAURI_UPDATER.md`.

use semver::Version;
use serde_json::Value;
use url::{Host, Url};

use super::{UpdateCheckOutcome, UpdateError, UpdateInfo, minisign::normalize_sha256_hex};

/// Release channel selected by the user or inferred from the installed build label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateFeed {
    Stable,
    Preview,
}

impl UpdateFeed {
    /// Saved feed wins; otherwise `-dev-` / `-dev.` labels default to `Preview`.
    pub fn resolve(saved: Option<Self>, current_version: &str) -> Self {
        let lower = current_version.to_ascii_lowercase();
        saved.unwrap_or(if lower.contains("-dev-") || lower.contains("-dev.") {
            Self::Preview
        } else {
            Self::Stable
        })
    }
}

/// Optional UTC publication timestamps (`YYYY-MM-DDTHH:MM:SSZ`) used when ordering a
/// preview feed by publication time instead of strict SemVer order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewOrdering {
    pub installed_published_at: String,
    pub candidate_published_at: String,
}

/// Minimal GitHub release metadata used to pick the newest signed release on a feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubRelease {
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
    pub published_at: Option<String>,
    pub asset_names: Vec<String>,
}

impl GithubRelease {
    fn version(&self) -> Option<&str> {
        let version = self.tag_name.strip_prefix('v').unwrap_or(&self.tag_name);
        version
            .starts_with(|c: char| c.is_ascii_digit())
            .then_some(version)
    }

    fn published(&self) -> Option<&str> {
        self.published_at
            .as_deref()
            .filter(|value| is_valid_utc_timestamp(value))
    }

    fn is_listed(&self) -> bool {
        !self.draft && self.version().is_some() && self.published().is_some()
    }
}

/// Candidate release selected from GitHub release metadata.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseCandidate {
    pub tag: String,
    pub version: String,
    pub preview_ordering: Option<PreviewOrdering>,
}

impl ReleaseCandidate {
    /// Builds the official HTTPS `latest.json` release asset URL for `repository` (`owner/name`).
    pub fn manifest_url(&self, repository: &str) -> Result<Url, UpdateError> {
        let mut parts = repository.split('/');
        let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
            return Err(UpdateError::InvalidUrl {
                url: repository.to_string(),
                reason: "repository must have owner/name format".into(),
            });
        };
        if owner.is_empty() || repo.is_empty() {
            return Err(UpdateError::InvalidUrl {
                url: repository.to_string(),
                reason: "repository owner and name must be non-empty".into(),
            });
        }
        let mut url = Url::parse("https://github.com").expect("static https base URL");
        url.path_segments_mut()
            .expect("https base URL supports path segments")
            .extend([
                owner,
                repo,
                "releases",
                "download",
                &self.tag,
                "latest.json",
            ]);
        Ok(url)
    }
}

/// Selects the newest signed release candidate matching `dev-docs/TAURI_UPDATER.md`.
pub fn select_release_candidate(
    releases: &[GithubRelease],
    installed: Option<&GithubRelease>,
    current_version: &str,
    feed: UpdateFeed,
) -> Option<ReleaseCandidate> {
    let newest = releases
        .iter()
        .filter(|release| {
            release.is_listed()
                && (feed == UpdateFeed::Preview || !release.prerelease)
                && release.asset_names.iter().any(|name| name == "latest.json")
        })
        .max_by(|a, b| a.published().cmp(&b.published()))?;
    let version = newest.version()?;
    if version == current_version {
        return None;
    }
    match (
        feed,
        installed.and_then(GithubRelease::published),
        newest.published(),
    ) {
        (UpdateFeed::Preview, Some(installed_at), Some(newest_at)) => (newest_at > installed_at)
            .then(|| ReleaseCandidate {
                tag: newest.tag_name.clone(),
                version: version.to_string(),
                preview_ordering: Some(PreviewOrdering {
                    installed_published_at: installed_at.to_string(),
                    candidate_published_at: newest_at.to_string(),
                }),
            }),
        _ => Some(ReleaseCandidate {
            tag: newest.tag_name.clone(),
            version: version.to_string(),
            preview_ordering: None,
        }),
    }
}

/// Enforces the updater's fail-closed URL policy:
/// - Always requires a valid URL with a host and no embedded credentials.
/// - Production builds require `https://`.
/// - Loopback `http://` (`127.0.0.1`, `::1`, `localhost`) is accepted only when
///   `allow_loopback_http` is explicitly enabled by test configuration.
pub fn validate_update_url(raw: &str, allow_loopback_http: bool) -> Result<Url, UpdateError> {
    let trimmed = raw.trim();
    let parsed = Url::parse(trimmed).map_err(|err| UpdateError::InvalidUrl {
        url: trimmed.to_string(),
        reason: err.to_string(),
    })?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(UpdateError::InvalidUrl {
            url: trimmed.to_string(),
            reason: "embedded URL credentials are forbidden".into(),
        });
    }
    let Some(host) = parsed.host() else {
        return Err(UpdateError::InvalidUrl {
            url: trimmed.to_string(),
            reason: "URL must include a host".into(),
        });
    };
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if allow_loopback_http && is_loopback_host(&host) => Ok(parsed),
        scheme => Err(UpdateError::InvalidUrl {
            url: trimmed.to_string(),
            reason: format!("scheme '{scheme}' is not allowed (HTTPS required)"),
        }),
    }
}

fn is_loopback_host(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
    }
}

/// Strictly parses a `latest.json` payload for `target`, validating SemVer, URL policy,
/// required signature presence, and optional SHA-256 format.
pub fn parse_manifest(
    body: &[u8],
    target: &str,
    allow_loopback_http: bool,
) -> Result<UpdateInfo, UpdateError> {
    let root: Value = serde_json::from_slice(body).map_err(|err| UpdateError::InvalidManifest {
        reason: format!("JSON parse error: {err}"),
    })?;
    let Some(object) = root.as_object() else {
        return Err(UpdateError::InvalidManifest {
            reason: "manifest root must be a JSON object".into(),
        });
    };
    let version = required_non_empty_string(object, "version")?;
    parse_semver(version)?;

    let notes = optional_string(object, "notes")?;
    let pub_date = optional_string(object, "pub_date")?;

    let Some(platforms) = object.get("platforms").and_then(Value::as_object) else {
        return Err(UpdateError::InvalidManifest {
            reason: "manifest missing 'platforms' object".into(),
        });
    };
    let Some(entry_val) = platforms.get(target) else {
        return Err(UpdateError::TargetUnavailable {
            target: target.to_string(),
        });
    };
    let Some(entry) = entry_val.as_object() else {
        return Err(UpdateError::InvalidManifest {
            reason: format!("platform entry '{target}' must be a JSON object"),
        });
    };

    let url_raw = required_non_empty_string(entry, "url")?;
    let validated_url = validate_update_url(url_raw, allow_loopback_http)?;
    let signature = required_non_empty_string(entry, "signature")?.to_string();
    let sha256 = match optional_string(entry, "sha256")? {
        Some(raw) => Some(normalize_sha256_hex(&raw)?),
        None => None,
    };

    Ok(UpdateInfo {
        version: version.to_string(),
        target: target.to_string(),
        url: validated_url.into(),
        signature,
        sha256,
        notes,
        pub_date,
    })
}

/// Compares `current_version` against `candidate`, strictly refusing downgrades.
pub fn compare_versions(
    current_version: &str,
    candidate: &UpdateInfo,
    preview_ordering: Option<&PreviewOrdering>,
) -> Result<UpdateCheckOutcome, UpdateError> {
    let current = parse_semver(current_version)?;
    let next = parse_semver(&candidate.version)?;

    if next == current {
        return Ok(UpdateCheckOutcome::UpToDate {
            current_version: current_version.to_string(),
        });
    }

    if let Some(ordering) = preview_ordering {
        if !is_valid_utc_timestamp(&ordering.installed_published_at)
            || !is_valid_utc_timestamp(&ordering.candidate_published_at)
        {
            return Err(UpdateError::InvalidManifest {
                reason: "preview publication timestamps must be UTC YYYY-MM-DDTHH:MM:SSZ".into(),
            });
        }
        return match ordering
            .candidate_published_at
            .cmp(&ordering.installed_published_at)
        {
            std::cmp::Ordering::Greater => Ok(UpdateCheckOutcome::Available(candidate.clone())),
            std::cmp::Ordering::Equal => Ok(UpdateCheckOutcome::UpToDate {
                current_version: current_version.to_string(),
            }),
            std::cmp::Ordering::Less => Err(UpdateError::DowngradeRefused {
                current: current_version.to_string(),
                candidate: candidate.version.clone(),
            }),
        };
    }

    if next < current {
        return Err(UpdateError::DowngradeRefused {
            current: current_version.to_string(),
            candidate: candidate.version.clone(),
        });
    }
    Ok(UpdateCheckOutcome::Available(candidate.clone()))
}

fn parse_semver(raw: &str) -> Result<Version, UpdateError> {
    Version::parse(raw.trim()).map_err(|_| UpdateError::InvalidVersion {
        version: raw.to_string(),
    })
}

fn required_non_empty_string<'a>(
    map: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, UpdateError> {
    let Some(value) = map.get(key) else {
        return Err(UpdateError::InvalidManifest {
            reason: format!("missing required field '{key}'"),
        });
    };
    let Some(text) = value.as_str() else {
        return Err(UpdateError::InvalidManifest {
            reason: format!("field '{key}' must be a string"),
        });
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(UpdateError::InvalidManifest {
            reason: format!("field '{key}' must not be empty"),
        });
    }
    Ok(trimmed)
}

fn optional_string(
    map: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, UpdateError> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
        }
        Some(_) => Err(UpdateError::InvalidManifest {
            reason: format!("optional field '{key}' must be a string"),
        }),
    }
}

fn is_valid_utc_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 20 || bytes[19] != b'Z' {
        return false;
    }
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
            .into_iter()
            .all(|idx| bytes[idx].is_ascii_digit())
}
