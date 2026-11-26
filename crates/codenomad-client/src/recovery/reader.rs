//! Demand generations, suspended reading, pagination and authoritative snapshots.
use super::{Input, authentication::expire_reading, demand};
use crate::{
    Receiver, Sender, Wake,
    backend::Backend,
    content::{self, Part, TextProvenance},
    history,
    runtime::Instant,
    stream,
    transport::{Event, HistoryEdge, publish},
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering::SeqCst},
    },
    time::Duration,
};

pub(super) enum Turn {
    Process,
    Next,
    Stop,
}

pub(super) struct Reader {
    pub(super) active_reader: bool,
    anchored: Option<demand::Target>,
    pub(super) historical: bool,
    pub(super) resident: Vec<history::Row>,
    pub(super) known: HashSet<String>,
    pub(super) owed: HashSet<(String, usize)>,
    pub(super) owed_tools: HashMap<(String, String), u8>,
    pub(super) owed_synthetics: HashMap<String, (u8, usize)>,
    pub(super) frozen_tools: HashMap<(String, String), u64>,
    pub(super) execution_settlement: u8,
    pub(super) execution_ended_at: Option<u64>,
    pub(super) seen: Seen,
    first: Option<String>,
    older: Option<Value>,
    newer: Option<Value>,
    pub(super) repairs: u8,
    pub(super) settlement_reads: u8,
    pub(super) dirty: bool,
    pub(super) parked: bool,
    pub(super) quiet: Instant,
    pub(super) generation: u64,
    initial: bool,
    pub(super) busy: bool,
    pub(super) terminal: bool,
    pub(super) fence: u64,
    pub(super) inbox: Vec<crate::inbox::QueuedPrompt>,
    pub(super) inbox_dirty: bool,
    pub(super) inbox_supported: bool,
    pub(super) inbox_published: bool,
    pub(super) inbox_retries: u8,
    pub(super) inbox_overlap_repairs: u8,
    pub(super) inbox_version: u64,
    pub(super) inbox_quiet: Instant,
    inbox_flight: Option<(u64, u64, u64, Sender<()>)>,
}

impl Reader {
    pub(super) fn new() -> Self {
        Self {
            active_reader: true,
            anchored: None,
            historical: false,
            resident: Vec::new(),
            known: HashSet::new(),
            owed: HashSet::new(),
            owed_tools: HashMap::new(),
            owed_synthetics: HashMap::new(),
            frozen_tools: HashMap::new(),
            execution_settlement: 0,
            execution_ended_at: None,
            seen: Seen {
                entries: VecDeque::new(),
                bytes: 0,
            },
            first: None,
            older: None,
            newer: None,
            repairs: 0,
            settlement_reads: 0,
            dirty: true,
            parked: false,
            quiet: Instant::now(),
            generation: 0,
            initial: true,
            busy: false,
            terminal: false,
            fence: 0,
            inbox: Vec::new(),
            inbox_dirty: true,
            inbox_supported: true,
            inbox_published: false,
            inbox_retries: 0,
            inbox_overlap_repairs: 0,
            inbox_version: 0,
            inbox_quiet: Instant::now(),
            inbox_flight: None,
        }
    }

    pub(super) fn invalidate_inbox_flight(&mut self) {
        self.inbox_version = self.inbox_version.wrapping_add(1);
        if let Some((_, _, _, cancel)) = self.inbox_flight.take() {
            cancel.close();
        }
    }

    pub(super) fn schedule_inbox_sync(&mut self, delay: Duration) {
        self.invalidate_inbox_flight();
        self.inbox_published = false;
        self.inbox_dirty = self.active_reader;
        self.inbox_supported = true;
        self.inbox_retries = 0;
        self.inbox_quiet = Instant::now() + delay;
    }

