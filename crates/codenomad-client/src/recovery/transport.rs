//! Serialized command and SSE transport, epoch ownership and reconnect scheduling.
use super::{
    Input, ReadingLane,
    reader::{InboxReply, Lane, Reader, Turn, can_restart, reader_event, reader_inbox_delta},
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

async fn reject_command(command: Command, out: &Sender<Event>, wake: &crate::Wake) {
    let attempted = match command {
        Command::Prompt(prompt) => prompt.id,
        Command::Slash { attempt, .. } | Command::Shell { attempt, .. } => Some(attempt),
        _ => None,
    };
    if let Some(attempted) = attempted {
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

async fn settle_on_close(input: Input, out: &Sender<Event>, wake: &crate::Wake) {
    match input {
        Input::Command(command) => reject_command(command, out, wake).await,
        Input::ShellSettled(_, attempted, settlement) => {
            let outcome = match settlement {
                receipts::ShellSettlement::Outcome(outcome)
                | receipts::ShellSettlement::AuthExpired { outcome } => outcome,
            };
            publish(out, wake, Event::PromptAcknowledged { attempted, outcome }).await;
        }
        _ => {}
    }
}

async fn close_and_reject_queued(
    commands: &Receiver<Command>,
    rx: &Receiver<Input>,
    forward_done: &Receiver<()>,
    out: &Sender<Event>,
    wake: &crate::Wake,
) {
    // Close admission before draining so no caller can enqueue after revocation starts.
    commands.close();
    loop {
        while let Ok(queued) = rx.try_recv() {
            settle_on_close(queued, out, wake).await;
        }
        if forward_done.is_closed() {
            break;
        }
        if let Some(queued) = runtime::recv_timeout(rx, Duration::from_millis(5)).await {
            settle_on_close(queued, out, wake).await;
        }
    }
    while let Ok(queued) = rx.try_recv() {
        settle_on_close(queued, out, wake).await;
    }
    while let Ok(command) = commands.try_recv() {
        reject_command(command, out, wake).await;
    }
}

async fn finish_authentication_required(
    commands: &Receiver<Command>,
    rx: &Receiver<Input>,
    forward_done: &Receiver<()>,
    out: &Sender<Event>,
    wake: &crate::Wake,
    backend: &Backend,
    confirmed: bool,
) {
    close_and_reject_queued(commands, rx, forward_done, out, wake).await;
    publish(
        out,
        wake,
        Event::AuthenticationRequired(crate::transport::Authentication {
            backend: backend.clone(),
            confirmed,
        }),
    )
    .await;
}

fn can_admit_send(
    backend: &Backend,
    wire: &stream::State,
    reading: Option<&ReadingLane>,
    reader: &Reader,
    ever_opened: bool,
    out: &Sender<Event>,
) -> bool {
    !out.is_closed()
        && !backend.client.server_identity_mismatch()
        && !wire.placement_closed()
        && !wire.auth_expired.load(SeqCst)
        && !reading.is_some_and(|lane| lane.revoked.load(SeqCst))
        && (reading.is_some() || !reader.historical && ever_opened)
}

pub(super) async fn next_input(
    rx: &Receiver<Input>,
    reading: Option<&ReadingLane>,
    generation: u64,
    active_reader: bool,
    deadline: Option<Instant>,
) -> Option<Input> {
    if let Ok(input) = rx.try_recv() {
        return Some(input);
    }
    let wait = deadline.map(|at| at.saturating_duration_since(Instant::now()));
    if wait.is_some_and(|duration| duration.is_zero()) {
        return None;
    }
    let receive = async { Some(rx.recv().await.unwrap_or(Input::Command(Command::Close))) };
    let demand = async {
        if let Some(reading) = reading {
            let changed = reading.demand.changed_after(generation).await;
            if changed.is_some() || active_reader {
                return None;
            }
        }
        std::future::pending::<Option<Input>>().await
    };
    let timer = async {
        if let Some(duration) = wait {
            runtime::sleep(duration).await;
            None
        } else {
            std::future::pending::<Option<Input>>().await
        }
    };
    futures_lite::future::or(receive, futures_lite::future::or(demand, timer)).await
}

pub(super) const MAX_RX_BURST_BEFORE_INBOX: u8 = 8;

pub(super) async fn select_input(
    rx: &Receiver<Input>,
    inbox_rx: &Receiver<InboxReply>,
    rx_burst: &mut u8,
    reading: Option<&ReadingLane>,
    generation: u64,
    active_reader: bool,
    deadline: Option<Instant>,
) -> (Option<Input>, Option<InboxReply>) {
    if *rx_burst >= MAX_RX_BURST_BEFORE_INBOX
        && let Ok(reply) = inbox_rx.try_recv()
    {
        *rx_burst = 0;
        return (None, Some(reply));
    }
    if let Ok(input) = rx.try_recv() {
        if !inbox_rx.is_empty() {
            *rx_burst = rx_burst.saturating_add(1);
        } else {
            *rx_burst = 0;
        }
        return (Some(input), None);
    }
    if let Ok(reply) = inbox_rx.try_recv() {
        *rx_burst = 0;
        return (None, Some(reply));
    }
    *rx_burst = 0;
    let selected = futures_lite::future::or(
        async {
            (
                next_input(rx, reading, generation, active_reader, deadline).await,
                None,
            )
        },
        async {
            match inbox_rx.recv().await {
                Ok(reply) => (None, Some(reply)),
                Err(_) => std::future::pending().await,
            }
        },
    )
    .await;
    if selected.0.is_some() && !inbox_rx.is_empty() {
        *rx_burst = 1;
    }
    selected
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
    let (forward_done_tx, forward_done) = crate::bounded(1);
    let forward = tx.clone();
    runtime::spawn(async move {
        while let Ok(command) = commands.recv().await {
            if forward.send(Input::Command(command)).await.is_err() {
                break;
            }
        }
        let _ = forward.send(Input::Command(Command::Close)).await;
        drop(forward_done_tx);
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
                .with_provider_usage(provider_usage.clone())
                .with_session_deleted(reading.and_then(|r| r.on_session_deleted.clone())),
        )
    };
    let mut wire = make_wire();
    stream::start(backend.clone(), epoch, tx.clone(), wire.clone());
    let mut opened = false;
    let mut ever_opened = false;
    let mut stream_gap = false;
    let mut connection_lost = false;
    let mut connection_closed = false;
    let mut retry: Option<Instant> = None;
    let mut attempts = 0u32;
    let mut reader = Reader::new();
    let (inbox_tx, inbox_rx) = crate::bounded::<InboxReply>(8);
    let mut rx_burst = 0u8;
    loop {
        reader.demand(reading);
        let deadline = [
            retry,
            reader.next_sync_at(opened, &wire, reading),
            reader.inbox_deadline(opened, &wire, reading),
        ]
        .into_iter()
        .flatten()
        .min();
        let (input, inbox_reply) = select_input(
            &rx,
            &inbox_rx,
            &mut rx_burst,
            reading,
            reader.generation,
            reader.active_reader,
            deadline,
        )
        .await;
        reader.demand(reading);
        if let Some(reply) = inbox_reply {
            let lane = Lane {
                backend: &backend,
                reading,
                rx: &rx,
                wire: &wire,
                out: &out,
                wake: &wake,
            };
            match reader.finish_inbox_read(&lane, epoch, reply).await? {
                Turn::Process => {}
                Turn::Next => continue,
                Turn::Stop => return Ok(()),
                Turn::AuthenticationExpired => {
                    finish_authentication_required(
                        &pending_commands,
                        &rx,
                        &forward_done,
                        &out,
                        &wake,
                        &backend,
                        true,
                    )
                    .await;
                    return Ok(());
                }
            }
        }
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
                let stopped = matches!(event, crate::transport::WorkspaceEvent::Stopped { .. });
                if !publish(&out, &wake, Event::Workspace(event)).await {
                    wire.cancel();
                    return Ok(());
                }
                if stopped {
                    wire.close_placement();
                    wire.cancel();
                    ReadingLane::invalidate_connection(reading);
                    close_and_reject_queued(&pending_commands, &rx, &forward_done, &out, &wake)
                        .await;
                    publish(&out, &wake, Event::Failed).await;
                    return Ok(());
                }
            }
            Some(Input::Command(Command::Close)) => {
                wire.cancel();
                return Ok(());
            }
            Some(Input::Opened(e)) if e == epoch => {
                opened = true;
                ever_opened = true;
                publish(&out, &wake, Event::AgentHint(true)).await;
                reader.dirty = true;
                reader.parked = false;
                reader.quiet = Instant::now() + Duration::from_millis(100);
                reader.inbox_published = false;
                reader.schedule_inbox_sync(Duration::from_millis(100));
            }
            Some(Input::Closed(e)) if e == epoch => {
                ReadingLane::invalidate_connection(reading);
                stream_gap = opened && attempts == 0;
                opened = false;
                connection_closed = true;
                connection_lost = true;
                reader.dirty = true;
                reader.invalidate_inbox_flight();
                reader.inbox_published = false;
                publish(&out, &wake, Event::ConnectionLost).await;
                attempts = attempts.saturating_add(1);
                retry =
                    Some(Instant::now() + Duration::from_millis(250 * (1u64 << attempts.min(4))));
                if !stream_gap {
                    if attempts <= 6 {
                        publish(&out, &wake, Event::Reconnecting).await;
                    } else if attempts == 7 && reading.is_none() && !ever_opened {
                        // Only fail an unestablished direct transport; once established, SSE outages
                        // must not revoke HTTP send authority.
                        publish(&out, &wake, Event::Failed).await;
                    }
                }
            }
            Some(Input::AuthenticationRequired(e)) if e == epoch => {
                finish_authentication_required(
                    &pending_commands,
                    &rx,
                    &forward_done,
                    &out,
                    &wake,
                    &backend,
                    false,
                )
                .await;
                return Ok(());
            }
            Some(Input::Unavailable(e, mark)) if e == epoch => {
                // Upstream SSE unavailability over an open backend SSE stream is always a stream gap,
                // never a revocation of HTTP send authority. Always publish ConnectionLost so detached
                // history also reflects stream_offline for pagination buttons.
                stream_gap = opened;
                ReadingLane::invalidate_connection(reading);
                reader.dirty = true;
                reader.invalidate_inbox_flight();
                reader.inbox_published = false;
                publish(
                    &out,
                    &wake,
                    Event::Workspace(crate::transport::WorkspaceEvent::NativeStreamStatus {
                        workspace_id: backend.workspace.clone(),
                        connected: false,
                    }),
                )
                .await;
                publish(
                    &out,
                    &wake,
                    if stream_gap || reading.is_some() || reader.historical {
                        Event::ConnectionLost
                    } else {
                        Event::Reconnecting
                    },
                )
                .await;
                wire.inbox.advance_applied(mark);
            }
            Some(Input::Available(e, v, mark)) if e == epoch => {
                publish(
                    &out,
                    &wake,
                    Event::Workspace(crate::transport::WorkspaceEvent::NativeStreamStatus {
                        workspace_id: backend.workspace.clone(),
                        connected: true,
                    }),
                )
                .await;
                if reading.is_some() {
                    publish(&out, &wake, Event::UpstreamReady).await;
                    publish(&out, &wake, Event::AgentHint(true)).await;
                } else if !stream_gap && v > reader.fence && !reader.historical {
                    publish(&out, &wake, Event::Reconnecting).await;
                }
                reader.dirty = true;
                reader.parked = false;
                reader.quiet = Instant::now() + Duration::from_millis(100);
                reader.inbox_published = false;
                reader.schedule_inbox_sync(Duration::from_millis(100));
                wire.inbox.advance_applied(mark);
            }
            Some(Input::Hint(e, v, mark)) if e == epoch => {
                reader.schedule_inbox_sync(Duration::from_millis(100));
                if v > reader.fence {
                    reader.dirty = true;
                    reader.quiet = Instant::now() + Duration::from_millis(100);
                    if !stream_gap && reading.is_none() && !reader.historical {
                        publish(&out, &wake, Event::Reconnecting).await;
                    }
                }
                wire.inbox.advance_applied(mark);
            }
            Some(Input::Command(Command::Retry)) => {
                stream_gap = false;
                ReadingLane::invalidate_connection(reading);
                attempts = 0;
                reader.dirty = true;
                reader.parked = false;
                reader.quiet = Instant::now();
                reader.invalidate_inbox_flight();
                wire.inbox.invalidate_published();
                reader.inbox_published = false;
                reader.schedule_inbox_sync(Duration::ZERO);
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
                        if matches!(
                            reader.anchor(&lane, opened, jump).await,
                            Turn::AuthenticationExpired
                        ) {
                            finish_authentication_required(
                                &pending_commands,
                                &rx,
                                &forward_done,
                                &out,
                                &wake,
                                &backend,
                                true,
                            )
                            .await;
                            return Ok(());
                        }
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
                    Turn::AuthenticationExpired => {
                        finish_authentication_required(
                            &pending_commands,
                            &rx,
                            &forward_done,
                            &out,
                            &wake,
                            &backend,
                            true,
                        )
                        .await;
                        return Ok(());
                    }
                }
            }
            Some(Input::Command(Command::SyncInbox(min_epoch))) => {
                reader.inbox_sync_epoch = reader.inbox_sync_epoch.max(min_epoch);
                reader.schedule_inbox_sync(Duration::ZERO);
            }
            Some(Input::Command(Command::Latest)) => {
                stream_gap = false;
                reader.clear_window();
                reader.dirty = true;
                reader.parked = false;
                reader.quiet = Instant::now();
                reader.inbox_published = false;
                reader.schedule_inbox_sync(Duration::ZERO);
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
                let admitted = can_admit_send(&backend, &wire, reading, &reader, ever_opened, &out);
                if let receipts::SlashReceipt::AuthenticationRequired { confirmed } =
                    receipts::slash(&backend, &out, &wake, &wire, admitted, attempt, name, text)
                        .await
                {
                    finish_authentication_required(
                        &pending_commands,
                        &rx,
                        &forward_done,
                        &out,
                        &wake,
                        &backend,
                        confirmed,
                    )
                    .await;
                    return Ok(());
                }
            }
            Some(Input::Command(Command::Shell { attempt, command })) => {
                let admitted = can_admit_send(&backend, &wire, reading, &reader, ever_opened, &out);
                if !admitted {
                    publish(
                        &out,
                        &wake,
                        Event::PromptAcknowledged {
                            attempted: attempt,
                            outcome: PromptOutcome::Rejected,
                        },
                    )
                    .await;
                    continue;
                }
                let dispatch_epoch = epoch;
                let backend = backend.clone();
                let done = tx.clone();
                runtime::spawn(async move {
                    if let Some(settlement) =
                        runtime::until_closed(&done, receipts::shell(&backend, &attempt, &command))
                            .await
                    {
                        let _ = done
                            .send(Input::ShellSettled(dispatch_epoch, attempt, settlement))
                            .await;
                    }
                });
            }
            Some(Input::ShellSettled(dispatch_epoch, attempt, settlement)) => {
                let (outcome, auth_expired) = match settlement {
                    receipts::ShellSettlement::Outcome(outcome) => (outcome, false),
                    receipts::ShellSettlement::AuthExpired { outcome } => (outcome, true),
                };
                if auth_expired && dispatch_epoch == epoch {
                    super::authentication::close_for_authentication(&wire, &out).await;
                    publish(
                        &out,
                        &wake,
                        Event::PromptAcknowledged {
                            attempted: attempt,
                            outcome,
                        },
                    )
                    .await;
                    finish_authentication_required(
                        &pending_commands,
                        &rx,
                        &forward_done,
                        &out,
                        &wake,
                        &backend,
                        true,
                    )
                    .await;
                    return Ok(());
                }
                if matches!(
                    outcome,
                    PromptOutcome::Confirmed(_) | PromptOutcome::Unconfirmed
                ) {
                    reader.dirty = true;
                    reader.quiet = Instant::now();
                }
                publish(
                    &out,
                    &wake,
                    Event::PromptAcknowledged {
                        attempted: attempt,
                        outcome,
                    },
                )
                .await;
            }
            Some(Input::Command(Command::Prompt(prompt))) => {
                let Some(id) = &prompt.id else { continue };
                // The compose gesture owns one attempt even if its tab suspends before dispatch.
                let encoded =
                    if can_admit_send(&backend, &wire, reading, &reader, ever_opened, &out) {
                        crate::prompt::encode(&prompt).ok()
                    } else {
                        None
                    };
                // Re-check placement and revocation right after encoding, before dispatching the POST.
                let outcome = match encoded {
                    Some(body)
                        if can_admit_send(&backend, &wire, reading, &reader, ever_opened, &out) =>
                    {
                        match receipts::prompt_encoded(&backend, &out, &wake, &wire, id, body).await
                        {
                            receipts::PromptReceipt::Outcome(outcome) => outcome,
                            receipts::PromptReceipt::AuthenticationRequired { confirmed } => {
                                finish_authentication_required(
                                    &pending_commands,
                                    &rx,
                                    &forward_done,
                                    &out,
                                    &wake,
                                    &backend,
                                    confirmed,
                                )
                                .await;
                                return Ok(());
                            }
                        }
                    }
                    _ => PromptOutcome::Rejected,
                };
                if !matches!(outcome, PromptOutcome::Rejected)
                    && (reader.busy || prompt.delivery == Some(crate::prompt::Delivery::Queue))
                {
                    reader.schedule_inbox_sync(Duration::from_millis(50));
                }
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
            Some(Input::Native(e, v, mark, native)) if e == epoch => {
                struct AdvanceApplied<'a>(&'a crate::inbox::InboxWire, u64);
                impl Drop for AdvanceApplied<'_> {
                    fn drop(&mut self) {
                        self.0.advance_applied(self.1);
                    }
                }
                let _applied = AdvanceApplied(&wire.inbox, mark);
                let kind = native["type"].as_str().unwrap_or_default();
                if native["data"]["sessionID"] != backend.session
                    && let Some(change) = content::FamilyChange::decode(&native)
                {
                    publish(&out, &wake, Event::FamilyUsage(change)).await;
                    continue;
                }
                if kind == "session.moved" {
                    if !crate::stream::session_moved_away(&backend, &native) {
                        continue;
                    }
                    wire.cancel();
                    close_and_reject_queued(&pending_commands, &rx, &forward_done, &out, &wake)
                        .await;
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
                    wire.cancel();
                    close_and_reject_queued(&pending_commands, &rx, &forward_done, &out, &wake)
                        .await;
                    publish(&out, &wake, Event::SessionDeleted).await;
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
                if kind.starts_with("session.inbox.") {
                    if reader.active_reader {
                        reader.inbox_supported = true;
                        reader.inbox_retries = 0;
                        match kind {
                            "session.inbox.enqueued" => {
                                if let Some(item) = crate::inbox::decode_enqueued(&native) {
                                    let collides = reader.known.contains(&item.id);
                                    if !collides {
                                        if let Some(existing) =
                                            reader.inbox.iter_mut().find(|row| row.id == item.id)
                                        {
                                            *existing = item.clone();
                                        } else if reader.inbox.len() < crate::inbox::MAX_ITEMS {
                                            reader.inbox.push(item.clone());
                                        }
                                        reader_inbox_delta(
                                            reading,
                                            reader.generation,
                                            &out,
                                            &wake,
                                            crate::inbox::InboxDelta::Upsert(item),
                                        )
                                        .await;
                                    } else if !reader.historical && reader.inbox_overlap_repairs < 2
                                    {
                                        reader.inbox_overlap_repairs += 1;
                                        reader.dirty = true;
                                        reader.quiet = Instant::now();
                                    }
                                    reader.schedule_inbox_sync(Duration::from_millis(100));
                                } else {
                                    reader.schedule_inbox_sync(Duration::from_millis(100));
                                    if !reader.historical {
                                        reader.dirty = true;
                                        reader.quiet = Instant::now() + Duration::from_millis(100);
                                    }
                                }
                            }
                            "session.inbox.delivery.changed" => {
                                if let Some((inbox_id, delivery)) =
                                    crate::inbox::decode_delivery_changed(&native)
                                {
                                    if let Some(existing) =
                                        reader.inbox.iter_mut().find(|row| row.id == inbox_id)
                                    {
                                        existing.delivery = delivery;
                                    }
                                    reader_inbox_delta(
                                        reading,
                                        reader.generation,
                                        &out,
                                        &wake,
                                        crate::inbox::InboxDelta::Delivery {
                                            id: inbox_id,
                                            delivery,
                                        },
                                    )
                                    .await;
                                }
                                reader.schedule_inbox_sync(Duration::from_millis(100));
                            }
                            "session.inbox.delivered" => {
                                if let Some(inbox_id) = crate::inbox::decode_inbox_id(&native) {
                                    reader.inbox.retain(|row| row.id != inbox_id);
                                    reader_inbox_delta(
                                        reading,
                                        reader.generation,
                                        &out,
                                        &wake,
                                        crate::inbox::InboxDelta::Removed(inbox_id.to_owned()),
                                    )
                                    .await;
                                }
                                reader.schedule_inbox_sync(Duration::from_millis(100));
                                if !reader.parked {
                                    reader.dirty = true;
                                    reader.quiet = Instant::now() + Duration::from_millis(100);
                                }
                            }
                            "session.inbox.cancelled" => {
                                let inbox_id = crate::inbox::decode_inbox_id(&native);
                                let was_known =
                                    inbox_id.is_some_and(|id| reader.known.contains(id));
                                if let Some(inbox_id) = inbox_id {
                                    reader.inbox.retain(|row| row.id != inbox_id);
                                    reader_inbox_delta(
                                        reading,
                                        reader.generation,
                                        &out,
                                        &wake,
                                        crate::inbox::InboxDelta::Removed(inbox_id.to_owned()),
                                    )
                                    .await;
                                }
                                reader.schedule_inbox_sync(Duration::from_millis(100));
                                if !reader.parked && (was_known || !reader.historical) {
                                    reader.dirty = true;
                                    reader.quiet = Instant::now() + Duration::from_millis(100);
                                }
                            }
                            _ => {
                                reader.schedule_inbox_sync(Duration::from_millis(100));
                            }
                        }
                    } else {
                        match kind {
                            "session.inbox.enqueued" => {
                                if let Some(item) = crate::inbox::decode_enqueued(&native) {
                                    publish(
                                        &out,
                                        &wake,
                                        Event::InboxDelta(crate::inbox::InboxDelta::Upsert(item)),
                                    )
                                    .await;
                                }
                            }
                            "session.inbox.delivery.changed" => {
                                if let Some((inbox_id, delivery)) =
                                    crate::inbox::decode_delivery_changed(&native)
                                {
                                    publish(
                                        &out,
                                        &wake,
                                        Event::InboxDelta(crate::inbox::InboxDelta::Delivery {
                                            id: inbox_id,
                                            delivery,
                                        }),
                                    )
                                    .await;
                                }
                            }
                            "session.inbox.delivered" | "session.inbox.cancelled" => {
                                if let Some(inbox_id) = crate::inbox::decode_inbox_id(&native) {
                                    publish(
                                        &out,
                                        &wake,
                                        Event::InboxDelta(crate::inbox::InboxDelta::Removed(
                                            inbox_id.to_owned(),
                                        )),
                                    )
                                    .await;
                                }
                            }
                            _ => {}
                        }
                    }
                    continue;
                }
                if kind == "server.connected" {
                    if reader.active_reader {
                        reader.schedule_inbox_sync(Duration::from_millis(100));
                        if !reader.historical && !reader.parked && v > reader.fence {
                            reader.dirty = true;
                            reader.quiet = Instant::now() + Duration::from_millis(100);
                        }
                    }
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
                        if !reader.inbox.is_empty() {
                            reader.schedule_inbox_sync(Duration::from_millis(100));
                        }
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
                    "session.shell.started" | "session.shell.ended" => {
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
        match reader.sync(&lane, opened, &mut connection_lost).await? {
            Turn::Stop => return Ok(()),
            Turn::AuthenticationExpired => {
                finish_authentication_required(
                    &pending_commands,
                    &rx,
                    &forward_done,
                    &out,
                    &wake,
                    &backend,
                    true,
                )
                .await;
                return Ok(());
            }
            Turn::Process | Turn::Next => {}
        }
        if reader.parked {
            stream_gap = false;
        }
        if opened
            && wire.upstream.load(SeqCst)
            && (!reader.active_reader || reader.historical || (!reader.dirty && !reader.parked))
        {
            attempts = 0;
            stream_gap = false;
        }
        reader.maybe_start_inbox(epoch, &backend, reading, &wire, opened, &inbox_tx);
    }
}
