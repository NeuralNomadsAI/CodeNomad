//! One serialized HTTP lane. SSE is a hint stream; recovery publishes authoritative native windows.
use crate::{
    backend::Backend,
    history, stream,
    transport::{Command, Event, publish},
};
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    sync::{
        Arc,
        atomic::Ordering::SeqCst,
        mpsc::{self, Receiver, SyncSender},
    },
    time::{Duration, Instant},
};
pub enum Input {
    Command(Command),
    Opened(u64),
    Native(u64, u64, Value),
    Hint(u64, u64),
    Unavailable(u64),
    Closed(u64),
}
struct Seen {
    entries: VecDeque<String>,
    bytes: usize,
}
impl Seen {
    fn insert(&mut self, event: &Value) -> bool {
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
pub fn run(
    backend: Backend,
    out: SyncSender<Event>,
    commands: Receiver<Command>,
    wake: rune::Waker,
) -> history::Result<()> {
    let (tx, rx) = mpsc::sync_channel(128);
    let forward = tx.clone();
    std::thread::spawn(move || {
        while let Ok(command) = commands.recv() {
            if forward.send(Input::Command(command)).is_err() {
                break;
            }
        }
        let _ = forward.send(Input::Command(Command::Close));
    });
    let mut epoch = 1;
    let mut wire = Arc::new(stream::State::default());
    stream::start(backend.clone(), epoch, tx.clone(), wire.clone());
    let mut opened = false;
    let mut dirty = true;
    let mut initial = true;
    let mut fence = 0;
    let mut first: Option<String> = None;
    let mut older: Option<Value> = None;
    let mut known = HashSet::<String>::new();
    let mut seeded = HashSet::<String>::new();
    let mut resident = Vec::<crate::Message>::new();
    let mut parked = false;
    let mut seen = Seen {
        entries: VecDeque::new(),
        bytes: 0,
    };
    let mut busy = false;
    let mut terminal = false;
    let mut retry = None;
    let mut attempts = 0u32;
    let mut quiet = Instant::now();
    loop {
        if retry.is_some_and(|at| Instant::now() >= at) {
            retry = None;
            epoch += 1;
            wire = Arc::new(stream::State::default());
            stream::start(backend.clone(), epoch, tx.clone(), wire.clone());
        }
        match rx.recv_timeout(Duration::from_millis(25)) {
            Ok(Input::Command(Command::Close)) => {
                wire.cancelled.store(true, SeqCst);
                return Ok(());
            }
            Ok(Input::Opened(e)) if e == epoch => {
                opened = true;
                dirty = true;
                parked = false;
                quiet = Instant::now() + Duration::from_millis(100);
            }
            Ok(Input::Closed(e)) if e == epoch => {
                opened = false;
                dirty = true;
                publish(&out, &wake, Event::Reconnecting);
                attempts += 1;
                if attempts <= 6 {
                    retry = Some(
                        Instant::now() + Duration::from_millis(250 * (1u64 << attempts.min(4))),
                    );
                } else {
                    publish(&out, &wake, Event::Failed);
                }
            }
            Ok(Input::Unavailable(e)) if e == epoch => {
                dirty = true;
                publish(&out, &wake, Event::Reconnecting);
            }
            Ok(Input::Hint(e, v)) if e == epoch && v > fence => {
                dirty = true;
                quiet = Instant::now() + Duration::from_millis(100);
                publish(&out, &wake, Event::Reconnecting);
            }
            Ok(Input::Command(Command::Retry)) => {
                attempts = 0;
                dirty = true;
                parked = false;
                quiet = Instant::now();
                if !wire.alive.load(SeqCst) {
                    retry = Some(Instant::now());
                }
                publish(&out, &wake, Event::Reconnecting);
            }
            Ok(Input::Command(Command::Older)) => {
                if let Some(target) = older
                    .clone()
                    .filter(|_| opened && !dirty && wire.upstream.load(SeqCst))
                {
                    let stamp = wire.version.load(SeqCst);
                    match backend.page(target) {
                        Ok(page) if wire.valid(stamp) => {
                            if let Ok(joined) = history::join(&page.rows, &resident) {
                                resident = joined;
                                older = page.older.clone();
                                first = resident.first().map(|r| r.id.clone());
                                seeded.extend(page.rows.iter().map(|r| r.id.clone()));
                                known.extend(seeded.iter().cloned());
                                publish(&out, &wake, Event::Older(page));
                            } else {
                                publish(&out, &wake, Event::PagingFailed);
                            }
                        }
                        Ok(_) => {
                            dirty = true;
                            quiet = Instant::now() + Duration::from_millis(100);
                            publish(&out, &wake, Event::PagingFailed);
                        }
                        Err(_) => {
                            publish(&out, &wake, Event::PagingFailed);
                        }
                    }
                } else {
                    publish(&out, &wake, Event::PagingFailed);
                }
            }
            Ok(Input::Command(Command::Send(body))) => {
                if opened && !dirty && !parked && wire.upstream.load(SeqCst) {
                    busy = true;
                    if let Err(error) = backend.send(body) {
                        eprintln!("Rune send: {error}");
                        publish(&out, &wake, Event::Failed);
                    }
                } else {
                    publish(&out, &wake, Event::Failed);
                }
            }
            Ok(Input::Native(e, v, native)) if e == epoch && v > fence && seen.insert(&native) => {
                let kind = native["type"].as_str().unwrap_or_default();
                let id = native["data"]["assistantMessageID"]
                    .as_str()
                    .unwrap_or_default();
                match kind {
                    "session.step.started" => {
                        busy = true;
                        if let Some(Event::Message(row)) = crate::wire::decode_native(&native) {
                            if known.insert(row.id.clone()) {
                                if resident.len() >= history::MAX_ROWS {
                                    return Err("resident row budget reached".into());
                                }
                                resident.push(row.clone());
                                publish(&out, &wake, Event::Message(row));
                            }
                        }
                    }
                    "session.text.delta" => {
                        if !known.contains(id) || seeded.contains(id) {
                            dirty = true;
                            quiet = Instant::now() + Duration::from_millis(100);
                        } else if let Some(delta) = native["data"]["delta"].as_str() {
                            if let Some(row) = resident.iter_mut().find(|r| r.id == id) {
                                if row.body.len() + delta.len() > 256 * 1024 {
                                    return Err("live text budget reached".into());
                                }
                                row.body.push_str(delta);
                            }
                            history::check(&resident)?;
                            publish(&out, &wake, Event::Delta(id.into(), delta.into()));
                        }
                    }
                    "session.execution.succeeded"
                    | "session.execution.failed"
                    | "session.execution.interrupted" => {
                        terminal = busy;
                        dirty = true;
                        quiet = Instant::now() + Duration::from_millis(100);
                    }
                    "session.deleted" | "session.moved" | "session.revert.committed" => {
                        publish(&out, &wake, Event::Failed);
                        return Err("session scope or history changed".into());
                    }
                    "server.connected"
                    | "session.inbox.enqueued"
                    | "session.inbox.delivered"
                    | "session.text.ended" => {
                        dirty = true;
                        quiet = Instant::now() + Duration::from_millis(100);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        if dirty && !parked && opened && wire.upstream.load(SeqCst) && Instant::now() >= quiet {
            let stamp = wire.version.load(SeqCst);
            let snapshot = if initial && backend.fresh_mode {
                backend.empty()
            } else if backend.fresh_mode {
                backend.fresh(first.as_deref())
            } else {
                backend.restore(first.as_deref())
            };
            match snapshot {
                Ok(page) if wire.valid(stamp) => {
                    fence = stamp;
                    attempts = 0;
                    dirty = false;
                    initial = false;
                    first = page.rows.first().map(|r| r.id.clone());
                    older = page.older.clone();
                    seeded = page.rows.iter().map(|r| r.id.clone()).collect();
                    known = seeded.clone();
                    resident = page.rows.clone();
                    let done = (terminal || busy) && !page.running;
                    busy = page.running;
                    terminal = false;
                    if !publish(&out, &wake, Event::Sync(page)) {
                        return Ok(());
                    }
                    if done {
                        publish(&out, &wake, Event::Done);
                    }
                }
                Ok(_) => {
                    quiet = Instant::now() + Duration::from_millis(200);
                }
                Err(error) => {
                    eprintln!("Rune recovery: {error}");
                    dirty = false;
                    parked = true;
                    publish(&out, &wake, Event::Failed);
                }
            }
        }
    }
}