    pub(super) fn inbox_deadline(
        &self,
        opened: bool,
        wire: &stream::State,
        reading: Option<&ReadingLane>,
    ) -> Option<Instant> {
        (self.active_reader
            && reading.is_none_or(|reading| !reading.demand.is_closed())
            && self.inbox_dirty
            && self.inbox_supported
            && opened
            && wire.upstream.load(SeqCst)
            && !wire.is_stream_closed()
            && !wire.is_placement_changed()
            && self.inbox_flight.is_none()
            && (!self.dirty || self.historical))
            .then_some(self.inbox_quiet)
    }

    pub(super) fn demand(&mut self, reading: Option<&ReadingLane>) {
        if let Some(reading) = reading {
            let want = reading.demand.current();
            let closed = reading.demand.is_closed();
            if want.generation != self.generation || (closed && self.active_reader) {
                self.generation = want.generation;
                self.active_reader = !closed && want.target.is_some();
                self.anchored = if closed { None } else { want.target };
                self.historical = false;
                self.resident = Vec::new();
                self.known = HashSet::new();
                self.owed = HashSet::new();
                self.owed_tools = HashMap::new();
                self.owed_synthetics = HashMap::new();
                self.frozen_tools = HashMap::new();
                self.execution_settlement = 0;
                self.execution_ended_at = None;
                self.seen.entries.clear();
                self.seen.bytes = 0;
                self.first = None;
                self.older = None;
                self.newer = None;
                self.repairs = 0;
                self.settlement_reads = 0;
                self.dirty = self.active_reader;
                self.parked = false;
                self.quiet = Instant::now();
                self.inbox.clear();
                self.invalidate_inbox_flight();
                self.inbox_published = false;
                self.inbox_supported = true;
                self.inbox_dirty = self.active_reader;
                self.inbox_retries = 0;
                self.inbox_overlap_repairs = 0;
                self.inbox_quiet = Instant::now();
            }
        }
    }

    pub(super) fn clear_window(&mut self) {
        self.historical = false;
        self.anchored = None;
        self.first = None;
        self.older = None;
        self.newer = None;
        self.resident.clear();
        self.known.clear();
        self.owed.clear();
        self.owed_tools.clear();
        self.frozen_tools.clear();
        self.execution_settlement = 0;
        self.execution_ended_at = None;
    }

    pub(super) fn clear_window_on_revert(&mut self) {
        self.historical = false;
        self.anchored = None;
        self.resident.clear();
        self.first = None;
        self.older = None;
        self.newer = None;
        self.known.clear();
        self.owed.clear();
        self.owed_tools.clear();
        self.frozen_tools.clear();
        self.execution_settlement = 0;
        self.execution_ended_at = None;
        self.schedule_inbox_sync(Duration::ZERO);
    }

    pub(super) fn next_sync_at(
        &self,
        opened: bool,
        wire: &stream::State,
        reading: Option<&ReadingLane>,
    ) -> Option<Instant> {
        (self.active_reader
            && reading.is_none_or(|reading| !reading.demand.is_closed())
            && self.dirty
            && !self.parked
            && opened
            && wire.upstream.load(SeqCst)
            && !wire.is_stream_closed()
            && !wire.is_placement_changed()
            && !self.historical)
            .then_some(self.quiet)
    }

