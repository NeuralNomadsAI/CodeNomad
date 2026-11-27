#[cfg(target_arch = "wasm32")]
use crate::platform;
use crate::{
    Phase, State, agent, chat, composer, content, git, settings,
    transport::{self, Event},
    workspace,
};

pub(crate) fn poll_chat(s: &mut State, limit: usize) -> bool {
    drain_chat(s, limit, true, true, false, None)
}

pub(crate) fn poll_hidden_chat(s: &mut State, limit: usize, active_has_stream: bool) -> bool {
    drain_chat(s, limit, false, !active_has_stream, false, None)
}

pub(crate) fn poll_chat_for_window(
    s: &mut State,
    limit: usize,
    defer_reader_sync: bool,
    clock: f64,
) -> bool {
    drain_chat(s, limit, true, true, defer_reader_sync, Some(clock))
}

fn drain_chat(
    s: &mut State,
    limit: usize,
    visible: bool,
    affects_preferences: bool,
    defer_reader_sync: bool,
    clock: Option<f64>,
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
                reader.take_next(
                    defer_reader_sync,
                    reading,
                    history_bounds,
                    cached_gap,
                    clock,
                )
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
                s.status_services.bind(&backend);
                s.status_usage.bind(&backend);
                s.transcript_display.children.bind(backend.clone());
                s.transcript_display.usage_family.bind(backend.clone());
                s.transcript_display.pictures.bind(backend.clone());
                s.transcript_display.receipts.bind(backend.clone());
                s.transcript_display.messages.bind(backend.clone());
                s.transcript_display.queue.bind(backend.clone());
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
                    let newly_connected = !s.conversation_stream_connected;
                    s.conversation_stream_connected = true;
                    #[cfg(target_arch = "wasm32")]
                    platform::pairing::observe_conversation_authenticated(s, newly_connected);
                    #[cfg(not(target_arch = "wasm32"))]
                    let _ = newly_connected;
                    s.transcript_display.messages.refresh();
                    s.status_permissions.online(true);
                    s.status_services.online(true);
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
                if let Some(a) = s.agent.as_mut()
                    && !a.is_scope_missing()
                {
                    if catalog {
                        a.online = true;
                    }
                    a.refresh(catalog)
                }
            }
            Event::AgentControl(lane) => {
                if let Some(a) = s.agent.as_mut() {
                    match lane {
                        codenomad_client::transport::AgentLane::Session => a.refresh_session(false),
                        codenomad_client::transport::AgentLane::Permissions => {
                            a.refresh_permissions()
                        }
                        codenomad_client::transport::AgentLane::Forms => a.refresh_forms(),
                    }
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
            Event::Workspace(codenomad_client::transport::WorkspaceEvent::PluginsChanged {
                directory,
                ..
            }) => {
                s.status_services.invalidate_plugins(directory.as_deref());
            }
            Event::Workspace(codenomad_client::transport::WorkspaceEvent::McpStatusChanged {
                ..
            }) => {
                s.status_services.invalidate_mcp();
            }
            Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::ServicesConfigChanged { .. },
            ) => {
                s.status_services.invalidate_plugins(None);
                s.status_services.invalidate_mcp();
            }
            Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::ComposerCataloguesChanged,
            ) => {
                s.composer.picker.commands_changed(&s.reads, &s.wake);
                s.composer.picker.mentions_changed(&s.reads, &s.wake);
            }
            Event::ObservedRunning { running, version } => {
                if let Some(reader) = &mut s.reader {
                    reader.observed_running(running, version, s.phase == Phase::Streaming);
                }
                if s.phase != Phase::Reconnecting
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
                let local_attention = !uses_workspace_attention(s);
                if let Some(agent) = &mut s.agent {
                    if local_attention {
                        agent.notice_request(form, id);
                    } else if form {
                        agent.refresh_forms();
                    } else {
                        agent.refresh_permissions();
                    }
                }
            }
            Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::SessionRequestResolved { form, id },
            ) => {
                let local_attention = !uses_workspace_attention(s);
                if let Some(agent) = &mut s.agent {
                    if local_attention {
                        agent.resolve_request(form, &id);
                    } else if form {
                        agent.refresh_forms();
                    } else {
                        agent.refresh_permissions();
                    }
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
                        agent.refresh_session(false);
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
                    agent.refresh_session(false);
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
                    s.status_permissions.online(false);
                    s.status_services.location_moved();
                    s.status_usage.disconnect();
                    chat::reader::suspend(s);
                    s.composer.picker.set_attachments_supported(false);
                    s.attachments.cancel();
                    s.transcript_display.queue.clear();
                    s.messages.clear();
                    s.history_detached = false;
                    s.can_older = false;
                    if let Some(agent) = &mut s.agent {
                        agent.attention.disconnected();
                    }
                }
                if let codenomad_client::transport::WorkspaceEvent::Stopped { workspace_id } =
                    &event
                    && let Some(agent) = &mut s.agent
                {
                    agent.workspace_stopped(workspace_id);
                }
                workspace::mission_event(s, Some(&event));
                git::event(s, &event);
                if let Some(files) = &mut s.files {
                    files.event(event);
                }
            }
            Event::Preferences(owner) => {
                let newly_connected = !s.conversation_stream_connected;
                s.conversation_stream_connected = true;
                #[cfg(target_arch = "wasm32")]
                if newly_connected {
                    platform::pairing::observe_conversation_authenticated(s, true);
                }
                #[cfg(not(target_arch = "wasm32"))]
                let _ = newly_connected;
                settings::invalidate(s, owner);
            }
            event @ (Event::Sync(_) | Event::ReaderSync { .. }) => {
                let (page, reader_version) = match event {
                    Event::Sync(page) => (page, None),
                    Event::ReaderSync { page, version } => (page, Some(version)),
                    _ => continue,
                };
                let newly_connected = !s.conversation_stream_connected;
                s.conversation_stream_connected = true;
                #[cfg(target_arch = "wasm32")]
                platform::pairing::observe_conversation_authenticated(s, newly_connected);
                #[cfg(not(target_arch = "wasm32"))]
                let _ = newly_connected;
                if s.reader.is_none() {
                    // Direct startup also uses Reconnecting to stage a fresh transcript read.
                    s.status_permissions.synchronized();
                    s.status_services.synchronized();
                }
                if chat::reader::reconcile_bookmark(s, &page) {
                    s.revision += 1;
                    changed = true;
                    continue;
                }
                let sync_undo = if let Some(version) = reader_version
                    && !s.messages.is_empty()
                    && s.reader
                        .as_ref()
                        .is_some_and(chat::reader::Reader::is_resuming)
                {
                    let trimmed_older = page.older.is_some()
                        && s.messages
                            .first()
                            .is_some_and(|first| !page.rows.iter().any(|r| r.id == first.id));
                    let trimmed_newer = page.newer.is_some()
                        && s.messages
                            .last()
                            .is_some_and(|last| !page.rows.iter().any(|r| r.id == last.id));
                    (trimmed_older || trimmed_newer).then(|| {
                        (
                            version,
                            page.clone(),
                            std::mem::take(&mut s.messages),
                            s.can_older,
                            s.history_detached,
                            s.phase,
                            trimmed_older,
                            trimmed_newer,
                        )
                    })
                } else {
                    None
                };
                let had_sync_undo = sync_undo.is_some();
                if let Some(reader) = &mut s.reader {
                    reader.clear_sync_undo();
                    if let Some((
                        version,
                        page_copy,
                        prev_rows,
                        prev_can_older,
                        prev_detached,
                        prev_phase,
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
                            prev_phase,
                            trimmed_older,
                            trimmed_newer,
                            clock,
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
                if let Some(a) = s.agent.as_mut()
                    && !a.is_scope_missing()
                    && (!a.online || a.running != page.running)
                {
                    a.online = true;
                    s.composer.picker.refresh_commands(&s.reads, &s.wake);
                    a.refresh(false);
                }
                let previous_rows = if !had_sync_undo {
                    std::mem::take(&mut s.messages)
                } else {
                    Vec::new()
                };
                if !previous_rows.is_empty() {
                    chat::reader::preserve_anchor_on_displacement(s, &previous_rows, &page.rows);
                }
                s.messages = page.rows;
                s.transcript_display.queue.prune_committed(&s.messages);
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
                    s.history_error = false;
                    s.transcript_display.timeline.page_retry = None;
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
                s.conversation_stream_connected = false;
                workspace::suspend_mission_briefing(s);
                s.transcript_display.messages.offline();
                s.transcript_display.queue.offline();
                s.transcript_display.tool_clock.pause();
                s.status_permissions.online(false);
                s.status_services.online(false);
                s.composer.picker.set_attachments_supported(false);
                chat::reader::reconnecting(s);
                #[cfg(target_arch = "wasm32")]
                if matches!(event, Event::ConnectionLost) && !platform::pairing::required(s) {
                    platform::pairing::observe(s);
                }
                git::online(s, false);
                if let Some(files) = &mut s.files {
                    files.online(false);
                }
                if !s.history_detached {
                    s.phase = Phase::Reconnecting;
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
                s.transcript_display.queue.clear();
                s.messages.clear();
                s.history_detached = false;
                s.can_older = false;
                s.paging = false;
                s.phase = Phase::Reconnecting;
            }
            Event::WorkspaceMissing => {
                s.conversation_stream_connected = false;
                s.transcript_display.receipts.clear();
                s.status_permissions.online(false);
                s.status_services.online(false);
                s.status_usage.disconnect();
                if let Some(a) = s.agent.as_mut() {
                    a.mark_scope_missing();
                }
                s.transcript_display.children.clear();
                s.transcript_display.tool_clock.reset();
                s.transcript_display.pictures.clear();
                s.transcript_display.queue.clear();
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
                s.transcript_display.tool_clock.resume();
                s.conversation_stream_connected = true;
                if let Some(reader) = &mut s.reader {
                    reader.clear_sync_undo();
                }
                s.messages = messages;
                s.phase = Phase::Ready;
            }
            Event::Message(m) => {
                if !s.messages.iter().any(|existing| existing.id == m.id) {
                    if let Some(reader) = &mut s.reader {
                        reader.clear_sync_undo();
                    }
                    s.messages.push(m.into());
                }
            }
            Event::Inbox {
                items,
                authoritative,
                fence,
            } => {
                if !authoritative || !chat::queue::receive_authoritative(s, items, fence) {
                    continue;
                }
            }
            Event::InboxDelta(delta) => {
                if let codenomad_client::inbox::InboxDelta::Upsert(ref item) = delta
                    && s.messages.iter().any(|row| row.id == item.id)
                {
                    continue;
                }
                let Some(next) = s.transcript_display.queue.preview_delta(&delta) else {
                    continue;
                };
                chat::reader::preserve_anchor_on_inbox_change(s, &next);
                s.transcript_display.queue.apply_preview(next);
            }
            Event::InboxFailed => {
                s.transcript_display.queue.failed();
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
                chat::reader::cancel_page(s);
                s.paging = false;
                s.history_error = true;
            }
            Event::AuthenticationRequired(..) | Event::Failed => {
                s.transcript_display.tool_clock.pause();
                if matches!(&event, Event::AuthenticationRequired(..)) {
                    s.conversation_stream_connected = false;
                }
                s.transcript_display.receipts.clear();
                s.transcript_display.children.clear();
                s.transcript_display.pictures.clear();
                s.transcript_display.usage_family.close();
                #[cfg(target_arch = "wasm32")]
                if matches!(&event, Event::Failed) && !platform::pairing::required(s) {
                    platform::pairing::observe(s);
                }
                if let Event::AuthenticationRequired(auth) = event
                    && !settings::conversation_authentication(s, auth)
                {
                    continue;
                }
                s.composer.picker.set_attachments_supported(false);
                s.status_permissions.online(false);
                s.status_services.online(false);
                s.status_usage.disconnect();
                chat::reader::suspend(s);
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
        s.conversation_stream_connected = false;
        if s.composer.pending() || s.phase == Phase::Reconnecting {
            s.transcript_display.tool_clock.pause();
            composer::settle_pending(s, transport::PromptOutcome::Unconfirmed);
            s.phase = Phase::Failed;
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

fn uses_workspace_attention(s: &State) -> bool {
    s.screen
        .launcher()
        .is_some_and(|launcher| launcher.catalogue_watch.is_some())
}
