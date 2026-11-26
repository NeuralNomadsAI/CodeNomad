use super::{codec::digest, detail::DetailRead};
use crate::{
    backend::Backend,
    history::{Result, valid_id},
    runtime::{Instant, sleep},
};
use futures_lite::StreamExt;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};

const ROWS: usize = 50;
const RESPONSE: usize = 64 * 1024;
const TRANSFERS: usize = 64 * 1024 * 1024;
const REQUEST: usize = 16 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);
const JS_MAX: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Source {
    Summaries,
    Cleanups,
    Mission,
    Tasks,
    Activity,
}

#[derive(Debug)]
pub struct DirectoryChanged;

/// Detects an HTTP 401 returned by Mission reads on both native and WebAssembly targets.
pub fn is_auth_expired(error: &crate::history::Error) -> bool {
    error
        .downcast_ref::<reqwest::Error>()
        .and_then(reqwest::Error::status)
        == Some(reqwest::StatusCode::UNAUTHORIZED)
}

impl std::fmt::Display for DirectoryChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Mission directory changed")
    }
}

impl std::error::Error for DirectoryChanged {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    available: bool,
    version: u8,
    #[serde(rename = "projectID")]
    project_id: String,
    source: Source,
    finish_high_water: Option<u64>,
    discarded_events: u64,
    control_unavailable: bool,
    notification_unavailable: bool,
    cleanup_unavailable: bool,
    window: Option<Window>,
    #[serde(rename = "missionID")]
    mission_id: Option<String>,
    revision: Option<u64>,
    header: Option<bool>,
    field: Option<String>,
    part: Option<String>,
    phase: Option<Phase>,
    observed_at: Option<f64>,
    page: Page,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Observed,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    digest: String,
    total: usize,
    pieces: Vec<Piece>,
    next: Option<Cursor>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Piece {
    index: usize,
    offset: usize,
    characters: usize,
    text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    digest: String,
    index: usize,
    offset: usize,
}

struct Identity {
    project: String,
    window: Option<Window>,
    revision: Option<u64>,
    observed_at: Option<f64>,
    digest: String,
    finish_high_water: Option<u64>,
}

/// One logical directory window. The backend and selector remain fixed across its byte slices.
/// The caller can release its I/O permit between `read_next` calls. Discard on cancellation;
/// after any error, an explicit retry opens a new read from its first slice.
pub type DirectoryRead = DetailRead<DirectoryPage>;

pub(super) struct PageRead {
    pub(super) backend: Backend,
    pub(super) url: Url,
    project: Option<String>,
    source: Source,
    offset: u64,
    order: Option<String>,
    initial: bool,
    selector: Value,
    mission: Option<String>,
    started: Instant,
    bytes: usize,
    characters: usize,
    text_bytes: usize,
    first: Option<Identity>,
    cursor: Option<Cursor>,
    rows: Vec<String>,
    partial: String,
    partial_units: usize,
    row_units: usize,
    closed: bool,
}

pub(super) struct Verified {
    pub project: String,
    pub revision: Option<u64>,
    pub observed_at: Option<f64>,
    pub window: Option<Window>,
    pub finish_high_water: Option<u64>,
    pub rows: Vec<String>,
}

impl Backend {
    pub fn mission_summaries(
        &self,
        project: Option<&str>,
        offset: u64,
        order: Option<&str>,
        initial: bool,
    ) -> Result<DirectoryRead> {
        directory_read(self, project, Source::Summaries, offset, order, initial)
    }