    pub(super) async fn sync(
        &mut self,
        lane: &Lane<'_>,
        opened: bool,
        connection_lost: &mut bool,
    ) -> history::Result<Turn> {
        let Lane {
            backend,
            reading,
            rx,
            wire,
            out,
            wake,
        } = *lane;
        if self
            .next_sync_at(opened, wire, reading)
            .is_some_and(|quiet| Instant::now() >= quiet)
            && rx.is_empty()
        {
            let stamp = wire.version.load(SeqCst);
            let snapshot = async {
                if let Some(target) = &self.anchored {
                    backend.reading_window(target).await
                } else if self.initial && backend.fresh_mode {
                    backend.empty().await
                } else {
                    backend.restore(self.first.as_deref()).await
                }
            };
            let Some(snapshot) = read_page(backend, reading, self.generation, wire, snapshot).await
            else {
                return Ok(Turn::Next);
            };
            match snapshot {
                Ok(mut page) if wire.valid(stamp) && rx.is_empty() => {
                    // Check server HTTP settlement on raw rows before merging SSE terminal state.
                    self.owed_tools
                        .retain(|(id, call), _| !tool_settled(&page.rows, id, call));
                    let raw_known: HashSet<&str> =
                        page.rows.iter().map(|r| r.id.as_str()).collect();
                    self.frozen_tools.retain(|(id, call), _| {
                        raw_known.contains(id.as_str()) && !tool_settled(&page.rows, id, call)
                    });
                    if self.execution_settlement > 0
                        && !page.running
                        && !(self.anchored.is_some() && page.newer.is_some())
                    {
                        self.execution_settlement = 0;
                        let ended_at = self.execution_ended_at.take();
                        let turn_start = page
                            .rows
                            .iter()
                            .rposition(|r| r.role == "user")
                            .map_or(0, |idx| idx + 1);
                        for row in &page.rows[turn_start..] {
                            for part in &row.parts {
                                if let Part::Tool(tool) = part
                                    && matches!(
                                        tool.status.as_str(),
                                        "pending" | "streaming" | "running"
                                    )
                                {
                                    let key = (row.id.clone(), tool.id.clone());
                                    if self.owed_tools.len() < 64 {
                                        self.owed_tools.entry(key.clone()).or_insert(0);
                                    }
                                    if let Some(ts) = ended_at
                                        .filter(|&ts| tool.started.is_none_or(|start| start <= ts))
                                        .or_else(|| tool.started)
                                        && (self.frozen_tools.contains_key(&key)
                                            || self.frozen_tools.len() < 64)
                                    {
                                        self.frozen_tools.entry(key).or_insert(ts);
                                    }
                                }
                            }
                        }
                    }
                    let mut merged = page.rows.clone();
                    if content::merge_page(&self.resident, &mut merged).is_ok() {
                        page.rows = merged;
                    }
                    if !self.owed_synthetics.is_empty() && page.newer.is_none() {
                        self.owed_synthetics.retain(|id, (_, prior_matches)| {
                            if page.rows.iter().any(|r| &r.id == id) {
                                return false;
                            }
                            if id.starts_with("msg_") {
                                return true;
                            }
                            let Some(resident_row) = self
                                .resident
                                .iter()
                                .find(|r| &r.id == id && r.role == "synthetic")
                            else {
                                return true;
                            };
                            let page_matches = page
                                .rows
                                .iter()
                                .filter(|p| same_synthetic_report(p, resident_row))
                                .count();
                            page_matches <= *prior_matches
                        });
                        let pending_rows: Vec<_> = self
                            .resident
                            .iter()
                            .filter(|r| {
                                r.role == "synthetic"
                                    && self.owed_synthetics.contains_key(&r.id)
                                    && !page.rows.iter().any(|p| p.id == r.id)
                            })
                            .cloned()
                            .collect();
                        for row in pending_rows {
                            if page.rows.len() < history::MAX_ROWS {
                                page.rows.push(row);
                                if history::check(&page.rows).is_err() {
                                    page.rows.pop();
                                    break;
                                }
                            }
                        }
                    }
                    if !self.frozen_tools.is_empty() {
                        for row in &mut page.rows {
                            if !row.parts.iter().any(|p| {
                                matches!(p, Part::Tool(t)
                                    if matches!(t.status.as_str(), "streaming" | "running")
                                        && t.ended.is_none()
                                        && self.frozen_tools.contains_key(&(row.id.clone(), t.id.clone())))
                            }) {
                                continue;
                            }
                            let row = Arc::make_mut(row);
                            for part in &mut row.parts {
                                if let Part::Tool(tool) = part
                                    && matches!(tool.status.as_str(), "streaming" | "running")
                                    && tool.ended.is_none()
                                    && let Some(&ts) =
                                        self.frozen_tools.get(&(row.id.clone(), tool.id.clone()))
                                    && tool.started.is_none_or(|start| start <= ts)
                                {
                                    Arc::make_mut(tool).ended = Some(ts);
                                }
                            }
                        }
                    }
                    self.owed.retain(|(id, ordinal)| {
                        !page
                            .rows
                            .iter()
                            .find(|r| &r.id == id)
                            .and_then(|r| {
                                r.parts
                                    .iter()
                                    .filter_map(|p| match p {
                                        Part::Text(t) => Some(t),
                                        _ => None,
                                    })
                                    .nth(*ordinal)
                            })
                            .is_some_and(|t| t.provenance == TextProvenance::Closed)
                    });
                    self.fence = stamp;
                    *connection_lost = false;
                    self.dirty = false;
                    self.initial = false;
                    self.historical = self.anchored.is_some() && page.newer.is_some();
                    self.anchored = None;
                    self.first = page.rows.first().map(|r| r.id.clone());
                    self.older = page.older.clone();
                    self.newer = page.newer.clone();
                    self.known = page.rows.iter().map(|r| r.id.clone()).collect();
                    self.resident = page.rows.clone();
                    if self.historical {
                        self.execution_settlement = 0;
                        self.owed_tools.retain(|(id, _), _| self.known.contains(id));
                        self.owed_synthetics.clear();
                    } else {
                        if self.execution_settlement > 0 && page.running {
                            self.execution_settlement -= 1;
                            if self.execution_settlement > 0 {
                                self.dirty = true;
                                let attempt = u64::from(3 - self.execution_settlement);
                                self.quiet = Instant::now() + Duration::from_millis(100 * attempt);
                            }
                        }
                        if !self.owed_tools.is_empty() {
                            let mut max_attempt = 0u8;
                            self.owed_tools.retain(|_, attempts| {
                                *attempts = attempts.saturating_add(1);
                                if *attempts <= 3 {
                                    max_attempt = max_attempt.max(*attempts);
                                    true
                                } else {
                                    false
                                }
                            });
                            if !self.owed_tools.is_empty() {
                                self.dirty = true;
                                self.quiet = Instant::now()
                                    + Duration::from_millis(100 * u64::from(max_attempt));
                            }
                        }
                        if !self.owed_synthetics.is_empty() {
                            let mut max_attempt = 0u8;
                            self.owed_synthetics.retain(|_, (attempts, _)| {
                                *attempts = attempts.saturating_add(1);
                                if *attempts <= 3 {
                                    max_attempt = max_attempt.max(*attempts);
                                    true
                                } else {
                                    false
                                }
                            });
                            if !self.owed_synthetics.is_empty() {
                                self.dirty = true;
                                self.quiet = Instant::now()
                                    + Duration::from_millis(100 * u64::from(max_attempt));
                            }
                        }
                    }
                    let done = (self.terminal || self.busy) && !page.running;
                    if done && !self.historical && !self.owed.is_empty() {
                        self.settlement_reads += 1;
                        if self.settlement_reads > 3 {
                            return Err("text settlement remains unconfirmed".into());
                        }
                        self.dirty = true;
                        self.quiet = Instant::now() + Duration::from_millis(100);
                        return Ok(Turn::Next);
                    }
                    self.busy = page.running;
                    self.terminal = false;
                    let event = if reading.is_some() {
                        if !publish(
                            out,
                            wake,
                            Event::ObservedRunning {
                                running: self.busy,
                                version: stamp,
                            },
                        )
                        .await
                        {
                            return Ok(Turn::Stop);
                        }
                        Event::ReaderSync {
                            page,
                            version: stamp,
                        }
                    } else {
                        Event::Sync(page)
                    };
                    if !reader_event(reading, self.generation, out, wake, event).await {
                        return Ok(Turn::Stop);
                    }
                    let before_inbox = self.inbox.len();
                    self.inbox.retain(|item| !self.known.contains(&item.id));
                    if self.inbox.len() != before_inbox {
                        self.schedule_inbox_sync(Duration::from_millis(100));
                        if !reader_event(
                            reading,
                            self.generation,
                            out,
                            wake,
                            Event::Inbox {
                                items: self.inbox.clone(),
                                authoritative: false,
                            },
                        )
                        .await
                        {
                            return Ok(Turn::Stop);
                        }
                    }
                    if done && reading.is_none() {
                        reader_event(reading, self.generation, out, wake, Event::Done).await;
                    }
                }
                Ok(_) => {
                    self.quiet = Instant::now() + Duration::from_millis(200);
                }
                Err(PageFailure::StreamClosed) => {
                    return Ok(Turn::Next);
                }
                Err(PageFailure::AuthenticationExpired) => {
                    expire_reading(backend, reading, wire, out, wake).await;
                    return Ok(Turn::Stop);
                }
                Err(PageFailure::Read(error)) => {
                    if cfg!(target_arch = "wasm32")
                        && *connection_lost
                        && matches!(
                            backend.workspace_missing(&backend.workspace).await,
                            Ok(true)
                        )
                    {
                        wire.cancel();
                        publish(out, wake, Event::WorkspaceMissing).await;
                        return Ok(Turn::Stop);
                    }
                    eprintln!("Rune history refresh failed: {}", read_diagnostic(&error));
                    self.dirty = false;
                    self.parked = true;
                    reader_event(reading, self.generation, out, wake, Event::Failed).await;
                }
            }
        }
        Ok(Turn::Process)
    }

