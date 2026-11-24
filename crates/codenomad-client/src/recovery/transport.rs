//! Serialized command and SSE transport, epoch ownership and reconnect scheduling.
use super::{
    Input, ReadingLane,
    reader::{Lane, Reader, Turn, can_restart, reader_event},
    receipts,
};
use crate::{
    Receiver, Sender,
    backend::Backend,
    content::{self, Part, TextFit},
    history,
    runtime::{self, Instant},
    stream,
    transport::{Command, Event, PromptOutcome, publish},
};
use std::{
    sync::{Arc, atomic::Ordering::SeqCst},
    time::Duration,
};

pub(crate) async fn run_with_reading(
    backend: Backend,
    out: Sender<Event>,
    commands: Receiver<Command>,
    wake: crate::Wake,
    reading: Option<ReadingLane>,
) -> history::Result<()> {
    let reading = reading.as_ref();
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
    let mut workspace_unavailable = false;
    let mut connection_lost = false;
    let mut connection_closed = false;
    let mut retry = None;
    let mut attempts = 0u32;
    let mut reader = Reader::new();
    loop {
        let input = runtime::recv_timeout(&rx, Duration::from_millis(25)).await;
        reader.demand(reading);
        if retry.is_some_and(|at| Instant::now() >= at) {
            retry = None;
            connection_closed = false;
            epoch += 1;
            reader.fence = 0;
            reader.repairs = 0;
            reader.settlement_reads = 0;
            wire = make_wire();
            stream::start(backend.clone(), epoch, tx.clone(), wire.clone());
        }
        match input {
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
                attempts = 0;
                if !workspace_unavailable {
                    publish(&out, &wake, Event::AgentHint(true)).await;
                }
                reader.dirty = true;
                reader.parked = false;
                reader.quiet = Instant::now() + Duration::from_millis(100);
            }
            Some(Input::Closed(e)) if e == epoch => {
                ReadingLane::invalidate_connection(reading);
                opened = false;
                connection_closed = true;
                connection_lost = true;
                reader.dirty = true;
                publish(&out, &wake, Event::ConnectionLost).await;
                attempts = attempts.saturating_add(1);
                retry =
                    Some(Instant::now() + Duration::from_millis(250 * (1u64 << attempts.min(4))));
                if attempts <= 6 {
                    publish(&out, &wake, Event::Reconnecting).await;
                } else if attempts == 7 && reading.is_none() {
                    // Keep the same subscription owner after showing the outage.
                    publish(&out, &wake, Event::Failed).await;
                }
            }
            Some(Input::AuthenticationRequired(e)) if e == epoch => {
                publish(&out, &wake, Event::authentication_required(backend.clone())).await;
                return Ok(());
            }
            Some(Input::Unavailable(e)) if e == epoch => {
                workspace_unavailable = true;
                ReadingLane::invalidate_connection(reading);
                reader.dirty = true;
                if reading.is_some() || !reader.historical {
                    publish(&out, &wake, Event::Reconnecting).await;
                }
            }
            Some(Input::Available(e, v)) if e == epoch => {
                let recovered = std::mem::replace(&mut workspace_unavailable, false);
                if reading.is_some() {
                    publish(&out, &wake, Event::AgentHint(true)).await;
                } else if v > reader.fence && !reader.historical {
                    publish(&out, &wake, Event::Reconnecting).await;
                } else if recovered {
                    publish(&out, &wake, Event::AgentHint(true)).await;
                }
                reader.dirty = true;
                reader.parked = false;
                reader.quiet = Instant::now() + Duration::from_millis(100);
            }
            Some(Input::Hint(e, v)) if e == epoch && v > reader.fence => {
                reader.dirty = true;
                reader.quiet = Instant::now() + Duration::from_millis(100);
                if reading.is_none() && !reader.historical {
                    publish(&out, &wake, Event::Reconnecting).await;
                }
            }
            Some(Input::Command(Command::Retry)) => {
                ReadingLane::invalidate_connection(reading);
                attempts = 0;
                reader.dirty = true;
                reader.parked = false;
                reader.quiet = Instant::now();
                if connection_closed {
                    retry = Some(Instant::now());
                }
                publish(&out, &wake, Event::Reconnecting).await;
            }
            Some(Input::Command(Command::Older)) => {
                let lane = Lane {
                    backend: &backend,
                    reading,
                    rx: &rx,
                    wire: &wire,
                    out: &out,
                    wake: &wake,
                };
                match reader.older(&lane, opened).await? {
                    Turn::Process => {}
                    Turn::Next => continue,
                    Turn::Stop => return Ok(()),
                }
            }
            Some(Input::Command(Command::Latest)) => {
                reader.clear_window();
                reader.dirty = true;
                reader.parked = false;
                reader.quiet = Instant::now();
                if connection_closed {
                    retry = Some(Instant::now());
                }
                publish(&out, &wake, Event::Reconnecting).await;
            }
            Some(Input::Command(Command::Slash {
                attempt,
                name,
                text,
            })) => {
                let admitted = reading.is_some()
                    || opened && !reader.parked && !reader.historical && wire.upstream.load(SeqCst);
                if !receipts::slash(&backend, &out, &wake, &wire, admitted, attempt, name, text)
                    .await
                {
                    return Ok(());
                }
            }
            Some(Input::Command(Command::Prompt(prompt))) => {
                let Some(id) = &prompt.id else { continue };
                // The compose gesture owns one attempt even if its tab suspends before dispatch.
                let admitted = reading.is_some()
                    || opened && !reader.parked && !reader.historical && wire.upstream.load(SeqCst);
                let Some(outcome) =
                    receipts::prompt(&backend, &out, &wake, &wire, admitted, id, &prompt).await
                else {
                    return Ok(());
                };
                if !matches!(outcome, PromptOutcome::Rejected)
                    && !reader.busy
                    && prompt.delivery != Some(crate::prompt::Delivery::Queue)
                {
                    reader.busy = true;
                    reader.repairs = 0;
                    reader.settlement_reads = 0;
                }
                if matches!(outcome, PromptOutcome::Unconfirmed) {
                    reader.dirty = true;
                    reader.quiet = Instant::now();
                }
                publish(
                    &out,
                    &wake,
                    Event::PromptAcknowledged {
                        attempted: id.clone(),
                        outcome,
                    },
                )
                .await;
            }
            Some(Input::Native(e, v, native)) if e == epoch => {
                let kind = native["type"].as_str().unwrap_or_default();
                if native["data"]["sessionID"] != backend.session
                    && let Some(change) = content::FamilyChange::decode(&native)
                {
                    publish(&out, &wake, Event::FamilyUsage(change)).await;
                    continue;
                }
                if kind == "session.moved" {
                    if native["data"]["sessionID"] != backend.session {
                        continue;
                    }
                    wire.cancelled.store(true, SeqCst);
                    publish(
                        &out,
                        &wake,
                        Event::Workspace(crate::transport::WorkspaceEvent::SessionMoved {
                            workspace_id: backend.workspace.clone(),
                            session_id: backend.session.clone(),
                        }),
                    )
                    .await;
                    return Err("session scope changed".into());
                }
                if kind.starts_with("permission.")
                    || kind.starts_with("form.")
                    || kind.contains("model")
                {
                    publish(&out, &wake, Event::AgentHint(false)).await;
                }
                if kind == "session.usage.updated" {
                    if let Some(usage) = content::Usage::decode(&native["data"]) {
                        publish(&out, &wake, Event::SessionUsage(usage)).await;
                    }
                    continue;
                }
                if matches!(kind, "session.deleted" | "session.revert.committed") {
                    publish(&out, &wake, Event::HistoryInvalidated).await;
                    if kind == "session.deleted" {
                        wire.cancelled.store(true, SeqCst);
                        return Err("session scope changed".into());
                    }
                    reader.clear_window_on_revert();
                    reader.parked = false;
                    reader.dirty = reader.active_reader;
                    reader.quiet = Instant::now();
                    continue;
                }
                if !reader.active_reader || reading.is_some() && reader.historical {
                    match kind {
                        "session.step.started" => {
                            reader.busy = true;
                            publish(
                                &out,
                                &wake,
                                Event::ObservedRunning {
                                    running: true,
                                    version: v,
                                },
                            )
                            .await;
                        }
                        "session.execution.succeeded"
                        | "session.execution.failed"
                        | "session.execution.interrupted" => {
                            reader.busy = false;
                            publish(
                                &out,
                                &wake,
                                Event::ObservedRunning {
                                    running: false,
                                    version: v,
                                },
                            )
                            .await;
                        }
                        _ => {}
                    }
                    continue;
                }
                if v <= reader.fence || !reader.seen.insert(&native) {
                    continue;
                }
                if reader.historical {
                    continue;
                }
                let id = native["data"]["assistantMessageID"]
                    .as_str()
                    .unwrap_or_default();
                match kind {
                    "session.step.started" => {
                        if let Some(prior) = reader.resident.iter().find(|row| row.id == id) {
                            if !can_restart(prior) {
                                if !reader.dirty && reader.repairs < 3 {
                                    reader.repairs += 1;
                                    reader.dirty = true;
                                    reader.quiet = Instant::now() + Duration::from_millis(100);
                                }
                                continue;
                            }
                        }
                        if !reader.busy {
                            reader.repairs = 0;
                            reader.settlement_reads = 0;
                        }
                        reader.busy = true;
                        if reading.is_some() {
                            publish(
                                &out,
                                &wake,
                                Event::ObservedRunning {
                                    running: true,
                                    version: v,
                                },
                            )
                            .await;
                        }
                        if let Some(Event::Message(row)) = crate::wire::decode_native(&native) {
                            if reader.known.insert(row.id.clone()) {
                                if reader.resident.len() >= history::MAX_ROWS {
                                    return Err("resident row budget reached".into());
                                }
                                reader.resident.push(row.clone().into());
                                reader_event(
                                    reading,
                                    reader.generation,
                                    &out,
                                    &wake,
                                    Event::Message(row),
                                )
                                .await;
                            }
                        }
                    }
                    "session.step.ended" => {
                        if let Some(usage) = content::Usage::decode(&native["data"])
                            && let Some(row) = reader
                                .resident
                                .iter_mut()
                                .find(|row| row.id == id && !row.completed)
                        {
                            Arc::make_mut(row).usage = Some(usage);
                            reader_event(
                                reading,
                                reader.generation,
                                &out,
                                &wake,
                                Event::StepUsage(id.into(), usage),
                            )
                            .await;
                        }
                    }
                    "session.text.started" | "session.text.delta" | "session.text.ended" => {
                        let Some(Event::Text(_, event)) = crate::wire::decode_native(&native)
                        else {
                            continue;
                        };
                        let row = reader.resident.iter_mut().find(|r| r.id == id);
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
                            Some(row) => content::apply_text(Arc::make_mut(row), &event)?,
                            None => TextFit::Repair,
                        };
                        if event.is_end() && fit == TextFit::Applied {
                            if let Some(ordinal) = ordinal {
                                reader.owed.remove(&(id.into(), ordinal));
                            }
                        }
                        if matches!(fit, TextFit::Repair | TextFit::Settlement) {
                            if let Some(ordinal) = ordinal {
                                if reader.owed.len() >= 4096
                                    && !reader.owed.contains(&(id.into(), ordinal))
                                {
                                    return Err("text repair target limit reached".into());
                                }
                                reader.owed.insert((id.into(), ordinal));
                            }
                        }
                        if fit == TextFit::Repair && !reader.dirty && reader.repairs < 3 {
                            reader.repairs += 1;
                            reader.dirty = true;
                            reader.quiet = Instant::now() + Duration::from_millis(100);
                        }
                        if matches!(fit, TextFit::Applied | TextFit::Settlement) {
                            history::check(&reader.resident)?;
                            reader_event(
                                reading,
                                reader.generation,
                                &out,
                                &wake,
                                Event::Text(id.into(), event),
                            )
                            .await;
                        }
                    }
                    "session.reasoning.started"
                    | "session.reasoning.delta"
                    | "session.reasoning.ended" => {
                        let Some(Event::Reasoning(id, event)) = crate::wire::decode_native(&native)
                        else {
                            continue;
                        };
                        match content::apply_reasoning(&mut reader.resident, &id, &event) {
                            TextFit::Applied => {
                                history::check(&reader.resident)?;
                                reader_event(
                                    reading,
                                    reader.generation,
                                    &out,
                                    &wake,
                                    Event::Reasoning(id, event),
                                )
                                .await;
                            }
                            TextFit::Repair if !reader.dirty && reader.repairs < 3 => {
                                reader.repairs += 1;
                                reader.dirty = true;
                                reader.quiet = Instant::now() + Duration::from_millis(100);
                            }
                            _ => {}
                        }
                    }
                    kind if kind.starts_with("session.tool.") => {
                        let fit = reader
                            .resident
                            .iter_mut()
                            .find(|row| row.id == id)
                            .map_or(content::ToolFit::Repair, |row| {
                                content::apply_tool(Arc::make_mut(row), kind, &native["data"])
                            });
                        match fit {
                            content::ToolFit::Applied(tool) => {
                                history::check(&reader.resident)?;
                                reader_event(
                                    reading,
                                    reader.generation,
                                    &out,
                                    &wake,
                                    Event::Tool(id.into(), tool),
                                )
                                .await;
                            }
                            content::ToolFit::Drop => {}
                            content::ToolFit::Repair => {
                                reader.dirty = true;
                                reader.quiet = Instant::now() + Duration::from_millis(100);
                            }
                        }
                    }
                    "session.execution.succeeded"
                    | "session.execution.failed"
                    | "session.execution.interrupted" => {
                        reader.terminal = reader.busy;
                        if reading.is_some() {
                            publish(
                                &out,
                                &wake,
                                Event::ObservedRunning {
                                    running: false,
                                    version: v,
                                },
                            )
                            .await;
                        }
                        reader.parked = false;
                        reader.dirty = true;
                        reader.quiet = Instant::now() + Duration::from_millis(100);
                    }
                    "server.connected" | "session.inbox.enqueued" | "session.inbox.delivered" => {
                        reader.dirty = true;
                        reader.quiet = Instant::now() + Duration::from_millis(100);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        let lane = Lane {
            backend: &backend,
            reading,
            rx: &rx,
            wire: &wire,
            out: &out,
            wake: &wake,
        };
        if matches!(
            reader
                .sync(
                    &lane,
                    opened && !workspace_unavailable,
                    &mut connection_lost
                )
                .await?,
            Turn::Stop
        ) {
            return Ok(());
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn reopening_host_sse_while_workspace_unavailable_withholds_agent_hint_until_available() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (reopened_tx, reopened_rx) = tokio::sync::oneshot::channel::<()>();
            let (avail_tx, avail_rx) = tokio::sync::oneshot::channel::<()>();
            let server = tokio::spawn(async move {
                let mut reopened_tx = Some(reopened_tx);
                let mut avail_rx = Some(avail_rx);
                let mut sse_count = 0usize;
                while let Ok((mut socket, _)) = listener.accept().await {
                    let mut req = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                        let n = socket.read(&mut buf).await.unwrap();
                        if n == 0 {
                            break;
                        }
                        req.extend_from_slice(&buf[..n]);
                    }
                    let head = String::from_utf8_lossy(&req);
                    if head.starts_with("POST /api/client-connections/pong") {
                        let _ = socket
                            .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .await;
                        continue;
                    }
                    if !head.starts_with("GET /api/events?") {
                        let _ = socket
                            .write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                            .await;
                        continue;
                    }
                    sse_count += 1;
                    if sse_count == 1 {
                        let body = "data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"ws-1\",\"status\":\"disconnected\"}\n\n";
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        let _ = socket.write_all(resp.as_bytes()).await;
                    } else {
                        let _ = socket
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")
                            .await;
                        let _ = socket
                            .write_all(b"data: {\"type\":\"codenomad.client.ping\",\"id\":\"p2\"}\n\n")
                            .await;
                        if let Some(tx) = reopened_tx.take() {
                            let _ = tx.send(());
                        }
                        if let Some(rx) = avail_rx.take() {
                            let _ = rx.await;
                            let _ = socket
                                .write_all(b"data: {\"type\":\"instance.eventStatus\",\"instanceId\":\"ws-1\",\"status\":\"connected\"}\n\n")
                                .await;
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                        break;
                    }
                }
            });

            let mut backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            backend.workspace = "ws-1".into();
            backend.session = "ses-1".into();
            let (out_tx, out_rx) = crate::bounded(64);
            let (cmd_tx, cmd_rx) = crate::bounded(8);
            let wake: crate::Wake = Arc::new(|| {});
            let (demand, observer) = super::super::demand::open();
            let (content, _snapshots) = crate::bounded(8);
            demand.publish(None);
            let reading = ReadingLane {
                demand: observer,
                events: content,
                connection: Default::default(),
            };
            let worker = tokio::spawn(run_with_reading(
                backend,
                out_tx,
                cmd_rx,
                wake,
                Some(reading),
            ));

            tokio::time::timeout(Duration::from_secs(5), reopened_rx)
                .await
                .unwrap()
                .unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
            let mut saw_loss = false;
            let mut rearmed_early = false;
            while let Ok(ev) = out_rx.try_recv() {
                match ev {
                    Event::ConnectionLost | Event::Reconnecting => saw_loss = true,
                    Event::AgentHint(true) if saw_loss => rearmed_early = true,
                    _ => {}
                }
            }
            assert!(saw_loss, "must observe workspace unavailability / loss");
            assert!(
                !rearmed_early,
                "reopening host SSE must not emit AgentHint(true) before workspace availability returns"
            );

            let _ = avail_tx.send(());
            let rearmed = tokio::time::timeout(Duration::from_secs(3), async {
                while let Ok(ev) = out_rx.recv().await {
                    if matches!(ev, Event::AgentHint(true)) {
                        return true;
                    }
                }
                false
            })
            .await
            .unwrap();
            assert!(rearmed, "workspace connected must re-arm AgentHint(true)");

            let _ = cmd_tx.send(Command::Close).await;
            let _ = tokio::time::timeout(Duration::from_secs(2), worker).await;
            server.abort();
        });
    }
}