    pub fn mission_cleanups(
        &self,
        project: Option<&str>,
        offset: u64,
        order: Option<&str>,
    ) -> Result<DirectoryRead> {
        directory_read(self, project, Source::Cleanups, offset, order, false)
    }
}

fn directory_read(
    backend: &Backend,
    project: Option<&str>,
    source: Source,
    offset: u64,
    order: Option<&str>,
    initial: bool,
) -> Result<DirectoryRead> {
    Ok(DetailRead {
        read: PageRead::new(
            backend,
            project,
            source,
            None,
            offset,
            order,
            initial,
            json!({ "source": source }),
        )?,
        decode: Box::new(move |page| decode_directory(source, page)),
    })
}

fn decode_directory(source: Source, page: Verified) -> Result<DirectoryPage> {
    let rows = match source {
        Source::Summaries => DirectoryRows::Summaries(summaries(&page.rows)?),
        Source::Cleanups => DirectoryRows::Cleanups(cleanups(&page.rows)?),
        _ => return invalid(),
    };
    Ok(DirectoryPage {
        project_id: page.project,
        finish_high_water: page.finish_high_water,
        window: page.window.ok_or("missing Mission directory window")?,
        rows,
    })
}

impl PageRead {
    pub(super) fn live<T>(&self, value: T) -> Result<T> {
        if self.started.elapsed() >= DEADLINE {
            return Err("Mission read timed out".into());
        }
        Ok(value)
    }

    pub(super) fn selected(
        backend: &Backend,
        project: &str,
        source: Source,
        mission: &str,
        selector: Value,
    ) -> Result<Self> {
        if !panel_id(mission) {
            return invalid();
        }
        Self::new(
            backend,
            Some(project),
            source,
            Some(mission),
            0,
            None,
            false,
            selector,
        )
    }

    pub(super) fn new(
        backend: &Backend,
        project: Option<&str>,
        source: Source,
        mission: Option<&str>,
        offset: u64,
        order: Option<&str>,
        initial: bool,
        selector: Value,
    ) -> Result<Self> {
        if !valid_id(&backend.workspace)
            || project.is_some_and(|project| !panel_id(project))
            || offset > JS_MAX
            || order.is_some_and(|order| !digest_id(order))
            || initial && offset != 0
        {
            return Err("invalid Mission directory selector".into());
        }
        let mut url = Url::parse(&backend.base)?.join("api/workspaces/")?;
        url.path_segments_mut()
            .map_err(|_| "invalid Mission backend URL")?
            .pop_if_empty()
            .extend([backend.workspace.as_str(), "missions", "panel-page"]);
        Ok(Self {
            backend: backend.clone(),
            url,
            project: project.map(str::to_owned),
            source,
            offset,
            order: order.map(str::to_owned),
            initial,
            selector,
            mission: mission.map(str::to_owned),
            started: Instant::now(),
            bytes: 0,
            characters: 0,
            text_bytes: 0,
            first: None,
            cursor: None,
            rows: Vec::new(),
            partial: String::new(),
            partial_units: 0,
            row_units: 0,
            closed: false,
        })
    }

    pub(super) async fn read_next(&mut self) -> Result<Option<Verified>> {
        if self.closed {
            return Err("Mission directory read already closed".into());
        }
        // Close admission before awaiting, so cancellation cannot replay this slice.
        self.closed = true;
        let remaining = DEADLINE
            .checked_sub(self.started.elapsed())
            .ok_or("Mission read timed out")?;
        let (result, bytes) = futures_lite::future::race(self.transfer(), async {
            sleep(remaining).await;
            Err("Mission read timed out".into())
        })
        .await?;
        self.bytes += bytes;
        let page = self.accept(result)?;
        if self.started.elapsed() >= DEADLINE {
            return Err("Mission read timed out".into());
        }
        self.closed = page.is_some();
        Ok(page)
    }

    async fn transfer(&self) -> Result<(Value, usize)> {
        let mut request = self.selector.clone();
        if self.mission.is_none() || self.selector.get("part").is_some() {
            let mut window = json!({ "offset": self.offset });
            if let Some(order) = self.order.as_ref().or_else(|| {
                self.first
                    .as_ref()
                    .and_then(|i| i.window.as_ref())
                    .map(|window| &window.order)
            }) {
                window["order"] = json!(order);
            }
            request["window"] = window;
        }
        if self.initial {
            request["initial"] = json!(true);
        }
        if let Some(cursor) = &self.cursor {
            request["cursor"] = serde_json::to_value(cursor)?;
        }
        if serde_json::to_vec(&request)?.len() > REQUEST {
            return Err("oversized Mission request".into());
        }
        let response = self
            .backend
            .client
            .post(self.url.clone())
            .json(&request)
            .send()
            .await?;
        // Known unavailable envelopes can use a non-success HTTP status.
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(response.error_for_status().unwrap_err().into());
        }
        let budget = RESPONSE.min(TRANSFERS - self.bytes);
        let mut bytes = Vec::new();
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            if chunk.len() > budget - bytes.len() {
                return Err("oversized Mission response".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)?;
        if !status.is_success() && value["available"] != false {
            return Err("Mission directory unavailable".into());
        }
        Ok((value, bytes.len()))
    }

