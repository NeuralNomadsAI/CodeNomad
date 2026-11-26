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
                ReadingLane::invalidate_connection(reading);
                reader.dirty = true;
                if reading.is_some() || !reader.historical {
                    publish(&out, &wake, Event::Reconnecting).await;
                }
            }
            Some(Input::Available(e, v)) if e == epoch => {
                if reading.is_some() {
                    publish(&out, &wake, Event::AgentHint(true)).await;
                } else if v > reader.fence && !reader.historical {
                    publish(&out, &wake, Event::Reconnecting).await;
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
                let attention_handled = crate::history::valid_id(&backend.session)
                    && matches!(
                        crate::stream::session_attention(&native, &backend.session),
                        Some(
                            crate::transport::WorkspaceEvent::SessionRequest { .. }
                                | crate::transport::WorkspaceEvent::SessionRequestResolved { .. }
                        )
                    );
                if !attention_handled {
                    if kind.starts_with("permission.") {
                        publish(
                            &out,
                            &wake,
                            Event::AgentControl(crate::transport::AgentLane::Permissions),
                        )
                        .await;
                    } else if kind.starts_with("form.") {
                        publish(
                            &out,
                            &wake,
                            Event::AgentControl(crate::transport::AgentLane::Forms),
                        )
                        .await;
                    } else if kind.contains("model") {
                        publish(
                            &out,
                            &wake,
                            Event::AgentControl(crate::transport::AgentLane::Session),
                        )
                        .await;
                    }
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
                if kind == "session.deleted" {
                    if let Some(reading) = reading {
                        reading.notify_session_deleted();
                    }
                    publish(&out, &wake, Event::SessionDeleted).await;
                    wire.cancelled.store(true, SeqCst);
                    return Err("session scope changed".into());
                }
                if kind == "session.revert.committed" {
                    publish(&out, &wake, Event::HistoryInvalidated).await;
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
                if kind == "session.synthetic" {
                    reader.dirty = true;
                    reader.quiet = Instant::now() + Duration::from_millis(100);
                    if !reader.historical
                        && let Some(Event::Message(row)) = crate::wire::decode_native(&native)
                        && reader.resident.len() < history::MAX_ROWS
                        && reader.known.insert(row.id.clone())
                    {
                        let prior_matches = reader
                            .resident
                            .iter()
                            .filter(|existing| super::reader::same_synthetic_report(existing, &row))
                            .count();
                        reader.resident.push(row.clone().into());
                        if history::check(&reader.resident).is_err() {
                            reader.resident.pop();
                            reader.known.remove(&row.id);
                        } else {
                            if reader.owed_synthetics.len() < 16 {
                                reader
                                    .owed_synthetics
                                    .entry(row.id.clone())
                                    .or_insert((0, prior_matches));
                            }
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
                        reader.execution_settlement = 0;
                        let mut reconciled = false;
                        let turn_start = reader
                            .resident
                            .iter()
                            .rposition(|r| r.role == "user")
                            .map_or(0, |idx| idx + 1);
                        for row in &reader.resident[turn_start..] {
                            if row.id == id {
                                continue;
                            }
                            for part in &row.parts {
                                if let content::Part::Tool(tool) = part
                                    && matches!(
                                        tool.status.as_str(),
                                        "pending" | "streaming" | "running"
                                    )
                                    && reader.owed_tools.len() < 64
                                {
                                    reader
                                        .owed_tools
                                        .entry((row.id.clone(), tool.id.clone()))
                                        .or_insert(0);
                                    reconciled = true;
                                }
                            }
                        }
                        if reconciled && !reader.dirty {
                            reader.dirty = true;
                            reader.quiet = Instant::now() + Duration::from_millis(100);
                        }
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
                        let row_idx = reader.resident.iter().position(|row| row.id == id);
                        let (fit, ok) = row_idx.map_or((content::ToolFit::Repair, true), |i| {
                            content::apply_tool_checked(
                                &mut reader.resident,
                                i,
                                kind,
                                &native["data"],
                                native["created"].as_u64(),
                            )
                        });
                        match fit {
                            content::ToolFit::Applied(tool) => {
                                if kind == "session.tool.called" {
                                    reader.execution_settlement = 0;
                                }
                                if !ok {
                                    if !reader.dirty {
                                        reader.dirty = true;
                                        reader.quiet = Instant::now() + Duration::from_millis(100);
                                    }
                                } else {
                                    reader_event(
                                        reading,
                                        reader.generation,
                                        &out,
                                        &wake,
                                        Event::Tool(id.into(), tool),
                                    )
                                    .await;
                                }
                            }
                            content::ToolFit::Settled(tool) => {
                                if history::valid_id(id) && reader.owed_tools.len() < 64 {
                                    reader
                                        .owed_tools
                                        .entry((id.into(), tool.id.clone()))
                                        .or_insert(0);
                                }
                                if ok {
                                    reader_event(
                                        reading,
                                        reader.generation,
                                        &out,
                                        &wake,
                                        Event::Tool(id.into(), tool),
                                    )
                                    .await;
                                }
                                if !reader.dirty {
                                    reader.dirty = true;
                                    reader.quiet = Instant::now() + Duration::from_millis(100);
                                }
                            }
                            content::ToolFit::Drop => {}
                            content::ToolFit::Repair => {
                                if matches!(kind, "session.tool.success" | "session.tool.failed") {
                                    let known_call = native["data"]["id"]
                                        .as_str()
                                        .filter(|c| !c.is_empty() && c.len() <= 256)
                                        .filter(|call| {
                                            reader.resident.iter().any(|row| {
                                                row.id == id
                                                    && row.parts.iter().any(|part| {
                                                        matches!(
                                                            part,
                                                            crate::content::Part::Tool(t)
                                                                if t.id == *call
                                                        )
                                                    })
                                            })
                                        });
                                    if let Some(call) = known_call
                                        && reader.owed_tools.len() < 64
                                    {
                                        reader
                                            .owed_tools
                                            .entry((id.into(), call.into()))
                                            .or_insert(0);
                                        if !reader.dirty {
                                            reader.dirty = true;
                                            reader.quiet =
                                                Instant::now() + Duration::from_millis(100);
                                        }
                                    } else if !reader.dirty && reader.repairs < 3 {
                                        reader.repairs += 1;
                                        reader.dirty = true;
                                        reader.quiet = Instant::now() + Duration::from_millis(100);
                                    }
                                } else if !reader.dirty && reader.repairs < 3 {
                                    reader.repairs += 1;
                                    reader.dirty = true;
                                    reader.quiet = Instant::now() + Duration::from_millis(100);
                                }
                            }
                        }
                    }
                    "session.execution.succeeded"
                    | "session.execution.failed"
                    | "session.execution.interrupted" => {
                        reader.terminal = reader.busy;
                        reader.execution_settlement = 3;
                        reader.execution_ended_at = native["created"].as_u64().filter(|&at| at > 0);
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
    }
}
