#[cfg(target_arch = "wasm32")]
use crate::platform;
use crate::{
    Phase, State, agent, chat, composer, content, git, settings,
    transport::{self, Event},
    workspace,
};

pub(crate) fn poll_chat(s: &mut State, limit: usize) -> bool {
    drain_chat(s, limit, true, true, false)
}

pub(crate) fn poll_hidden_chat(s: &mut State, limit: usize, active_has_stream: bool) -> bool {
    drain_chat(s, limit, false, !active_has_stream, false)
}

pub(crate) fn poll_chat_for_window(s: &mut State, limit: usize, defer_reader_sync: bool) -> bool {
    drain_chat(s, limit, true, true, defer_reader_sync)
}

fn drain_chat(
    s: &mut State,
    limit: usize,
    visible: bool,
    affects_preferences: bool,
    defer_reader_sync: bool,
) -> bool {
    let mut changed = s.agent.as_mut().is_some_and(|a| a.poll());
    if changed
        && s.reader
            .as_ref()
            .is_some_and(chat::reader::Reader::independent_status)
        && let Some(agent) = &s.agent
        && agent.online
        && agent.known
        && s.phase != Phase::Failed
    {
        let running = s.reader.as_ref().and_then(chat::reader::Reader::running);
        s.phase = if running.unwrap_or(agent.running) {
            Phase::Streaming
        } else {
            Phase::Ready
        };
    }
    for _ in 0..limit {
        let observation = s.incoming.as_ref().and_then(|r| r.try_recv().ok());
        let content = observation.is_none();
        let event = observation.or_else(|| {
            let history_bounds = s.tool_diff_preferences.history_bounds.get();
            let reading = s.transcript_display.reading();
            let cached_gap =
                s.history_detached || s.reader.as_ref().is_some_and(chat::reader::Reader::has_gap);
            s.reader.as_mut().and_then(|reader| {
                reader.take_next(defer_reader_sync, reading, history_bounds, cached_gap)
            })
        });
        let Some(event) = event else { break };
        crate::timeline::observe(s, &event);
        let stale_activity = matches!(&event, Event::ReaderSync { version, .. }
            if s.reader.as_ref().is_some_and(|reader| reader.activity_after(*version)));
        settings::connection_event(s, &event, affects_preferences);
        match event {
            Event::Connected(backend) => {
                s.renew_scope();
                s.conversation_client_id = Some(backend.client_id.clone());
                s.conversation_stream_connected = false;
                s.status_permissions.bind(&backend);
                s.status_usage.bind(&backend);
                s.transcript_display.children.bind(backend.clone());
                s.transcript_display.usage_family.bind(backend.clone());
                s.transcript_display.pictures.bind(backend.clone());
                s.transcript_display.receipts.bind(backend.clone());
                s.transcript_display.messages.bind(backend.clone());
                s.attachments.bind(backend.clone());
                s.composer.picker.bind(backend.clone());
                git::connected(s, &backend);
                if affects_preferences {
                    settings::connected(s, &backend);
                }
                workspace::restore_files_mode(s);
                if s.agent.is_none() {
                    s.agent = Some(agent::Ui::new(agent::start(backend, s.wake.clone())));
                }
            }
            Event::AgentHint(catalog) => {
                if catalog {
                    if s.history_detached {
                        s.stream_offline = false;
                    }
                    s.conversation_stream_connected = true;
                    s.transcript_display.messages.refresh();
                    s.status_permissions.online(true);
                    workspace::mission_event(s, None);
                    s.transcript_display.receipts.reconnect();
                    s.transcript_display.pictures.retry_interrupted();
                    s.transcript_display.usage_family.refresh();
                    s.composer.picker.reconnect_commands(&s.reads, &s.wake);
                    s.composer.picker.mentions_changed(&s.reads, &s.wake);
                    git::online(s, true);
                }
                if catalog && let Some(files) = &mut s.files {
                    files.online(true);
                }
                if let Some(a) = s.agent.as_mut() {
                    if catalog {
                        a.online = true;
                    }
                    a.refresh(catalog)
                }
            }
            Event::SessionUsage(usage) => {
                if let Some(agent) = &mut s.agent {
                    agent.observe_usage(usage);
                }
            }
            Event::FamilyUsage(change) => {
                if !s.transcript_display.usage_family.event(change) {
                    continue;
                }
            }
            Event::Workspace(codenomad_client::transport::WorkspaceEvent::CommandsChanged) => {
                s.composer.picker.commands_changed(&s.reads, &s.wake);
            }
            Event::Workspace(codenomad_client::transport::WorkspaceEvent::MentionsChanged) => {
                s.composer.picker.mentions_changed(&s.reads, &s.wake);
            }
            Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::PermissionModeChanged { root },
            ) => {
                s.status_permissions.invalidate(root.as_deref());
            }
            Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::ComposerCataloguesChanged,
            ) => {
                s.composer.picker.commands_changed(&s.reads, &s.wake);
                s.composer.picker.mentions_changed(&s.reads, &s.wake);
            }
            Event::ObservedRunning { running, version } => {
                if let Some(reader) = &mut s.reader {
                    reader.observed_running(running, version, s.phase.running());
                }
                if let Phase::StreamDisconnected { running: prev } = &mut s.phase {
                    if running
                        || s.reader
                            .as_ref()
                            .is_none_or(chat::reader::Reader::independent_status)
                    {
                        *prev = running;
                    }
                } else if !s.phase.reconnecting()
                    && s.phase != Phase::Failed
                    && (running
                        || s.reader
                            .as_ref()
                            .is_none_or(chat::reader::Reader::independent_status))
                {
                    s.phase = if running {
                        Phase::Streaming
                    } else {
                        Phase::Ready
                    };
                }
                if let Some(agent) = &mut s.agent {
                    agent.observe_running(running);
                }
            }
            Event::Workspace(codenomad_client::transport::WorkspaceEvent::SessionRequest {
                form,
                id,
            }) => {
                if !uses_workspace_attention(s)
                    && let Some(agent) = &mut s.agent
                {
                    agent.notice_request(form, id);
                }
            }
            Event::Workspace(codenomad_client::transport::WorkspaceEvent::SessionExecution {
                notice,
            }) => {
                if !uses_workspace_attention(s)
                    && let Some(agent) = &mut s.agent
                {
                    let verify = notice.is_some();
                    agent.attention.execution(notice);
                    if verify {
                        agent.refresh(false);
                    }
                }
            }
            Event::Workspace(codenomad_client::transport::WorkspaceEvent::SessionCompacted {
                id,
            }) => {
                if !uses_workspace_attention(s)
                    && let Some(agent) = &mut s.agent
                {
                    agent.attention.compacted(id);
                    agent.refresh(false);
                }
            }
            Event::Workspace(
                event @ codenomad_client::transport::WorkspaceEvent::OpenCodeNotice { .. },
            ) => {
                if !uses_workspace_attention(s) {
                    crate::shell::notifications::relay_notice(s, event);
                }
            }
            Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::PermissionReceiptsChanged { message },
            ) => {
                s.transcript_display.receipts.invalidate(message);
                continue;
            }
            Event::ProviderUsageWatch(watch) => s.status_usage.watch(watch),
            Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::ProviderUsageRefresh(directory),
            ) => {
                s.status_usage.refresh(directory.as_deref());
            }
            Event::Workspace(event) => {
                if matches!(
                    event,
                    codenomad_client::transport::WorkspaceEvent::SessionMoved { .. }
                ) {
                    s.composer.clear_optimistic(None);
                    s.status_permissions.online(false);
                    s.status_usage.disconnect();
                    chat::reader::suspend(s);
                    s.composer.picker.set_attachments_supported(false);
                    s.attachments.cancel();
                    s.messages.clear();
                    s.history_detached = false;
                    s.can_older = false;
                    s.phase = Phase::Reconnecting;
                    if let Some(agent) = &mut s.agent {
                        agent.attention.disconnected();
                    }
                } else if matches!(
                    event,
                    codenomad_client::transport::WorkspaceEvent::Stopped { .. }
                ) {
                    s.stream_offline = true;
                    s.status_permissions.online(false);
                    s.status_usage.disconnect();
                    suspend_preserving_page_retry(s);
                    s.composer.picker.set_attachments_supported(false);
                    s.attachments.cancel();
                    s.phase = Phase::Failed;
                    if let Some(agent) = &mut s.agent {
                        agent.online = false;
                        agent.attention.disconnected();
                    }
                }
                workspace::mission_event(s, Some(&event));
                git::event(s, &event);
                if let Some(files) = &mut s.files {
                    files.event(event);
                }
            }
            Event::Preferences(owner) => {
                s.conversation_stream_connected = true;
                settings::invalidate(s, owner);
            }
            event @ (Event::Sync(_) | Event::ReaderSync { .. }) => {
                let (page, reader_version) = match event {
                    Event::Sync(page) => (page, None),
                    Event::ReaderSync { page, version } => (page, Some(version)),
                    _ => continue,
                };
                s.conversation_stream_connected = true;
                if s.reader.is_none() {
                    // Direct startup also uses Reconnecting to stage a fresh transcript read.
                    s.status_permissions.synchronized();
                }
                if chat::reader::reconcile_bookmark(s, &page) {
                    s.revision += 1;
                    changed = true;
                    continue;
                }
                let optimistic_id = s.composer.optimistic_id().map(str::to_owned);
                let sync_undo = if let Some(version) = reader_version
                    && !s.messages.is_empty()
                    && s.reader
                        .as_ref()
                        .is_some_and(chat::reader::Reader::is_resuming)
                {
                    let authoritative_first = s
                        .messages
                        .iter()
                        .find(|r| optimistic_id.as_deref() != Some(r.id.as_str()));
                    let authoritative_last = s
                        .messages
                        .iter()
                        .rfind(|r| optimistic_id.as_deref() != Some(r.id.as_str()));
                    let trimmed_older = page.older.is_some()
                        && authoritative_first
                            .is_some_and(|first| !page.rows.iter().any(|r| r.id == first.id));
                    let trimmed_newer = page.newer.is_some()
                        && authoritative_last
                            .is_some_and(|last| !page.rows.iter().any(|r| r.id == last.id));
                    (trimmed_older || trimmed_newer).then(|| {
                        let mut prev_rows = std::mem::take(&mut s.messages);
                        if let Some(id) = optimistic_id.as_deref() {
                            prev_rows.retain(|r| r.id != id);
                        }
                        (
                            version,
                            page.clone(),
                            prev_rows,
                            s.can_older,
                            s.history_detached,
                            trimmed_older,
                            trimmed_newer,
                        )
                    })
                } else {
                    None
                };
                if let Some(reader) = &mut s.reader {
                    reader.clear_sync_undo();
                    if let Some((
                        version,
                        page_copy,
                        prev_rows,
                        prev_can_older,
                        prev_detached,
                        trimmed_older,
                        trimmed_newer,
                    )) = sync_undo
                    {
                        reader.save_sync_undo(
                            page_copy,
                            version,
                            prev_rows,
                            prev_can_older,
                            prev_detached,
                            trimmed_older,
                            trimmed_newer,
                        );
                    }
                    reader.install(page.newer.is_some());
                    reader.sync_activity(stale_activity);
                }
                s.composer
                    .picker
                    .set_attachments_supported(page.user_file_references);
                git::online(s, true);
                if let Some(files) = &mut s.files {
                    files.online(true);
                }
                if let Some(a) = s.agent.as_mut() {
                    if !a.online || a.running != page.running {
                        a.online = true;
                        s.composer.picker.refresh_commands(&s.reads, &s.wake);
                        a.refresh(false);
                    }
                }
                s.composer.clear_optimistic(None);
                s.messages = page.rows;
                s.history_detached = s.reader.is_some() && page.newer.is_some();
                crate::timeline::restore_search(s);
                if s.history_detached {
                    s.transcript_display.tool_clock.pause();
                } else {
                    s.transcript_display.tool_clock.resume();
                }
                composer::reconcile(s);
                s.can_older = page.older.is_some();
                // An earlier snapshot may already have been queued before the gesture.
                // The page offer or its cancellation alone settles that gesture.
                if s.transcript_display.timeline.paging.is_none() {
                    s.paging = false;
                    let keep_retry = matches!(
                        s.transcript_display.timeline.page_retry,
                        Some(
                            crate::transport::HistoryEdge::Before
                                | crate::transport::HistoryEdge::Oldest
                        ) if page.older.is_some()
                    ) || matches!(
                        s.transcript_display.timeline.page_retry,
                        Some(crate::transport::HistoryEdge::After) if page.newer.is_some()
                    );
                    if !keep_retry {
                        s.history_error = false;
                        s.transcript_display.timeline.page_retry = None;
                    }
                }
                // A newer activity event can run ahead of a snapshot in the content lane.
                let running = if stale_activity {
                    s.reader.as_ref().is_some_and(|reader| {
                        !reader.independent_status() || reader.running() == Some(true)
                    })
                } else {
                    page.running
                };
                s.phase = if running {
                    Phase::Streaming
                } else {
                    Phase::Ready
                };
                s.stream_offline = false;
            }
            Event::Older(page) => chat::reader::install_page(s, page, None),
            Event::PageOffered {
                page,
                admit,
                cancelled,
            } => {
                if let Some(edge) = chat::reader::admit_page(s, &cancelled, || admit.accept()) {
                    chat::reader::install_page(s, page, Some(edge));
                }
            }
            Event::Reconnecting | Event::ConnectionLost => {
                let stream_lost = matches!(event, Event::ConnectionLost);
                let keep_stream_authority = matches!(
                    s.phase,
                    Phase::Ready | Phase::Streaming | Phase::StreamDisconnected { .. }
                );
                s.stream_offline = true;
                if stream_lost {
                    s.conversation_stream_connected = false;
                }
                workspace::suspend_mission_briefing(s);
                s.transcript_display.messages.offline();
                s.transcript_display.tool_clock.pause();
                s.status_permissions.online(false);
                if !stream_lost && !keep_stream_authority {
                    s.composer.picker.set_attachments_supported(false);
                }
                chat::reader::reconnecting(s);
                #[cfg(target_arch = "wasm32")]
                if stream_lost && !platform::pairing::required(s) {
                    platform::pairing::observe(s);
                }
                git::online(s, false);
                if let Some(files) = &mut s.files {
                    files.online(false);
                }
                if !s.history_detached && s.phase != Phase::Failed {
                    s.phase = match &s.phase {
                        Phase::Ready => Phase::StreamDisconnected { running: false },
                        Phase::Streaming => Phase::StreamDisconnected { running: true },
                        Phase::StreamDisconnected { running } => {
                            Phase::StreamDisconnected { running: *running }
                        }
                        _ => Phase::Reconnecting,
                    };
                }
                s.attachments.cancel();
                if let Some(a) = s.agent.as_mut() {
                    a.online = false;
                    a.attention.disconnected();
                }
            }
            Event::PagingFailed => {
                chat::reader::cancel_page(s);
                s.paging = false;
                s.history_error = true;
            }
            Event::RevertChanged => s.transcript_display.messages.invalidate_boundary(),
            Event::PageFailed(cancelled) => {
                chat::reader::admit_page(s, &cancelled, || false);
            }
            Event::Anchor {
                ticket,
                page,
                admit,
            } => {
                crate::timeline::admit(s, ticket, page, admit);
            }
            Event::AnchorFailed(ticket) => crate::timeline::failed(s, ticket),
            Event::HistoryInvalidated => {
                s.transcript_display.messages.invalidate_boundary();
                chat::reader::cancel_page(s);
                s.history_error = false;
                s.transcript_display.receipts.clear();
                s.transcript_display.children.clear();
                s.transcript_display.tool_clock.reset();
                s.transcript_display.pictures.clear();
                chat::reader::invalidate(s);
                s.composer.picker.set_attachments_supported(false);
                s.attachments.cancel();
                s.composer.clear_optimistic(None);
                s.messages.clear();
                s.history_detached = false;
                s.can_older = false;
                s.paging = false;
                s.phase = Phase::Reconnecting;
            }
            Event::WorkspaceMissing => {
                s.stream_offline = true;
                s.conversation_stream_connected = false;
                s.transcript_display.receipts.clear();
                s.status_permissions.online(false);
                s.status_usage.disconnect();
                s.transcript_display.children.clear();
                s.transcript_display.tool_clock.reset();
                s.transcript_display.pictures.clear();
                s.transcript_display.usage_family.close();
                #[cfg(target_arch = "wasm32")]
                {
                    s.phase = Phase::WorkspaceMissing;
                }
                #[cfg(not(target_arch = "wasm32"))]
                {
                    s.phase = Phase::Failed;
                }
            }
            Event::History(messages) => {
                s.composer.clear_optimistic(None);
                s.transcript_display.tool_clock.resume();
                s.conversation_stream_connected = true;
                if let Some(reader) = &mut s.reader {
                    reader.clear_sync_undo();
                }
                s.messages = messages;
                composer::reconcile(s);
                s.phase = Phase::Ready;
                s.stream_offline = false;
            }
            Event::Message(m) => {
                s.composer.clear_optimistic(Some(&m.id));
                if let Some(reader) = &mut s.reader {
                    reader.clear_sync_undo();
                }
                if let Some(existing) = s.messages.iter_mut().find(|existing| existing.id == m.id) {
                    *existing = m.into();
                } else {
                    s.messages.push(m.into());
                }
                composer::reconcile(s);
            }
            Event::PromptAcknowledged { attempted, outcome } => {
                composer::acknowledge(s, &attempted, outcome);
                if s.workspace.is_some() && std::mem::take(&mut s.composer.restored) {
                    workspace::capture(s);
                }
            }
            Event::Text(id, event) => {
                let mut touched = false;
                if let Some(m) = s.messages.iter_mut().find(|m| m.id == id) {
                    touched = true;
                    let new_text = matches!(&event, content::TextEvent::Delta { text, .. } if !text.trim().is_empty())
                        && m.parts
                            .iter()
                            .rev()
                            .find_map(|part| match part {
                                content::Part::Text(t) => Some(t.text.trim().is_empty()),
                                _ => None,
                            })
                            .unwrap_or(true);
                    match content::apply_text(std::sync::Arc::make_mut(m), &event) {
                        Ok(content::TextFit::Repair) | Err(_) => s.history_error = true,
                        _ => {}
                    }
                    if new_text {
                        crate::timeline::structure_changed(s);
                    }
                }
                if touched && let Some(reader) = &mut s.reader {
                    reader.clear_sync_undo();
                }
            }
            Event::Reasoning(id, event) => {
                if s.messages.iter().any(|m| m.id == id)
                    && let Some(reader) = &mut s.reader
                {
                    reader.clear_sync_undo();
                }
                let changed = chat::anchors::reasoning_changed(&s.messages, &id, &event);
                content::apply_reasoning(&mut s.messages, &id, &event);
                if changed {
                    crate::timeline::structure_changed(s);
                }
            }
            Event::StepUsage(id, usage) => {
                let mut touched = false;
                if let Some(row) = s
                    .messages
                    .iter_mut()
                    .find(|row| row.id == id && !row.completed)
                {
                    touched = true;
                    std::sync::Arc::make_mut(row).usage = Some(usage);
                }
                if touched && let Some(reader) = &mut s.reader {
                    reader.clear_sync_undo();
                }
            }
            Event::Tool(id, tool) => {
                let mut touched = false;
                if let Some(row) = s.messages.iter_mut().find(|row| {
                    row.id == id
                        && (!row.completed
                            || (tool.ended.is_some()
                                && row.parts.iter().any(|part| {
                                    matches!(
                                        part,
                                        content::Part::Tool(existing)
                                            if existing.id == tool.id
                                                && matches!(
                                                    existing.status.as_str(),
                                                    "streaming" | "running"
                                                )
                                    )
                                })))
                }) {
                    touched = true;
                    let inserted = !row.parts.iter().any(|part| matches!(part, content::Part::Tool(existing) if existing.id == tool.id));
                    content::install_tool(std::sync::Arc::make_mut(row), tool);
                    if inserted {
                        crate::timeline::structure_changed(s);
                    }
                }
                if touched && let Some(reader) = &mut s.reader {
                    reader.clear_sync_undo();
                }
            }
            Event::Done => s.phase = Phase::Ready,
            Event::Failed if content => {
                if let Some(reader) = &mut s.reader {
                    reader.failed();
                }
                chat::reader::fail_pending_page(s);
                s.paging = false;
                s.history_error = true;
            }
            Event::AuthenticationRequired(..) | Event::Failed => {
                s.stream_offline = true;
                s.transcript_display.tool_clock.pause();
                if matches!(&event, Event::AuthenticationRequired(..)) {
                    s.conversation_stream_connected = false;
                }
                s.transcript_display.receipts.clear();
                s.transcript_display.children.clear();
                s.transcript_display.pictures.clear();
                s.transcript_display.usage_family.close();
                #[cfg(target_arch = "wasm32")]
                if !platform::pairing::required(s) {
                    platform::pairing::observe(s);
                }
                if let Event::AuthenticationRequired(auth) = event {
                    if !settings::conversation_authentication(s, auth) {
                        continue;
                    }
                    // A pending send without a prior receipt was queued before the transport exited on 401.
                    composer::settle_pending(s, transport::PromptOutcome::Rejected);
                }
                s.composer.picker.set_attachments_supported(false);
                s.status_permissions.online(false);
                s.status_usage.disconnect();
                suspend_preserving_page_retry(s);
                git::online(s, false);
                if let Some(files) = &mut s.files {
                    files.online(false);
                }
                s.phase = Phase::Failed;
                if let Some(a) = s.agent.as_mut() {
                    a.online = false;
                    a.attention.disconnected();
                }
            }
        }
        s.revision += 1;
        changed = true;
    }
    if s.incoming
        .as_ref()
        .is_some_and(|receiver| receiver.is_closed() && receiver.is_empty())
    {
        let terminal_phase = matches!(s.phase, Phase::Failed) || {
            #[cfg(target_arch = "wasm32")]
            {
                matches!(s.phase, Phase::WorkspaceMissing)
            }
            #[cfg(not(target_arch = "wasm32"))]
            {
                false
            }
        };
        let needs_transition = s.conversation_stream_connected
            || !s.stream_offline
            || s.composer.pending()
            || !terminal_phase;
        s.conversation_stream_connected = false;
        if needs_transition {
            s.stream_offline = true;
            s.transcript_display.tool_clock.pause();
            if s.composer.pending() {
                composer::settle_pending(s, transport::PromptOutcome::Unconfirmed);
            }
            s.composer.picker.set_attachments_supported(false);
            s.status_permissions.online(false);
            s.status_usage.disconnect();
            suspend_preserving_page_retry(s);
            git::online(s, false);
            if let Some(files) = &mut s.files {
                files.online(false);
            }
            if let Some(a) = s.agent.as_mut() {
                a.online = false;
                a.attention.disconnected();
            }
            if !terminal_phase {
                s.phase = Phase::Failed;
            }
            changed = true;
        }
    }
    if super::tools::children::Children::poll_and_promote(s)
        | s.transcript_display.pictures.poll(&s.reads, &s.wake)
        | super::receipts::Receipts::poll(s, visible)
    {
        s.revision += 1;
        changed = true;
    }
    changed | super::usage::family::Totals::poll(s)
}

fn suspend_preserving_page_retry(s: &mut State) {
    let saved_retry = s.transcript_display.timeline.page_retry;
    let saved_history_error = s.history_error;
    let pending_edge = s
        .transcript_display
        .timeline
        .paging
        .as_ref()
        .map(|(_, edge)| *edge);
    chat::reader::suspend(s);
    if let Some(edge) = pending_edge.or(saved_retry) {
        s.transcript_display.timeline.page_retry = Some(edge);
        s.history_error = true;
    } else {
        s.history_error = saved_history_error;
    }
}

fn uses_workspace_attention(s: &State) -> bool {
    s.screen
        .launcher()
        .is_some_and(|launcher| launcher.catalogue_watch.is_some())
}
