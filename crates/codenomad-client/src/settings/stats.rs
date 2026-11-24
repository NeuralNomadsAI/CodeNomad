use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::{Deserialize, de::DeserializeOwned};
use std::time::Duration;

pub const PERIODS: [u32; 4] = [7, 30, 90, 365];
pub const DAY: u64 = 86_400_000;

pub fn utc_stamp(millis: u64) -> Option<String> {
    let stamp =
        time::OffsetDateTime::from_unix_timestamp(i64::try_from(millis / 1000).ok()?).ok()?;
    Some(format!("{} {}", stamp.date(), stamp.time()))
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Proof {
    pub owner: Option<String>,
    pub identity: Option<String>,
    pub connection: Option<String>,
}

impl Proof {
    fn live(&self) -> bool {
        self.owner.as_ref().is_some_and(|value| !value.is_empty())
            && self
                .connection
                .as_ref()
                .is_some_and(|value| !value.is_empty())
    }

    pub fn different_owner(&self, next: &Self) -> bool {
        let differs = |a: &Option<String>, b: &Option<String>| {
            a.as_ref().zip(b.as_ref()).is_some_and(|(a, b)| a != b)
        };
        differs(&self.owner, &next.owner) || differs(&self.identity, &next.identity)
    }

    pub fn conflicts(&self, next: &Self) -> bool {
        self.different_owner(next)
            || self.identity.is_none()
                && self
                    .connection
                    .as_ref()
                    .zip(next.connection.as_ref())
                    .is_some_and(|(a, b)| a != b)
    }

    pub fn adopt_identity(&mut self, source: &Self) {
        if self.identity.is_none()
            && self.owner.is_some()
            && self.owner == source.owner
            && self.connection.is_some()
            && self.connection == source.connection
        {
            self.identity.clone_from(&source.identity);
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Cached {
    pub days: u32,
    #[serde(flatten)]
    pub proof: Proof,
    pub snapshot: Option<Snapshot>,
}

#[derive(Debug, Deserialize)]
pub struct Snapshot {
    scope: String,
    #[serde(flatten)]
    pub proof: Proof,
    pub stats: Stats,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub range: Range,
    pub sessions: u64,
    pub subagents: u64,
    pub prompts: u64,
    pub steps: u64,
    pub tokens: Tokens,
    pub cost: f64,
    pub active_days: u64,
    pub streak: u64,
    pub models: Vec<Model>,
    pub activity: Vec<Day>,
}

#[derive(Debug, Deserialize)]
pub struct Range {
    pub from: u64,
    pub to: u64,
}

#[derive(Debug, Deserialize)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    pub cache: CacheTokens,
}

#[derive(Debug, Deserialize)]
pub struct CacheTokens {
    pub read: u64,
    pub write: u64,
}

#[derive(Debug, Deserialize)]
pub struct Model {
    pub model: ModelId,
    pub steps: u64,
    pub tokens: Tokens,
    pub cost: f64,
}

#[derive(Debug, Deserialize)]
pub struct ModelId {
    #[serde(rename = "providerID")]
    pub provider: String,
    pub id: String,
    pub variant: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Day {
    pub date: String,
    pub steps: u64,
}

impl Snapshot {
    pub fn days(&self) -> u32 {
        ((self.stats.range.to - self.stats.range.from) / DAY) as u32
    }

    fn validate(self) -> Result<Self> {
        let stats = &self.stats;
        let period = stats.range.to.checked_sub(stats.range.from);
        if self.scope != "service"
            || !self.proof.live()
            || !PERIODS
                .iter()
                .any(|&days| period == Some(u64::from(days) * DAY))
            || stats.range.to > 8_640_000_000_000_000
            || stats.activity.len() > 366
            || !stats.cost.is_finite()
            || stats.cost < 0.0
            || stats
                .models
                .iter()
                .any(|row| !row.cost.is_finite() || row.cost < 0.0)
            || stats.activity.iter().any(|row| {
                row.date.len() != 10
                    || !row.date.bytes().enumerate().all(|(i, b)| {
                        if matches!(i, 4 | 7) {
                            b == b'-'
                        } else {
                            b.is_ascii_digit()
                        }
                    })
            })
        {
            return Err("Invalid service statistics".into());
        }
        Ok(self)
    }
}

pub async fn owner(backend: &Backend, workspace: &str) -> Result<Proof> {
    get(backend, workspace, "/owner", &[], Duration::from_secs(15)).await
}

pub async fn cached(
    backend: &Backend,
    workspace: &str,
    zone: &str,
    days: Option<u32>,
) -> Result<Cached> {
    let mut query = vec![("timezone", zone.to_owned())];
    if let Some(days) = days {
        query.push(("days", days.to_string()));
    }
    let mut response: Cached = get(
        backend,
        workspace,
        "/cache",
        &query,
        Duration::from_secs(15),
    )
    .await?;
    if !PERIODS.contains(&response.days) || days.is_some_and(|days| days != response.days) {
        return Err("Invalid cached statistics period".into());
    }
    response.snapshot = response
        .snapshot
        .take()
        .map(Snapshot::validate)
        .transpose()?;
    if response.snapshot.as_ref().is_some_and(|value| {
        response.days != value.days()
            || value.stats.models.len() > 256
            || !response.proof.live()
            || response.proof.identity.is_none()
            || response.proof.owner != value.proof.owner
            || response.proof.identity != value.proof.identity
            || response.proof.connection != value.proof.connection
    }) {
        return Err("Invalid cached statistics identity".into());
    }
    Ok(response)
}

pub async fn fresh(
    backend: &Backend,
    workspace: &str,
    zone: &str,
    days: u32,
    to: u64,
    restore: bool,
) -> Result<Snapshot> {
    let from = to
        .checked_sub(u64::from(days) * DAY)
        .ok_or("Invalid statistics range")?;
    let mut query = vec![
        ("timezone", zone.to_owned()),
        ("from", from.to_string()),
        ("to", to.to_string()),
    ];
    if restore {
        query.push(("restorePeriod", "true".into()));
    }
    let result: Snapshot = get(backend, workspace, "", &query, Duration::from_secs(180)).await?;
    let result = result.validate()?;
    if result.stats.range.to != to || !restore && result.stats.range.from != from {
        return Err("Foreign statistics range".into());
    }
    Ok(result)
}

async fn get<T: DeserializeOwned>(
    backend: &Backend,
    workspace: &str,
    suffix: &str,
    query: &[(&str, String)],
    timeout: Duration,
) -> Result<T> {
    if !valid_id(workspace) {
        return Err("Invalid statistics workspace".into());
    }
    let response = backend
        .client
        .get(format!(
            "{}api/workspaces/{workspace}/service-usage{suffix}",
            backend.base
        ))
        .query(query)
        .timeout(timeout)
        .send()
        .await?
        .error_for_status()?;
    // The native broker admits 8 MiB of aggregates before adding the owner envelope.
    let limit = if suffix.is_empty() {
        8 * 1024 * 1024
    } else {
        1024 * 1024
    };
    Ok(serde_json::from_value(
        read_json_limited(response, limit + 4096).await?,
    )?)
}

pub fn event(kind: &str) -> Option<bool> {
    match kind {
        "session.execution.succeeded"
        | "session.execution.failed"
        | "session.execution.interrupted" => Some(false),
        "session.deleted" | "rpc.codenomad.session-pruning.pruned" | "server.connected" => {
            Some(true)
        }
        _ => None,
    }
}
