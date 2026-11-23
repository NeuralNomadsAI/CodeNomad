//! One serialized HTTP lane. SSE is a hint stream; recovery publishes authoritative native windows.
pub mod demand;
use crate::{
    Receiver, Sender,
    runtime::{self, Instant},
};
use crate::{
    backend::Backend,
    content::{self, Part, TextFit, TextProvenance},
    history, stream,
    transport::{Command, Event, publish},
};
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, atomic::Ordering::SeqCst},
    time::Duration,
};
pub enum Input {
    Command(Command),
    Opened(u64),
    Native(u64, u64, Value),
    Workspace(u64, crate::transport::WorkspaceEvent),
    Preferences(crate::settings::Owner),
    Hint(u64, u64),
    Unavailable(u64),
    AuthenticationRequired(u64),
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
pub async fn run(
    backend: Backend,
    out: Sender<Event>,
    commands: Receiver<Command>,
    wake: crate::Wake,
) -> history::Result<()> {
    let (tx, rx) = crate::bounded(128);
    let forward = tx.clone();
    runtime::spawn(async move {
        while let Ok(command) = commands.recv().await {
            if forward.send(Input::Command(command)).await.is_err() {
                break;
            }
        }
        let _ = forward.send(Input::Command(Command::Close)).await;
    });
    let mut epoch = 1;
    let make_wire = || {
        Arc::new(stream::State::observing_preferences(
            out.clone(),
            wake.clone(),
        ))
    };
    let mut wire = make_wire();
    stream::start(backend.clone(), epoch, tx.clone(), wire.clone());
    let mut opened = false;
    let mut dirty = true;
    let mut initial = true;
    let mut fence = 0;
    let mut first: Option<String> = None;
    let mut older: Option<Value> = None;
    let mut known = HashSet::<String>::new();
    let mut owed = HashSet::<(String, usize)>::new();
    let mut repairs = 0u8;
    let mut settlement_reads = 0u8;
    let mut resident = Vec::<crate::Message>::new();
    let mut parked = false;
    let mut connection_lost = false;
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
            repairs = 0;
            settlement_reads = 0;
            wire = make_wire();
            stream::start(backend.clone(), epoch, tx.clone(), wire.clone());
        }
        match runtime::recv_timeout(&rx, Duration::from_millis(25)).await {
            Some(Input::Workspace(e, event)) if e == epoch => {
                if !publish(&out, &wake, Event::Workspace(event)).await {
                    wire.cancelled.store(true, SeqCst);
                    return Ok(());
                }
            }
            Some(Input::Command(Command::Close)) => {
                wire.cancelled.store(true, SeqCst);
                return Ok(());
            }
            Some(Input::Opened(e)) if e == epoch => {
                opened = true;
                publish(&out, &wake, Event::AgentHint(true)).await;
                dirty = true;
                parked = false;
                quiet = Instant::now() + Duration::from_millis(100);
            }
            Some(Input::Closed(e)) if e == epoch => {
                opened = false;
                connection_lost = true;
                dirty = true;
                publish(&out, &wake, Event::ConnectionLost).await;
                attempts = attempts.saturating_add(1);
                retry =
                    Some(Instant::now() + Duration::from_millis(250 * (1u64 << attempts.min(4))));
                if attempts <= 6 {
                    publish(&out, &wake, Event::Reconnecting).await;
                } else if attempts == 7 {
                    // Keep the same subscription owner after showing the outage.
                    publish(&out, &wake, Event::Failed).await;
                }
            }
            Some(Input::AuthenticationRequired(e)) if e == epoch => {
                publish(&out, &wake, Event::AuthenticationRequired(backend.clone())).await;
                return Ok(());
            }
            Some(Input::Unavailable(e)) if e == epoch => {
                dirty = true;
                publish(&out, &wake, Event::Reconnecting).await;
            }
            Some(Input::Hint(e, v)) if e == epoch && v > fence => {
                dirty = true;
                quiet = Instant::now() + Duration::from_millis(100);
                publish(&out, &wake, Event::Reconnecting).await;
            }
            Some(Input::Command(Command::Retry)) => {
                attempts = 0;
                dirty = true;
                parked = false;
                quiet = Instant::now();
                if !wire.alive.load(SeqCst) {
                    retry = Some(Instant::now());
                }
                publish(&out, &wake, Event::Reconnecting).await;
            }
            Some(Input::Command(Command::Older)) => {
                if let Some(target) = older
                    .clone()
                    .filter(|_| opened && !dirty && wire.upstream.load(SeqCst))
                {
                    let stamp = wire.version.load(SeqCst);
                    match backend.page(target).await {
                        Ok(page) if wire.valid(stamp) && rx.is_empty() => {
                            if let Ok(joined) = history::join(&page.rows, &resident) {
                                resident = joined;
                                older = page.older.clone();
                                first = resident.first().map(|r| r.id.clone());
                                known.extend(page.rows.iter().map(|r| r.id.clone()));
                                publish(&out, &wake, Event::Older(page)).await;
                            } else {
                                publish(&out, &wake, Event::PagingFailed).await;
                            }
                        }
                        Ok(_) => {
                            dirty = true;
                            quiet = Instant::now() + Duration::from_millis(100);
                            publish(&out, &wake, Event::PagingFailed).await;
                        }
                        Err(_) => {
                            publish(&out, &wake, Event::PagingFailed).await;
                        }
                    }
                } else {
                    publish(&out, &wake, Event::PagingFailed).await;
                }
            }
            Some(Input::Command(Command::Send(body))) => {
                if opened && !dirty && !parked && wire.upstream.load(SeqCst) {
                    busy = true;
                    repairs = 0;
                    settlement_reads = 0;
                    let result = backend.send(body).await;
                    if let Err(error) = &result {
                        if crate::http::authentication_expired(error) {
                            wire.cancelled.store(true, SeqCst);
                            while wire.alive.load(SeqCst) {
                                runtime::sleep(Duration::from_millis(25)).await;
                            }
                            publish(&out, &wake, Event::AuthenticationRequired(backend.clone()))
                                .await;
                            return Ok(());
                        }
                        eprintln!("Rune prompt delivery failed");
                    }
                    let rejected = result.is_err();
                    publish(&out, &wake, Event::PromptSettled { rejected }).await;
                    if rejected {
                        publish(&out, &wake, Event::Failed).await;
                    }
                } else {
                    publish(&out, &wake, Event::PromptSettled { rejected: true }).await;
                    publish(&out, &wake, Event::Failed).await;
                }
            }
            Some(Input::Native(e, v, native)) if e == epoch => {
                let kind = native["type"].as_str().unwrap_or_default();
                if kind.starts_with("permission.")
                    || kind.starts_with("form.")
                    || kind.contains("model")
                {
                    publish(&out, &wake, Event::AgentHint(false)).await;
                }
                if v <= fence || !seen.insert(&native) {
                    continue;
                }
                let id = native["data"]["assistantMessageID"]
                    .as_str()
                    .unwrap_or_default();
                match kind {
                    "session.step.started" => {
                        if let Some(prior) = resident.iter().find(|row| row.id == id) {
                            if !can_restart(prior) {
                                if !dirty && repairs < 3 {
                                    repairs += 1;
                                    dirty = true;
                                    quiet = Instant::now() + Duration::from_millis(100);
                                }
                                continue;
                            }
                        }
                        if !busy {
                            repairs = 0;
                            settlement_reads = 0;
                        }
                        busy = true;
                        if let Some(Event::Message(row)) = crate::wire::decode_native(&native) {
                            if known.insert(row.id.clone()) {
                                if resident.len() >= history::MAX_ROWS {
                                    return Err("resident row budget reached".into());
                                }
                                resident.push(row.clone());
                                publish(&out, &wake, Event::Message(row)).await;
                            }
                        }
                    }
                    "session.text.started" | "session.text.delta" | "session.text.ended" => {
                        let Some(Event::Text(_, event)) = crate::wire::decode_native(&native)
                        else {
                            continue;
                        };
                        let row = resident.iter_mut().find(|r| r.id == id);
                        let ordinal = event.ordinal().or_else(|| {
                            row.as_ref().and_then(|r| {
                                r.parts
                                    .iter()
                                    .filter(|p| matches!(p, Part::Text(_)))
                                    .count()
                                    .checked_sub(1)
                            })
                        });
                        let fit = match row {
                            Some(row) => content::apply_text(row, &event)?,
                            None => TextFit::Repair,
                        };
                        if event.is_end() && fit == TextFit::Applied {
                            if let Some(ordinal) = ordinal {
                                owed.remove(&(id.into(), ordinal));
                            }
                        }
                        if matches!(fit, TextFit::Repair | TextFit::Settlement) {
                            if let Some(ordinal) = ordinal {
                                if owed.len() >= 4096 && !owed.contains(&(id.into(), ordinal)) {
                                    return Err("text repair target limit reached".into());
                                }
                                owed.insert((id.into(), ordinal));
                            }
                        }
                        if fit == TextFit::Repair && !dirty && repairs < 3 {
                            repairs += 1;
                            dirty = true;
                            quiet = Instant::now() + Duration::from_millis(100);
                        }
                        if matches!(fit, TextFit::Applied | TextFit::Settlement) {
                            history::check(&resident)?;
                            publish(&out, &wake, Event::Text(id.into(), event)).await;
                        }
                    }
                    kind if kind.starts_with("session.tool.") => {
                        dirty = true;
                        quiet = Instant::now() + Duration::from_millis(100);
                    }
                    "session.execution.succeeded"
                    | "session.execution.failed"
                    | "session.execution.interrupted" => {
                        terminal = busy;
                        dirty = true;
                        quiet = Instant::now() + Duration::from_millis(100);
                    }
                    "session.deleted" | "session.moved" | "session.revert.committed" => {
                        publish(&out, &wake, Event::Failed).await;
                        return Err("session scope or history changed".into());
                    }
                    "server.connected" | "session.inbox.enqueued" | "session.inbox.delivered" => {
                        dirty = true;
                        quiet = Instant::now() + Duration::from_millis(100);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        if dirty
            && !parked
            && opened
            && wire.upstream.load(SeqCst)
            && Instant::now() >= quiet
            && rx.is_empty()
        {
            let stamp = wire.version.load(SeqCst);
            let snapshot = if initial && backend.fresh_mode {
                backend.empty().await
            } else if backend.fresh_mode {
                backend.fresh(first.as_deref()).await
            } else {
                backend.restore(first.as_deref()).await
            };
            match snapshot {
                Ok(mut page) if wire.valid(stamp) && rx.is_empty() => {
                    content::merge_page(&resident, &mut page.rows)?;
                    owed.retain(|(id, ordinal)| {
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
                    fence = stamp;
                    attempts = 0;
                    connection_lost = false;
                    dirty = false;
                    initial = false;
                    first = page.rows.first().map(|r| r.id.clone());
                    older = page.older.clone();
                    known = page.rows.iter().map(|r| r.id.clone()).collect();
                    resident = page.rows.clone();
                    let done = (terminal || busy) && !page.running;
                    if done && !owed.is_empty() {
                        settlement_reads += 1;
                        if settlement_reads > 3 {
                            return Err("text settlement remains unconfirmed".into());
                        }
                        dirty = true;
                        quiet = Instant::now() + Duration::from_millis(100);
                        continue;
                    }
                    busy = page.running;
                    terminal = false;
                    if !publish(&out, &wake, Event::Sync(page)).await {
                        return Ok(());
                    }
                    if done {
                        publish(&out, &wake, Event::Done).await;
                    }
                }
                Ok(_) => {
                    quiet = Instant::now() + Duration::from_millis(200);
                }
                Err(error) => {
                    if cfg!(target_arch = "wasm32")
                        && connection_lost
                        && matches!(
                            backend.workspace_missing(&backend.workspace).await,
                            Ok(true)
                        )
                    {
                        wire.cancelled.store(true, SeqCst);
                        publish(&out, &wake, Event::WorkspaceMissing).await;
                        return Ok(());
                    }
                    eprintln!("Rune history refresh failed: {}", read_diagnostic(&error));
                    dirty = false;
                    parked = true;
                    publish(&out, &wake, Event::Failed).await;
                }
            }
        }
    }
}
fn can_restart(row: &crate::Message) -> bool {
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
