//! Demand generations, suspended reading, pagination and authoritative snapshots.
use super::{Input, authentication::expire_reading, demand};
use crate::{
    Receiver, Sender, Wake,
    backend::Backend,
    content::{self, Part, TextProvenance},
    history,
    runtime::Instant,
    stream,
    transport::{Event, publish},
};
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
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
    pub(super) seen: Seen,
    first: Option<String>,
    older: Option<Value>,
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
            seen: Seen {
                entries: VecDeque::new(),
                bytes: 0,
            },
            first: None,
            older: None,
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
        }
    }

    pub(super) fn demand(&mut self, reading: Option<&ReadingLane>) {
        if let Some(reading) = reading {
            let want = reading.demand.current();
            if want.generation != self.generation {
                self.generation = want.generation;
                self.active_reader = want.target.is_some();
                self.anchored = want.target;
                self.historical = false;
                self.resident = Vec::new();
                self.known = HashSet::new();
                self.owed = HashSet::new();
                self.seen.entries.clear();
                self.seen.bytes = 0;
                self.first = None;
                self.older = None;
                self.repairs = 0;
                self.settlement_reads = 0;
                self.dirty = self.active_reader;
                self.parked = false;
                self.quiet = Instant::now();
            }
        }
    }

    pub(super) fn clear_window(&mut self) {
        self.historical = false;
        self.anchored = None;
        self.first = None;
        self.resident.clear();
        self.known.clear();
        self.owed.clear();
    }

    pub(super) fn clear_window_on_revert(&mut self) {
        self.historical = false;
        self.anchored = None;
        self.resident.clear();
        self.first = None;
        self.known.clear();
        self.owed.clear();
    }

    pub(super) async fn older(
        &mut self,
        lane: &Lane<'_>,
        opened: bool,
        cancel: Option<&Receiver<()>>,
    ) -> history::Result<Turn> {
        let Lane {
            backend,
            reading,
            rx,
            wire,
            out,
            wake,
        } = *lane;
        let failed = || {
            cancel
                .cloned()
                .map_or(Event::PagingFailed, Event::OlderFailed)
        };
        if let Some(target) = self.older.clone().filter(|_| {
            self.active_reader
                && opened
                && (!self.dirty || self.historical)
                && wire.upstream.load(SeqCst)
        }) {
            let stamp = wire.version.load(SeqCst);
            let Some(page) = crate::timeline::until_cancelled(
                cancel,
                read_page(
                    backend,
                    reading,
                    self.generation,
                    wire,
                    backend.page(target),
                ),
            )
            .await
            else {
                return Ok(Turn::Next);
            };
            match page {
                Ok(page) if wire.valid(stamp) && rx.is_empty() => {
                    if history::previous_page(&page, &self.resident).is_ok() {
                        if !crate::timeline::older_offer(
                            cancel,
                            &page,
                            wire,
                            stamp,
                            async |event| {
                                reader_event(reading, self.generation, out, wake, event).await
                            },
                        )
                        .await
                        {
                            return Ok(Turn::Next);
                        }
                        if !page.rows.is_empty() {
                            self.historical = page.newer.is_some();
                            self.resident = page.rows.clone();
                            self.first = self.resident.first().map(|r| r.id.clone());
                            self.known = self.resident.iter().map(|r| r.id.clone()).collect();
                            self.owed.retain(|(id, _)| self.known.contains(id));
                        }
                        self.older = page.older.clone();
                        if cancel.is_none() {
                            reader_event(reading, self.generation, out, wake, Event::Older(page))
                                .await;
                        }
                    } else {
                        reader_event(reading, self.generation, out, wake, failed()).await;
                    }
                }
                Ok(_) => {
                    self.dirty = true;
                    self.quiet = Instant::now() + Duration::from_millis(100);
                    reader_event(reading, self.generation, out, wake, failed()).await;
                }
                Err(PageFailure::AuthenticationExpired) => {
                    expire_reading(backend, reading, wire, out, wake).await;
                    return Ok(Turn::Stop);
                }
                Err(PageFailure::Read(_)) => {
                    reader_event(reading, self.generation, out, wake, failed()).await;
                }
            }
        } else if self.active_reader {
            reader_event(reading, self.generation, out, wake, failed()).await;
        }
        Ok(Turn::Process)
    }

    pub(super) async fn anchor(
        &mut self,
        lane: &Lane<'_>,
        opened: bool,
        jump: crate::timeline::Jump,
    ) {
        if jump.cancelled.is_closed() {
            return;
        }
        let Lane {
            backend,
            wire,
            out,
            wake,
            ..
        } = *lane;
        if !self.active_reader || !opened || !wire.upstream.load(SeqCst) {
            publish(out, wake, Event::AnchorFailed(jump.ticket)).await;
            return;
        }
        if let Some((page, stamp)) = jump.offer(backend, &self.resident, wire, out, wake).await {
            self.historical = page.newer.is_some();
            self.fence = stamp;
            self.first = page.rows.first().map(|row| row.id.clone());
            self.older = page.older.clone();
            self.known = page.rows.iter().map(|row| row.id.clone()).collect();
            self.resident = page.rows;
            self.owed.retain(|(id, _)| self.known.contains(id));
            self.anchored = None;
            self.parked = false;
            self.dirty = false;
        }
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
        if self.active_reader
            && self.dirty
            && !self.parked
            && opened
            && wire.upstream.load(SeqCst)
            && !self.historical
            && Instant::now() >= self.quiet
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
                    content::merge_page(&self.resident, &mut page.rows)?;
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
                    self.known = page.rows.iter().map(|r| r.id.clone()).collect();
                    self.resident = page.rows.clone();
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
                    if done && reading.is_none() {
                        reader_event(reading, self.generation, out, wake, Event::Done).await;
                    }
                }
                Ok(_) => {
                    self.quiet = Instant::now() + Duration::from_millis(200);
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
                        wire.cancelled.store(true, SeqCst);
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

enum PageFailure {
    AuthenticationExpired,
    Read(history::Error),
}

async fn read_page(
    backend: &Backend,
    reading: Option<&ReadingLane>,
    generation: u64,
    wire: &stream::State,
    page: impl std::future::Future<Output = history::Result<history::Page>>,
) -> Option<Result<history::Page, PageFailure>> {
    let page = async {
        match page.await {
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
    let result = futures_lite::future::race(content, async {
        wire.placement_changed().await;
        None
    })
    .await;
    result
        .filter(|_| reading.is_none_or(|reading| reading.demand.current().generation == generation))
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
            text: String::new(),
            provenance: TextProvenance::Live,
        }));
        assert!(super::can_restart(&row));
        row.completed = true;
        assert!(!super::can_restart(&row));
        row.completed = false;
        row.parts[0] = Part::Text(Text {
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
}