    pub(super) fn maybe_start_inbox(
        &mut self,
        epoch: u64,
        backend: &Backend,
        reading: Option<&ReadingLane>,
        wire: &Arc<stream::State>,
        opened: bool,
        inbox_tx: &Sender<InboxReply>,
    ) {
        let Some(deadline) = self.inbox_deadline(opened, wire, reading) else {
            return;
        };
        if Instant::now() < deadline {
            return;
        }
        let generation = self.generation;
        let seq = self.inbox_version;
        let wire_inbox = wire.inbox_version.load(SeqCst);
        let (cancel, cancelled) = crate::bounded(1);
        self.inbox_flight = Some((epoch, generation, seq, cancel));
        let backend = backend.clone();
        let wire = wire.clone();
        let inbox_tx = inbox_tx.clone();
        crate::runtime::spawn(async move {
            let read = async {
                match backend.session_inbox().await {
                    Err(error)
                        if crate::http::authentication_expired(&error)
                            && matches!(backend.authentication_status().await, Ok(false)) =>
                    {
                        Err(InboxReadError::AuthenticationExpired)
                    }
                    Ok(items) => Ok(items),
                    Err(_) => Err(InboxReadError::Failed),
                }
            };
            let outcome = futures_lite::future::race(
                async {
                    let _ = cancelled.recv().await;
                    None
                },
                futures_lite::future::race(
                    async {
                        wire.placement_changed().await;
                        None
                    },
                    futures_lite::future::race(
                        async {
                            wire.stream_closed().await;
                            Some(Err(InboxReadError::StreamClosed))
                        },
                        async { Some(read.await) },
                    ),
                ),
            )
            .await;
            if let Some(result) = outcome {
                let _ = inbox_tx
                    .send(InboxReply {
                        epoch,
                        generation,
                        seq,
                        wire_inbox,
                        result,
                    })
                    .await;
            }
        });
    }

