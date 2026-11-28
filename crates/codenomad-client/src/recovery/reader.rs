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
        atomic::{AtomicBool, AtomicU64, Ordering::SeqCst},
    },
    time::Duration,
};

pub(super) enum Turn {
    Process,
    Next,
    Stop,
    AuthenticationExpired,
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
    pub(super) inbox_sync_epoch: u64,
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
            inbox_sync_epoch: 0,
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
            && wire.inbox.applied_caught_up()
            && self.inbox_flight.is_none())
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
            let revision = wire.history_revision.load(SeqCst);
            let anchored_around = matches!(self.anchored, Some(demand::Target::Around(_)));
            let snapshot = async {
                if let Some(target) = &self.anchored {
                    backend.reading_window(target).await
                } else if self.initial && backend.fresh_mode {
                    backend.empty().await
                } else {
                    backend.restore(self.first.as_deref()).await
                }
            };
            let Some(snapshot) = read_page(
                backend,
                reading,
                self.generation,
                wire,
                if anchored_around {
                    Fence::History(revision)
                } else {
                    Fence::Live(stamp)
                },
                snapshot,
            )
            .await
            else {
                return Ok(Turn::Next);
            };
            let admitted = |page: &history::Page| {
                if anchored_around && page.newer.is_some() {
                    wire.history_current(revision)
                } else {
                    wire.valid(stamp) && rx.is_empty()
                }
            };
            match snapshot {
                Ok(mut page) if admitted(&page) => {
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
                    let mut removed = Vec::new();
                    self.inbox.retain(|item| {
                        if self.known.contains(&item.id) {
                            removed.push(item.id.clone());
                            false
                        } else {
                            true
                        }
                    });
                    if !removed.is_empty() {
                        self.schedule_inbox_sync(Duration::from_millis(100));
                        for id in removed {
                            if !reader_event(
                                reading,
                                self.generation,
                                out,
                                wake,
                                Event::InboxDelta(crate::inbox::InboxDelta::Removed(id)),
                            )
                            .await
                            {
                                return Ok(Turn::Stop);
                            }
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
                    expire_reading(reading, wire, out).await;
                    return Ok(Turn::AuthenticationExpired);
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
        let sync_epoch = self.inbox_sync_epoch;
        let wire_inbox = wire.inbox.capture();
        let (cancel, cancelled) = crate::bounded(1);
        self.inbox_flight = Some((epoch, generation, seq, cancel));
        let backend = backend.clone();
        let wire = wire.clone();
        let inbox_tx = inbox_tx.clone();
        crate::runtime::spawn(async move {
            if wire.is_placement_changed() || cancelled.is_closed() {
                return;
            }
            let outcome = if wire.is_stream_closed() {
                Some(Err(InboxReadError::StreamClosed))
            } else {
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
                futures_lite::future::race(
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
                .await
            };
            if let Some(result) = outcome {
                let _ = inbox_tx
                    .send(InboxReply {
                        epoch,
                        generation,
                        seq,
                        sync_epoch,
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
            sync_epoch,
            wire_inbox,
            result,
        } = reply;
        if read_epoch != epoch || generation != self.generation || seq != self.inbox_version {
            return Ok(Turn::Process);
        }
        self.inbox_flight = None;
        let Lane {
            reading,
            wire,
            out,
            wake,
            ..
        } = *lane;
        if !matches!(
            result,
            Err(InboxReadError::AuthenticationExpired | InboxReadError::StreamClosed)
        ) && !wire.inbox.is_admissible(wire_inbox)
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
                    let previous = std::mem::replace(&mut self.inbox, items);
                    self.inbox_published = true;
                    let fence = wire.inbox.fence(wire_inbox, sync_epoch);
                    if !reader_event(
                        reading,
                        self.generation,
                        out,
                        wake,
                        Event::Inbox {
                            items: self.inbox.clone(),
                            authoritative: true,
                            fence: Some(fence),
                        },
                    )
                    .await
                    {
                        return Ok(Turn::Stop);
                    }
                    if !wire.inbox.is_admissible(wire_inbox) {
                        self.inbox = previous;
                        self.inbox_published = false;
                        self.inbox_dirty = self.active_reader;
                        self.inbox_quiet = Instant::now() + Duration::from_millis(100);
                    }
                }
            }
            Ok(None) => {
                self.inbox_dirty = false;
                self.inbox_supported = false;
                self.inbox_retries = 0;
                self.inbox_overlap_repairs = 0;
                if !self.inbox_published || !self.inbox.is_empty() {
                    let previous = std::mem::take(&mut self.inbox);
                    self.inbox_published = true;
                    let fence = wire.inbox.fence(wire_inbox, sync_epoch);
                    if !reader_event(
                        reading,
                        self.generation,
                        out,
                        wake,
                        Event::Inbox {
                            items: Vec::new(),
                            authoritative: true,
                            fence: Some(fence),
                        },
                    )
                    .await
                    {
                        return Ok(Turn::Stop);
                    }
                    if !wire.inbox.is_admissible(wire_inbox) {
                        self.inbox = previous;
                        self.inbox_supported = true;
                        self.inbox_published = false;
                        self.inbox_dirty = self.active_reader;
                        self.inbox_quiet = Instant::now() + Duration::from_millis(100);
                    }
                }
            }
            Err(InboxReadError::StreamClosed) => {
                return Ok(Turn::Next);
            }
            Err(InboxReadError::AuthenticationExpired) => {
                expire_reading(reading, wire, out).await;
                return Ok(Turn::AuthenticationExpired);
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
    pub on_session_deleted: Option<Arc<dyn Fn() + Send + Sync>>,
    pub revoked: Arc<AtomicBool>,
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
    pub(super) sync_epoch: u64,
    pub(super) wire_inbox: crate::inbox::InboxStamp,
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

#[derive(Clone, Copy)]
enum Fence {
    Live(u64),
    History(u64),
}

impl Fence {
    fn valid(self, wire: &stream::State) -> bool {
        match self {
            Self::Live(stamp) => wire.valid(stamp),
            Self::History(revision) => wire.history_current(revision),
        }
    }
}

async fn read_page(
    backend: &Backend,
    reading: Option<&ReadingLane>,
    generation: u64,
    wire: &stream::State,
    fence: Fence,
    page: impl std::future::Future<Output = history::Result<history::Page>>,
) -> Option<Result<history::Page, PageFailure>> {
    read_fenced(backend, reading, generation, wire, fence, page).await
}

async fn read_fenced<T>(
    backend: &Backend,
    reading: Option<&ReadingLane>,
    generation: u64,
    wire: &stream::State,
    fence: Fence,
    read: impl std::future::Future<Output = history::Result<T>>,
) -> Option<Result<T, PageFailure>> {
    if wire.is_placement_changed()
        || reading.is_some_and(|reading| reading.demand.current().generation != generation)
    {
        return None;
    }
    if wire.is_stream_closed() {
        return Some(Err(PageFailure::StreamClosed));
    }
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
                wire.stream_closed().await;
                Some(Err(PageFailure::StreamClosed))
            },
            async {
                futures_lite::future::race(wire.placement_changed(), async {
                    while fence.valid(wire) {
                        crate::runtime::sleep(Duration::from_millis(25)).await;
                    }
                })
                .await;
                if wire.is_placement_changed() || wire.placement_closed() {
                    None
                } else if !wire.alive.load(SeqCst) {
                    Some(Err(PageFailure::StreamClosed))
                } else {
                    None
                }
            },
        ),
    )
    .await;
    if wire.is_placement_changed()
        || reading.is_some_and(|reading| reading.demand.current().generation != generation)
    {
        return None;
    }
    if wire.is_stream_closed() {
        return Some(Err(PageFailure::StreamClosed));
    }
    match result {
        Some(Err(PageFailure::Read(_))) if !wire.alive.load(SeqCst) => {
            Some(Err(PageFailure::StreamClosed))
        }
        Some(Err(PageFailure::Read(_))) if !fence.valid(wire) => None,
        other => other,
    }
}

pub(super) async fn reader_inbox_delta(
    reading: Option<&ReadingLane>,
    generation: u64,
    out: &Sender<Event>,
    wake: &crate::Wake,
    delta: crate::inbox::InboxDelta,
) -> bool {
    let Some(reading) = reading else {
        return publish(out, wake, Event::InboxDelta(delta)).await;
    };
    let connection = reading.connection.load(SeqCst);
    let delivered = futures_lite::future::race(
        async {
            reading.demand.changed_after(generation).await;
            None
        },
        async {
            Some(
                reading
                    .events
                    .send((generation, connection, Event::InboxDelta(delta.clone())))
                    .await
                    .is_ok(),
            )
        },
    )
    .await;
    match delivered {
        Some(true) => {
            wake();
            true
        }
        Some(false) => false,
        None => publish(out, wake, Event::InboxDelta(delta)).await,
    }
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
            bounded: false,
        }));
        assert!(super::can_restart(&row));
        row.completed = true;
        assert!(!super::can_restart(&row));
        row.completed = false;
        row.parts[0] = Part::Text(Text {
            part_index: None,
            text: "already painted".into(),
            provenance: TextProvenance::Live,
            bounded: false,
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
            wire.alive.store(true, std::sync::atomic::Ordering::SeqCst);
            wire.upstream
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let mut fut = std::pin::pin!(read_page(
                &backend,
                None,
                0,
                &wire,
                super::Fence::Live(0),
                std::future::pending(),
            ));
            assert!(futures_lite::future::poll_once(&mut fut).await.is_none());
            wire.close_stream();
            assert!(matches!(
                futures_lite::future::poll_once(&mut fut).await,
                Some(Some(Err(PageFailure::StreamClosed)))
            ));

            // Exercise the HTTP-error branch directly: wire is still open when polling starts,
            // closes during the HTTP poll, and the HTTP future returns Err(...) so read_page
            // must reclassify the read error as StreamClosed rather than Read.
            let closing_wire = std::sync::Arc::new(stream::State::default());
            closing_wire
                .alive
                .store(true, std::sync::atomic::Ordering::SeqCst);
            closing_wire
                .upstream
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let close_on_poll = std::sync::Arc::clone(&closing_wire);
            let outcome = read_page(
                &backend,
                None,
                0,
                &closing_wire,
                super::Fence::Live(0),
                std::future::poll_fn(move |_| {
                    close_on_poll.close_stream();
                    std::task::Poll::Ready(Err("transient read failure".into()))
                }),
            )
            .await;
            assert!(matches!(outcome, Some(Err(PageFailure::StreamClosed))));
        });
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn wire_inbox_fence_rejects_in_flight_and_blocked_publication_invalidation() {
        use super::{InboxReply, Lane, Reader, ReadingLane, demand};
        use crate::{
            backend::Backend, bounded, inbox::QueuedPrompt, prompt::Delivery, stream,
            transport::Event,
        };
        use std::{sync::Arc, time::Duration};
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
            let (out_tx, _out_rx) = bounded(4);
            let (_in_tx, in_rx) = bounded(4);
            let (_demand_tx, demand_rx) = demand::open();
            let (reader_tx, reader_rx) = bounded(1);
            let reading = ReadingLane {
                demand: demand_rx,
                events: reader_tx.clone(),
                connection: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                on_session_deleted: None,
                revoked: Default::default(),
            };
            let wake: crate::Wake = Arc::new(|| {});
            let wire = Arc::new(stream::State::default());
            let mut reader = Reader::new();
            let lane = Lane {
                backend: &backend,
                reading: Some(&reading),
                rx: &in_rx,
                wire: &wire,
                out: &out_tx,
                wake: &wake,
            };
            let stale_item = QueuedPrompt {
                id: "q-stale".into(),
                delivery: Delivery::Queue,
                text: "stale".into(),
                parts: vec![],
                created: Some(1),
                editable: true,
            };

            // 1. Reader seq still matches, but SSE ingress already bumped wire.inbox -> rejected.
            let captured = wire.inbox.capture();
            let mark1 = wire.inbox.record_ingress();
            let _ = reader
                .finish_inbox_read(
                    &lane,
                    1,
                    InboxReply {
                        epoch: 1,
                        generation: reader.generation,
                        seq: reader.inbox_version,
                        sync_epoch: 0,
                        wire_inbox: captured,
                        result: Ok(Some(vec![stale_item.clone()])),
                    },
                )
                .await
                .unwrap();
            assert!(reader_rx.is_empty());
            assert!(reader.inbox_dirty && !reader.inbox_published);

            // 1b. Capturing an unapplied ingress watermark must also be rejected before recovery catches up.
            let captured_unapplied = wire.inbox.capture();
            let _ = reader
                .finish_inbox_read(
                    &lane,
                    1,
                    InboxReply {
                        epoch: 1,
                        generation: reader.generation,
                        seq: reader.inbox_version,
                        sync_epoch: 0,
                        wire_inbox: captured_unapplied,
                        result: Ok(Some(vec![stale_item.clone()])),
                    },
                )
                .await
                .unwrap();
            assert!(
                reader_rx.is_empty(),
                "snapshot must not be admitted while applied watermark lags ingress"
            );
            wire.inbox.advance_applied(mark1);

            // 2. Reader channel is full while finish_inbox_read awaits send; SSE bumps wire.inbox
            // before the slot drains -> emitted Event::Inbox carries an invalidated fence and reader reschedules.
            reader_tx.send((0, 0, Event::Done)).await.unwrap();
            let captured2 = wire.inbox.capture();
            let wire_for_bump = wire.clone();
            let rx_for_drain = reader_rx.clone();
            let unblocker = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                wire_for_bump.inbox.record_ingress();
                let first = rx_for_drain.recv().await.unwrap();
                assert!(matches!(first.2, Event::Done));
                rx_for_drain.recv().await.unwrap()
            });
            let _ = reader
                .finish_inbox_read(
                    &lane,
                    1,
                    InboxReply {
                        epoch: 1,
                        generation: reader.generation,
                        seq: reader.inbox_version,
                        sync_epoch: 0,
                        wire_inbox: captured2,
                        result: Ok(Some(vec![stale_item])),
                    },
                )
                .await
                .unwrap();
            let (_, _, queued_event) = tokio::time::timeout(Duration::from_secs(2), unblocker)
                .await
                .expect("blocked inbox publication unblocked")
                .unwrap();
            match queued_event {
                Event::Inbox {
                    authoritative: true,
                    fence: Some(fence),
                    ..
                } => assert!(
                    !fence.is_valid(),
                    "snapshot invalidated while blocked on full channel must report invalid fence"
                ),
                other => panic!("expected fenced authoritative Event::Inbox, got {other:?}"),
            }
            assert!(
                reader.inbox_dirty && !reader.inbox_published && reader.inbox.is_empty(),
                "invalidated publication must restore previous cache and schedule a replacement inbox GET"
            );
        });
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn select_input_bounds_rx_burst_to_eight_before_ready_inbox_reply() {
        use super::super::{
            Input,
            transport::{MAX_RX_BURST_BEFORE_INBOX, select_input},
        };
        use super::InboxReply;
        use crate::bounded;

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (rx_tx, rx) = bounded(32);
            let (inbox_tx, inbox_rx) = bounded(4);
            for i in 0..16u64 {
                rx_tx.send(Input::Hint(1, i + 1, 0)).await.unwrap();
            }
            inbox_tx
                .send(InboxReply {
                    epoch: 1,
                    generation: 0,
                    seq: 0,
                    sync_epoch: 0,
                    wire_inbox: crate::inbox::InboxStamp::default(),
                    result: Ok(Some(Vec::new())),
                })
                .await
                .unwrap();

            let mut rx_burst = 0u8;
            let mut rx_before_inbox = 0u8;
            loop {
                let (input, reply) =
                    select_input(&rx, &inbox_rx, &mut rx_burst, None, 0, true, None).await;
                if reply.is_some() {
                    break;
                }
                assert!(input.is_some());
                rx_before_inbox += 1;
                assert!(
                    rx_before_inbox <= MAX_RX_BURST_BEFORE_INBOX,
                    "rx burst exceeded hard bound"
                );
            }
            assert_eq!(rx_before_inbox, MAX_RX_BURST_BEFORE_INBOX);
            assert_eq!(rx_burst, 0);
            assert!(!rx.is_empty(), "remaining rx inputs must still be queued");
        });
    }

    #[test]
    fn dirty_history_and_applied_watermark_control_inbox_deadline() {
        let mut reader = super::Reader::new();
        reader.active_reader = true;
        reader.historical = false;
        reader.dirty = true;
        reader.parked = false;
        reader.inbox_dirty = true;
        let wire = crate::stream::State::default();
        wire.upstream
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // Dirty unparked history must NOT block independent inbox scheduling.
        assert!(
            reader.inbox_deadline(true, &wire, None).is_some(),
            "dirty unparked history must not stall inbox refresh"
        );
        // Parked dirty history also allows inbox refresh.
        reader.parked = true;
        assert!(
            reader.next_sync_at(true, &wire, None).is_none(),
            "parked history reader must not schedule history sync"
        );
        assert!(
            reader.inbox_deadline(true, &wire, None).is_some(),
            "parked dirty history reader must still allow scheduled inbox refresh"
        );
        // Retry invalidates an already-valid published fence even with zero intervening SSE ingress.
        let valid_before_retry = wire.inbox.fence(wire.inbox.capture(), 0);
        assert!(valid_before_retry.is_valid());
        wire.inbox.invalidate_published();
        assert!(
            !valid_before_retry.is_valid(),
            "Retry invalidation must revoke a valid published fence without SSE ingress"
        );
        // Unapplied inbox ingress blocks starting a new GET until recovery drains the watermark.
        let mark1 = wire.inbox.record_ingress();
        let mark2 = wire.inbox.record_ingress();
        assert!(
            reader.inbox_deadline(true, &wire, None).is_none(),
            "inbox_deadline must wait while applied watermark lags ingress"
        );
        // Retry invalidates published state without jumping applied past buffered SSE frames.
        wire.inbox.invalidate_published();
        assert!(
            !wire.inbox.applied_caught_up(),
            "Retry invalidation must not mark buffered SSE frames as applied"
        );
        assert!(
            reader.inbox_deadline(true, &wire, None).is_none(),
            "inbox_deadline must remain blocked until buffered SSE frames are applied"
        );
        wire.inbox.advance_applied(mark1);
        assert!(
            reader.inbox_deadline(true, &wire, None).is_none(),
            "inbox_deadline must stay blocked until the latest buffered mark is applied"
        );
        wire.inbox.advance_applied(mark2);
        assert!(
            reader.inbox_deadline(true, &wire, None).is_some(),
            "inbox_deadline must resume once applied watermark catches up"
        );
    }
}

mod pages;
