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

async fn reject_queued_commands(
    rx: &Receiver<Input>,
    commands: &Receiver<Command>,
    out: &Sender<Event>,
    wake: &crate::Wake,
) {
    let mut reject = |command: Command| match command {
        Command::Prompt(prompt) => prompt.id,
        Command::Slash { attempt, .. } => Some(attempt),
        _ => None,
    };
    while let Ok(queued) = rx.try_recv() {
        if let Input::Command(command) = queued
            && let Some(attempted) = reject(command)
        {
            publish(
                out,
                wake,
                Event::PromptAcknowledged {
                    attempted,
                    outcome: PromptOutcome::Rejected,
                },
            )
            .await;
        }
    }
    while let Ok(command) = commands.try_recv() {
        if let Some(attempted) = reject(command) {
            publish(
                out,
                wake,
                Event::PromptAcknowledged {
                    attempted,
                    outcome: PromptOutcome::Rejected,
                },
            )
            .await;
        }
    }
}

pub(crate) async fn run_with_reading(
    backend: Backend,
    out: Sender<Event>,
    commands: Receiver<Command>,
    wake: crate::Wake,
    reading: Option<ReadingLane>,
) -> history::Result<()> {
    let reading = reading.as_ref();
    let pending_commands = commands.clone();
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
    let provider_usage = backend
        .client
        .supports("provider-usage")
        .then(crate::provider_usage::Watch::default);
    if let Some(watch) = &provider_usage
        && !publish(&out, &wake, Event::ProviderUsageWatch(watch.clone())).await
    {
        return Ok(());
    }
    let make_wire = || {
        Arc::new(
            stream::State::observing_preferences(out.clone(), wake.clone())
                .with_provider_usage(provider_usage.clone()),
        )
    };
    let mut wire = make_wire();
    stream::start(backend.clone(), epoch, tx.clone(), wire.clone());
    let mut opened = false;
    let mut stream_gap = false;
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
                publish(&out, &wake, Event::AgentHint(true)).await;
                reader.dirty = true;
                reader.parked = false;
                reader.quiet = Instant::now() + Duration::from_millis(100);
            }
            Some(Input::Closed(e)) if e == epoch => {
                ReadingLane::invalidate_connection(reading);
                stream_gap = opened && wire.upstream.load(SeqCst);
                opened = false;
                connection_closed = true;
                connection_lost = true;
                reader.dirty = true;
                publish(&out, &wake, Event::ConnectionLost).await;
                attempts = attempts.saturating_add(1);
                retry =
                    Some(Instant::now() + Duration::from_millis(250 * (1u64 << attempts.min(4))));
                if !stream_gap {
                    if attempts <= 6 {
                        publish(&out, &wake, Event::Reconnecting).await;
                    } else if attempts == 7 && reading.is_none() {
                        // Keep the same subscription owner after showing the outage.
                        publish(&out, &wake, Event::Failed).await;
                    }
                }
            }
            Some(Input::AuthenticationRequired(e)) if e == epoch => {
                reject_queued_commands(&rx, &pending_commands, &out, &wake).await;
                publish(&out, &wake, Event::authentication_required(backend.clone())).await;
                return Ok(());
            }
            Some(Input::Unavailable(e)) if e == epoch => {
                stream_gap = false;
                ReadingLane::invalidate_connection(reading);
                reader.dirty = true;
                if reading.is_some() || !reader.historical {
                    publish(&out, &wake, Event::Reconnecting).await;
                }
            }
            Some(Input::Available(e, v)) if e == epoch => {
                if reading.is_some() {
                    publish(&out, &wake, Event::AgentHint(true)).await;
                } else if !stream_gap && v > reader.fence && !reader.historical {
                    publish(&out, &wake, Event::Reconnecting).await;
                }
                reader.dirty = true;
                reader.parked = false;
                reader.quiet = Instant::now() + Duration::from_millis(100);
            }
            Some(Input::Hint(e, v)) if e == epoch && v > reader.fence => {
                reader.dirty = true;
                reader.quiet = Instant::now() + Duration::from_millis(100);
                if !stream_gap && reading.is_none() && !reader.historical {
                    publish(&out, &wake, Event::Reconnecting).await;
                }
            }
            Some(Input::Command(Command::Retry)) => {
                stream_gap = false;
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
            Some(Input::Command(
                command @ (Command::Older | Command::Page(..) | Command::Anchor(_)),
            )) => {
                let lane = Lane {
                    backend: &backend,
                    reading,
                    rx: &rx,
                    wire: &wire,
                    out: &out,
                    wake: &wake,
                };
                let (edge, cancellation) = match command {
                    Command::Anchor(jump) => {
                        reader.anchor(&lane, opened, jump).await;
                        continue;
                    }
                    Command::Page(edge, signal) => (edge, Some(signal)),
                    _ => (crate::transport::HistoryEdge::Before, None),
                };
                match reader
                    .page(&lane, opened, edge, cancellation.as_ref())
                    .await?
                {
                    Turn::Process => {}
                    Turn::Next => continue,
                    Turn::Stop => return Ok(()),
                }
            }
            Some(Input::Command(Command::Latest)) => {
                stream_gap = false;
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
                let admitted = !wire.placement_closed()
                    && (reading.is_some()
                        || !reader.parked
                            && !reader.historical
                            && if opened {
                                wire.upstream.load(SeqCst)
                            } else {
                                stream_gap
                            });
                if !receipts::slash(&backend, &out, &wake, &wire, admitted, attempt, name, text)
                    .await
                {
                    return Ok(());
                }
            }
            Some(Input::Command(Command::Prompt(prompt))) => {
                let Some(id) = &prompt.id else { continue };
                // The compose gesture owns one attempt even if its tab suspends before dispatch.
                let admitted = !wire.placement_closed()
                    && (reading.is_some()
                        || !reader.parked
                            && !reader.historical
                            && if opened {
                                wire.upstream.load(SeqCst)
                            } else {
                                stream_gap
                            });
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
                    reject_queued_commands(&rx, &pending_commands, &out, &wake).await;
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
                if matches!(kind, "session.revert.staged" | "session.revert.cleared") {
                    publish(&out, &wake, Event::RevertChanged).await;
                    reader.clear_window_on_revert();
                    reader.parked = false;
                    reader.dirty = reader.active_reader;
                    reader.quiet = Instant::now();
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
            reader.sync(&lane, opened, &mut connection_lost).await?,
            Turn::Stop
        ) {
            return Ok(());
        }
        if opened && !reader.dirty {
            stream_gap = false;
        }
    }
}