    pub(super) async fn finish_inbox_read(
        &mut self,
        lane: &Lane<'_>,
        epoch: u64,
        reply: InboxReply,
    ) -> history::Result<Turn> {
        let InboxReply {
            epoch: read_epoch,
            generation,
            seq,
            wire_inbox,
            result,
        } = reply;
        if read_epoch != epoch || generation != self.generation || seq != self.inbox_version {
            return Ok(Turn::Process);
        }
        self.inbox_flight = None;
        let Lane {
            backend,
            reading,
            wire,
            out,
            wake,
            ..
        } = *lane;
        if !matches!(
            result,
            Err(InboxReadError::AuthenticationExpired | InboxReadError::StreamClosed)
        ) && wire.inbox_version.load(SeqCst) != wire_inbox
        {
            self.inbox_dirty = self.active_reader;
            self.inbox_quiet = Instant::now() + Duration::from_millis(100);
            return Ok(Turn::Process);
        }
        match result {
            Ok(Some(mut items)) => {
                let disappeared = self
                    .inbox
                    .iter()
                    .any(|old| !items.iter().any(|next| next.id == old.id));
                let overlaps_resident = items.iter().any(|item| self.known.contains(&item.id));
                items.retain(|item| !self.known.contains(&item.id));
                self.inbox_dirty = false;
                self.inbox_retries = 0;
                let mut need_history = disappeared;
                if overlaps_resident {
                    if self.inbox_overlap_repairs < 2 {
                        self.inbox_overlap_repairs += 1;
                        need_history = true;
                    }
                } else {
                    self.inbox_overlap_repairs = 0;
                }
                if need_history && !self.historical && !self.parked {
                    self.dirty = true;
                    self.quiet = Instant::now();
                }
                if !self.inbox_published || self.inbox != items {
                    self.inbox_published = true;
                    self.inbox = items;
                    if !reader_event(
                        reading,
                        self.generation,
                        out,
                        wake,
                        Event::Inbox {
                            items: self.inbox.clone(),
                            authoritative: true,
                        },
                    )
                    .await
                    {
                        return Ok(Turn::Stop);
                    }
                }
            }
            Ok(None) => {
                self.inbox_dirty = false;
                self.inbox_supported = false;
                self.inbox_retries = 0;
                self.inbox_overlap_repairs = 0;
                if !self.inbox_published || !self.inbox.is_empty() {
                    self.inbox_published = true;
                    self.inbox.clear();
                    if !reader_event(
                        reading,
                        self.generation,
                        out,
                        wake,
                        Event::Inbox {
                            items: Vec::new(),
                            authoritative: true,
                        },
                    )
                    .await
                    {
                        return Ok(Turn::Stop);
                    }
                }
            }
            Err(InboxReadError::StreamClosed) => {
                return Ok(Turn::Next);
            }
            Err(InboxReadError::AuthenticationExpired) => {
                expire_reading(backend, reading, wire, out, wake).await;
                return Ok(Turn::Stop);
            }
            Err(InboxReadError::Failed) => {
                self.inbox_retries = self.inbox_retries.saturating_add(1);
                if self.inbox_retries <= 3 {
                    self.inbox_quiet =
                        Instant::now() + Duration::from_millis(200 * u64::from(self.inbox_retries));
                } else {
                    self.inbox_dirty = false;
                    self.inbox_published = false;
                    if !reader_event(reading, self.generation, out, wake, Event::InboxFailed).await
                    {
                        return Ok(Turn::Stop);
                    }
                }
            }
        }
        Ok(Turn::Process)
    }
}