    pub(super) fn accept(&mut self, value: Value) -> Result<Option<Verified>> {
        if value["available"] == false {
            return Err(match value["reason"].as_str() {
                Some("changed") => return Err(DirectoryChanged.into()),
                Some("damaged") => "Mission directory damaged",
                Some("plugin-failed") => "Missions plugin failed",
                Some("plugin-unavailable") => "Missions plugin unavailable",
                _ => "Mission directory unavailable",
            }
            .into());
        }
        let envelope: Envelope = serde_json::from_value(value)?;
        let window = &envelope.window;
        let page = &envelope.page;
        let field = self.selector["field"].as_str();
        if !envelope.available
            || envelope.version != 1
            || envelope.source != self.source
            || !panel_id(&envelope.project_id)
            || self
                .project
                .as_ref()
                .is_some_and(|id| id != &envelope.project_id)
            || !digest_id(&page.digest)
            || page.pieces.len() > ROWS
            || envelope.mission_id != self.mission
            || envelope.header
                != (self.source == Source::Mission && field.is_none()).then_some(true)
            || envelope.field.as_deref() != field
            || envelope.part.as_deref() != self.selector["part"].as_str()
            || envelope.phase != (self.source == Source::Activity).then_some(Phase::Observed)
            || (self.source == Source::Activity) != envelope.observed_at.is_some()
            || envelope
                .observed_at
                .is_some_and(|time| !time.is_finite() || time < 0.0)
            || !match (window, &self.mission, envelope.revision) {
                (Some(window), _, revision)
                    if (field.is_some() && revision.is_some_and(|r| r <= JS_MAX))
                        || (self.mission.is_none() && revision.is_none()) =>
                {
                    digest_id(&window.order)
                        && window.total <= JS_MAX
                        && window.offset == self.offset.min(window.total)
                        && window.end == (window.offset + ROWS as u64).min(window.total)
                        && (window.end - window.offset) as usize == page.total
                        && self
                            .order
                            .as_ref()
                            .is_none_or(|order| order == &window.order)
                }
                (None, Some(_), Some(revision)) if field.is_none() => {
                    revision <= JS_MAX && page.total == 1 && !page.pieces.is_empty()
                }
                _ => false,
            }
            || (self.initial && self.first.is_none()) != envelope.finish_high_water.is_some()
            || envelope
                .finish_high_water
                .is_some_and(|count| count > JS_MAX)
        {
            return invalid();
        }
        if envelope.discarded_events != 0
            || envelope.control_unavailable
            || envelope.notification_unavailable
            || envelope.cleanup_unavailable
        {
            return Err("Mission directory damaged".into());
        }
        if let Some(first) = &self.first {
            if first.project != envelope.project_id
                || first.window != *window
                || first.digest != page.digest
                || first.revision != envelope.revision
            {
                return Err(DirectoryChanged.into());
            }
        } else {
            self.first = Some(Identity {
                project: envelope.project_id.clone(),
                window: window.clone(),
                revision: envelope.revision,
                observed_at: envelope.observed_at,
                digest: page.digest.clone(),
                finish_high_water: envelope.finish_high_water,
            });
        }
        let units_limit: usize = match self.source {
            Source::Summaries => 256 * 1024,
            Source::Mission if field.is_none() => 1024 * 1024,
            Source::Activity => 24 * 1024 * 1024,
            Source::Mission | Source::Cleanups | Source::Tasks => 8 * 1024 * 1024,
        };
        for piece in &page.pieces {
            let units = piece.text.encode_utf16().count();
            if self.rows.len() >= page.total
                || piece.index != self.rows.len()
                || piece.offset != self.partial_units
                || units == 0
                || self.partial_units != 0 && piece.characters != self.row_units
                || units > piece.characters.saturating_sub(piece.offset)
                || piece.characters
                    > units_limit.saturating_sub(self.characters - self.partial_units)
                || piece.text.len() > (units_limit * 3 - self.text_bytes)
            {
                return invalid();
            }
            self.characters += units;
            self.text_bytes += piece.text.len();
            self.row_units = piece.characters;
            self.partial_units += units;
            self.partial.push_str(&piece.text);
            if self.partial_units == self.row_units {
                self.rows.push(std::mem::take(&mut self.partial));
                self.partial_units = 0;
            }
        }
        if let Some(cursor) = envelope.page.next {
            if cursor.digest != envelope.page.digest
                || cursor.index != self.rows.len()
                || cursor.offset != self.partial_units
                || cursor.index >= envelope.page.total
                || self
                    .cursor
                    .as_ref()
                    .map_or(cursor.index == 0 && cursor.offset == 0, |prior| {
                        (cursor.index, cursor.offset) <= (prior.index, prior.offset)
                    })
            {
                return invalid();
            }
            self.cursor = Some(cursor);
            return Ok(None);
        }
        if self.rows.len() != envelope.page.total
            || self.partial_units != 0
            || digest(&self.rows) != envelope.page.digest
        {
            return invalid();
        }
        let first = self
            .first
            .take()
            .ok_or("missing Mission directory identity")?;
        Ok(Some(Verified {
            project: first.project,
            revision: first.revision,
            observed_at: first.observed_at,
            finish_high_water: first.finish_high_water,
            window: first.window,
            rows: std::mem::take(&mut self.rows),
        }))
    }
}

fn invalid<T>() -> Result<T> {
    Err("invalid Mission directory page".into())
}

pub(super) fn digest_id(digest: &str) -> bool {
    digest.len() == 43
        && digest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

pub(super) fn panel_id(id: &str) -> bool {
    !id.is_empty() && id.encode_utf16().count() <= 240
}

fn summaries(rows: &[String]) -> Result<Vec<Summary>> {
    let mut ids = HashSet::new();
    rows.iter()
        .map(|text| {
            let row: Summary = serde_json::from_str(text)?;
            if !panel_id(&row.id)
                || !panel_id(&row.coordinator_session_id)
                || !ids.insert(row.id.clone())
                || row.objective.encode_utf16().count() > 1004
                || row
                    .title
                    .as_ref()
                    .is_some_and(|title| title.encode_utf16().count() > 60)
                || row.revision > JS_MAX
                || row.actor_count > JS_MAX
                || row.task_count.is_some_and(|count| count > JS_MAX)
                || row
                    .finish_sequence
                    .is_some_and(|count| count == 0 || count > JS_MAX)
            {
                return invalid();
            }
            Ok(row)
        })
        .collect()
}

fn cleanups(rows: &[String]) -> Result<Vec<Cleanup>> {
    let mut ids = HashSet::new();
    rows.iter()
        .map(|text| {
            let row: Cleanup = serde_json::from_str(text)?;
            if [&row.mission_id, &row.deletion_id, &row.request_id]
                .iter()
                .any(|id| !panel_id(id))
                || !ids.insert((row.mission_id.clone(), row.deletion_id.clone()))
                || row.expected_revision == 0
                || row.objective.encode_utf16().count() > 240
                || [
                    row.expected_revision,
                    row.removed,
                    row.retained,
                    row.pending,
                ]
                .iter()
                .any(|&count| count > JS_MAX)
                || row.reasons.len() > 5
                || row.reasons.iter().any(|reason| {
                    !matches!(
                        reason.as_str(),
                        "children" | "shared" | "moved" | "identity" | "guarded"
                    )
                })
            {
                return invalid();
            }
            Ok(row)
        })
        .collect()
}

#[cfg(test)]
mod tests;
use super::model::{Cleanup, DirectoryPage, DirectoryRows, Summary, Window};