pub(super) fn tool_settled(rows: &[history::Row], id: &str, call: &str) -> bool {
    rows.iter()
        .find(|r| r.id == id)
        .and_then(|r| {
            r.parts.iter().find_map(|p| match p {
                Part::Tool(t) if t.id == call => Some(t),
                _ => None,
            })
        })
        .is_some_and(|t| !matches!(t.status.as_str(), "pending" | "streaming" | "running"))
}

pub(super) struct Lane<'a> {
    pub(super) backend: &'a Backend,
    pub(super) reading: Option<&'a ReadingLane>,
    pub(super) rx: &'a Receiver<Input>,
    pub(super) wire: &'a Arc<stream::State>,
    pub(super) out: &'a Sender<Event>,
    pub(super) wake: &'a Wake,
}

pub(super) struct Seen {
    entries: VecDeque<String>,
    bytes: usize,
}
impl Seen {
    pub(super) fn insert(&mut self, event: &Value) -> bool {
        let key = event.to_string();
        if self.entries.contains(&key) {
            return false;
        }
        self.bytes += key.len();
        self.entries.push_back(key);
        while self.entries.len() > 256 || self.bytes > 1024 * 1024 {
            self.bytes -= self.entries.pop_front().unwrap().len();
        }
        true
    }
}
pub struct ReadingLane {
    pub demand: demand::Observer,
    pub events: Sender<(u64, u64, Event)>,
    pub connection: Arc<AtomicU64>,
}

impl ReadingLane {
    pub(super) fn invalidate_connection(reading: Option<&Self>) {
        if let Some(reading) = reading {
            reading.connection.fetch_add(1, SeqCst);
        }
    }
}

pub(super) struct InboxReply {
    pub(super) epoch: u64,
    pub(super) generation: u64,
    pub(super) seq: u64,
    pub(super) wire_inbox: u64,
    pub(super) result: Result<Option<Vec<crate::inbox::QueuedPrompt>>, InboxReadError>,
}

pub(super) enum InboxReadError {
    AuthenticationExpired,
    StreamClosed,
    Failed,
}

enum PageFailure {
    AuthenticationExpired,
    StreamClosed,
    Read(history::Error),
}

async fn read_page(
    backend: &Backend,
    reading: Option<&ReadingLane>,
    generation: u64,
    wire: &stream::State,
    page: impl std::future::Future<Output = history::Result<history::Page>>,
) -> Option<Result<history::Page, PageFailure>> {
    read_fenced(backend, reading, generation, wire, page).await
}

async fn read_fenced<T>(
    backend: &Backend,
    reading: Option<&ReadingLane>,
    generation: u64,
    wire: &stream::State,
    read: impl std::future::Future<Output = history::Result<T>>,
) -> Option<Result<T, PageFailure>> {
    let page = async {
        match read.await {
            Err(error)
                if crate::http::authentication_expired(&error)
                    && matches!(backend.authentication_status().await, Ok(false)) =>
            {
                Err(PageFailure::AuthenticationExpired)
            }
            result => result.map_err(PageFailure::Read),
        }
    };
    let content = async {
        match reading {
            Some(reading) => {
                futures_lite::future::race(
                    async {
                        reading.demand.changed_after(generation).await;
                        None
                    },
                    async { Some(page.await) },
                )
                .await
            }
            None => Some(page.await),
        }
    };
    let result = futures_lite::future::race(
        content,
        futures_lite::future::race(
            async {
                wire.placement_changed().await;
                None
            },
            async {
                wire.stream_closed().await;
                Some(Err(PageFailure::StreamClosed))
            },
        ),
    )
    .await;
    result.filter(|_| {
        !wire.is_placement_changed()
            && reading.is_none_or(|reading| reading.demand.current().generation == generation)
    })
}

pub(super) async fn reader_event(
    reading: Option<&ReadingLane>,
    generation: u64,
    out: &Sender<Event>,
    wake: &crate::Wake,
    event: Event,
) -> bool {
    let Some(reading) = reading else {
        return publish(out, wake, event).await;
    };
    let connection = reading.connection.load(SeqCst);
    futures_lite::future::race(
        async {
            reading.demand.changed_after(generation).await;
            true
        },
        async {
            if reading
                .events
                .send((generation, connection, event))
                .await
                .is_err()
            {
                return false;
            }
            wake();
            true
        },
    )
    .await
}

pub(super) fn can_restart(row: &crate::Message) -> bool {
    !row.completed && row.body.is_empty() && row.parts.iter().all(|part|
        matches!(part,Part::Text(text) if text.text.is_empty() && text.provenance==TextProvenance::Live))
}

pub(super) fn same_synthetic_report(a: &crate::Message, b: &crate::Message) -> bool {
    if a.role != "synthetic" || b.role != "synthetic" {
        return false;
    }
    fn report(row: &crate::Message) -> Option<&crate::content::SubagentReport> {
        row.parts.iter().find_map(|part| match part {
            Part::SubagentReport(r) => Some(r),
            _ => None,
        })
    }
    match (report(a), report(b)) {
        (Some(ra), Some(rb)) => ra.child == rb.child && ra.state == rb.state && ra.body == rb.body,
        _ => false,
    }
}
fn read_diagnostic(error: &history::Error) -> String {
    if let Some(http) = error.downcast_ref::<reqwest::Error>() {
        return format!(
            "http status={:?} timeout={} decode={}",
            http.status().map(|s| s.as_u16()),
            http.is_timeout(),
            http.is_decode()
        );
    }
    if let Some(json) = error.downcast_ref::<serde_json::Error>() {
        return format!(
            "json {:?} at {}:{}",
            json.classify(),
            json.line(),
            json.column()
        );
    }
    match error.to_string().as_str() {
        "history unavailable or anchor changed" => "window unavailable or anchor changed",
        "resident anchor missing" => "resident anchor missing",
        "invalid history cursor" => "invalid history cursor",
        "history cursor did not advance" => "history cursor did not advance",
        "history page did not advance" => "history page did not advance",
        "history windows lost their overlap" => "history windows lost their overlap",
        "recovery page budget reached" => "recovery page budget reached",
        "invalid history window" => "invalid history window",
        "inconsistent latest marker" => "inconsistent latest marker",
        "resident history limit reached" => "resident history limit reached",
        "oversized response" => "oversized response",
        _ => "contract validation",
    }
    .into()
}
#[cfg(test)]
mod diagnostic_tests {
    #[test]
    fn a_replayed_start_cannot_restart_a_row_that_already_produced_output() {
        use crate::{
            content::{Part, Text, TextProvenance},
            history,
        };
        use serde_json::json;
        let mut row =
            history::decode_message(&json!({"id":"assistant","type":"assistant","content":[]}))
                .unwrap();
        assert!(super::can_restart(&row));
        row.parts.push(Part::Text(Text {
            part_index: None,
            text: String::new(),
            provenance: TextProvenance::Live,
        }));
        assert!(super::can_restart(&row));
        row.completed = true;
        assert!(!super::can_restart(&row));
        row.completed = false;
        row.parts[0] = Part::Text(Text {
            part_index: None,
            text: "already painted".into(),
            provenance: TextProvenance::Live,
        });
        assert!(!super::can_restart(&row));
        let tool = history::decode_message(&json!({"id":"assistant","type":"assistant","content":[
            {"type":"tool","id":"read","name":"read","state":{"status":"running"}}
        ]}))
        .unwrap();
        assert!(!super::can_restart(&tool));
    }
    #[test]
    fn unknown_error_details_are_private_and_known_anchor_failures_are_distinct() {
        let unknown: crate::history::Error = "credential text that must stay private".into();
        assert_eq!(super::read_diagnostic(&unknown), "contract validation");
        let anchor: crate::history::Error = "resident anchor missing".into();
        assert_eq!(super::read_diagnostic(&anchor), "resident anchor missing");
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn stream_close_aborts_in_flight_page_with_stream_closed_failure() {
        use super::{PageFailure, read_page};
        use crate::{backend::Backend, stream};
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            let wire = stream::State::default();
            let mut fut =
                std::pin::pin!(read_page(&backend, None, 0, &wire, std::future::pending()));
            assert!(futures_lite::future::poll_once(&mut fut).await.is_none());
            wire.close_stream();
            assert!(matches!(
                futures_lite::future::poll_once(&mut fut).await,
                Some(Some(Err(PageFailure::StreamClosed)))
            ));
        });
    }
}

mod pages;
