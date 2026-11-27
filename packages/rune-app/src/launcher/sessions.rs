use super::{Backend, Instant, Launcher, Reply, Session, Sessions, State, TextEdit, Tx, bounded};
use crate::{Phase, catalog::SessionMissing};
use std::{
    collections::HashSet,
    hash::{DefaultHasher, Hash, Hasher},
};
const MAX_SESSION_PAGES: usize = 1_000;
const MAX_SESSION_TEXT_BYTES: usize = 24 * 1024 * 1024;

fn cursor_hash(cursor: &str) -> u64 {
    let mut hash = DefaultHasher::new();
    cursor.hash(&mut hash);
    hash.finish()
}

impl Launcher {
    pub(super) fn apply_directory_refresh(&mut self, page: Sessions, selected: Option<&str>) {
        if self.creation_uncertain_linked.is_none() {
            self.creation_uncertain = false;
        }
        self.listed_sessions = page.rows.iter().map(|row| row.id.clone()).collect();
        self.next = None;
        self.consumed_cursors.clear();
        // The first folder page cannot decide which linked sessions disappeared.
        self.apply_passive_listing(page, selected, false, false, false);
    }

    pub(super) fn consume_cursor(&mut self, cursor: &str) {
        self.consumed_cursors.insert(cursor_hash(cursor));
    }

    pub(crate) fn can_page(&self) -> bool {
        let bytes: usize = self
            .sessions
            .iter()
            .map(|row| row.id.len() + row.title.len())
            .sum();
        bytes < MAX_SESSION_TEXT_BYTES
            && self.next.as_ref().is_some_and(|next| {
                self.consumed_cursors.len() + 1 < MAX_SESSION_PAGES
                    && !self.consumed_cursors.contains(&cursor_hash(next))
            })
    }

    pub(crate) fn apply_passive_listing(
        &mut self,
        mut page: Sessions,
        selected: Option<&str>,
        authoritative: bool,
        includes_linked: bool,
        reset_cursor: bool,
    ) {
        if includes_linked && self.creation_uncertain_linked.is_some() {
            self.creation_uncertain = false;
            self.creation_uncertain_linked = None;
            if self.error == Some("rune.create_error") {
                self.error = None;
            }
        }
        let complete = page.next.is_none() && authoritative;
        let listed: HashSet<_> = page.rows.iter().map(|row| row.id.clone()).collect();
        let published = Instant::now();
        for id in &listed {
            self.visits.verified(id, published);
        }
        let mut bytes: usize = page
            .rows
            .iter()
            .map(|row| row.id.len() + row.title.len())
            .sum();
        for row in self.sessions.drain(..) {
            if listed.contains(&row.id) {
                continue;
            }
            let is_selected = selected == Some(row.id.as_str());
            if complete && !is_selected {
                continue;
            }
            let row_bytes = row.id.len() + row.title.len();
            if !is_selected && bytes.saturating_add(row_bytes) > MAX_SESSION_TEXT_BYTES {
                continue;
            }
            bytes = bytes.saturating_add(row_bytes);
            page.rows.push(row);
        }
        self.sessions = page.rows;
        self.visits.observe_listing(&listed);
        let root_page = authoritative || !includes_linked;
        if root_page && (reset_cursor || self.next.is_none() && page.next.is_some() || complete) {
            self.listed_sessions = listed;
            self.next = page.next;
            self.consumed_cursors.clear();
        }
        if complete && includes_linked {
            self.linked.replace_with_authoritative();
        }
        if complete {
            self.check_omitted_visits();
        }
    }

    pub(super) fn apply_listing(&mut self, mut page: Sessions, more: bool, selected: Option<&str>) {
        let listed: HashSet<_> = page.rows.iter().map(|row| row.id.clone()).collect();
        let published = Instant::now();
        for id in &listed {
            self.visits.verified(id, published);
        }
        if more {
            self.listed_sessions.extend(listed);
            let mut known: HashSet<_> = self.sessions.iter().map(|row| row.id.clone()).collect();
            self.sessions.extend(
                page.rows
                    .into_iter()
                    .filter(|row| known.insert(row.id.clone())),
            );
        } else {
            self.consumed_cursors.clear();
            if self.creation_uncertain_linked.is_none() {
                self.creation_uncertain = false;
            }
            if let Some(old) = self
                .sessions
                .iter()
                .find(|row| Some(row.id.as_str()) == selected && !listed.contains(&row.id))
            {
                page.rows.push(old.clone());
            }
            self.sessions = page.rows;
            self.listed_sessions = listed;
        }
        self.visits.observe_listing(&self.listed_sessions);
        self.next = page.next;
    }

    pub(super) fn listed_visits_not_seen(&self) -> Vec<String> {
        self.visits
            .listed_ids()
            .filter(|id| !self.listed_sessions.contains(*id))
            .map(str::to_owned)
            .collect()
    }

    pub(super) fn check_omitted_visits(&mut self) {
        self.visits.cancel_checks();
        let (Some(backend), Some(project)) = (self.connection.clone(), self.project.clone()) else {
            return;
        };
        let ids = self.listed_visits_not_seen();
        if ids.is_empty() {
            return;
        }
        let (out, checks) = bounded(ids.len());
        self.visits.start_checks(&ids, checks);
        let wake = self.wake.clone();
        // Results belong to the listing; dropping its receiver cancels the worker.
        crate::platform::spawn(async move {
            backend
                .confirm_missing_sessions(&project, ids, out, || wake())
                .await;
            wake();
        });
    }
}

pub fn list(s: &mut State, more: bool) {
    if !more {
        super::retry_detached_reconcile(s);
    }
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    if !more && l.projects_stale {
        super::connection::start_projects_refresh(l);
    }
    if !more && l.show_search && !l.search.text.trim().is_empty() {
        l.search_results = Default::default();
    }
    if l.pending {
        return;
    }
    if more && !l.can_page() {
        return;
    }
    l.listing = true;
    let cursor = if more { l.next.clone() } else { None };
    l.job("rune.list_error", async move {
        Ok(Reply::Listed(
            p.id.clone(),
            b.sessions(&p, cursor.as_deref()).await?,
            cursor,
        ))
    });
}
pub fn create_blank(s: &mut State) {
    if !can_change_session(s) || crate::git::placement_unconfirmed(s) {
        return;
    }
    let dismiss = s.shell.floating_sessions();
    let target = crate::git::session_directory(s);
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if l.pending || l.creation_uncertain {
        return;
    }
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    s.notifications.supersede_navigation();
    let ticket = s.notifications.navigation_ticket();
    crate::timeline::search::cancel_destination(s);
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    // A create request is never automatically retried. Refresh reconciles a lost response.
    l.job("rune.create_error", async move {
        let directory = match target {
            crate::git::SessionDirectory::Root => p.path.clone(),
            crate::git::SessionDirectory::ResolveSession(session_id) => {
                match b.session_directory(&p, &session_id).await {
                    Ok(directory) => directory,
                    Err(_) => return Ok(Reply::CreatePrecheckFailed),
                }
            }
        };
        let linked = !codenomad_client::same_server_path(&p.path, &directory);
        let session = match b.create_untitled_session(&p, &directory).await {
            Ok(session) => session,
            Err(error) if error.is::<codenomad_client::catalog::CreateRejected>() => {
                return Ok(Reply::CreateRejected);
            }
            Err(_) if linked => return Ok(Reply::CreateUncertainLinked(directory)),
            Err(error) => return Err(error),
        };
        match b.bind_created_session(&p, &session.id, &directory).await {
            Ok((backend, _, slug)) => Ok(Reply::Created(
                backend,
                session.title,
                slug,
                String::new(),
                dismiss,
                Some(ticket),
            )),
            Err(_) => Ok(Reply::CreatedUnbound(session, String::new())),
        }
    });
}
pub fn create(s: &mut State, _: &mut Tx) {
    if !can_change_session(s) {
        return;
    }
    let dismiss = s.shell.floating_sessions();
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if l.pending || l.creation_uncertain || l.title.text.trim().is_empty() {
        return;
    }
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    let title = l.title.text.clone();
    s.notifications.supersede_navigation();
    let ticket = s.notifications.navigation_ticket();
    crate::timeline::search::cancel_destination(s);
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    // A create request is never automatically retried. Refresh reconciles a lost response.
    l.job("rune.create_error", async move {
        let session = match b.create_session(&p, &title).await {
            Ok(session) => session,
            Err(error) if error.is::<codenomad_client::catalog::CreateRejected>() => {
                return Ok(Reply::CreateRejected);
            }
            Err(error) => return Err(error),
        };
        match b.bind_session_placed(&p, &session.id, true).await {
            Ok((backend, _, slug)) => Ok(Reply::Created(
                backend,
                session.title,
                slug,
                title,
                dismiss,
                Some(ticket),
            )),
            Err(_) => Ok(Reply::CreatedUnbound(session, title)),
        }
    });
}
pub fn choose(s: &mut State, id: String, tx: &mut Tx) {
    s.notifications.supersede_navigation();
    choose_destination(s, id, None, tx);
}

pub(crate) fn choose_child_ticket(s: &mut State, id: String, ticket: Option<u64>, tx: &mut Tx) {
    if !s.screen.is_launcher()
        && crate::workspace::active_session(s) == Some(id.as_str())
        && s.phase != Phase::Failed
    {
        if s.shell.floating_sessions().is_some() {
            s.shell.close_floating(tx);
        }
    } else {
        choose_from_inner(
            s,
            vec![(id, None)],
            s.shell.floating_sessions(),
            ticket,
            true,
            false,
        );
    }
}

pub(crate) fn choose_mission_conversation(s: &mut State, id: String, tx: &mut Tx) {
    s.notifications.supersede_navigation();
    if !s.screen.is_launcher()
        && crate::workspace::active_session(s) == Some(id.as_str())
        && s.phase != Phase::Failed
    {
        if s.shell.floating_panel().is_some() {
            s.shell.close_floating(tx);
        }
    } else {
        choose_from_inner(
            s,
            vec![(id, None)],
            s.shell.floating_panel(),
            None,
            true,
            true,
        );
    }
}

pub(super) fn retry_mission_conversation(s: &mut State, id: String) {
    choose_from_inner(s, vec![(id, None)], None, None, true, true);
}

pub(crate) fn choose_destination(s: &mut State, id: String, ticket: Option<u64>, tx: &mut Tx) {
    crate::shell::blank_cleanup::abort_for_session(s, &id);
    if !s.screen.is_launcher()
        && crate::workspace::active_session(s) == Some(id.as_str())
        && s.phase != Phase::Failed
    {
        if s.shell.floating_sessions().is_some() {
            s.shell.close_floating(tx);
        }
    } else {
        choose_from(s, vec![(id, None)], s.shell.floating_sessions(), ticket);
    }
}
fn choose_from(
    s: &mut State,
    candidates: Vec<(String, Option<usize>)>,
    dismiss: Option<u64>,
    ticket: Option<u64>,
) {
    choose_from_inner(s, candidates, dismiss, ticket, false, false);
}
fn choose_from_inner(
    s: &mut State,
    mut candidates: Vec<(String, Option<usize>)>,
    dismiss: Option<u64>,
    ticket: Option<u64>,
    allow_streaming: bool,
    close_mission_reader: bool,
) {
    let recovery = candidates
        .first()
        .is_some_and(|(id, step)| step.is_none() && can_rebind(s, id));
    let allowed = if allow_streaming {
        can_open_child_session(s)
    } else {
        can_change_session(s)
    };
    if candidates.is_empty() || !crate::workspace::input_ready(s) || !recovery && !allowed {
        return;
    }
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    if l.pending {
        return;
    }
    candidates.retain(|(id, _)| !crate::shell::blank_cleanup::is_deleting_session(s, &p.id, id));
    if candidates.is_empty() {
        return;
    }
    for (id, _) in &candidates {
        crate::shell::blank_cleanup::abort_for_session(s, id);
    }
    crate::timeline::search::cancel_destination(s);
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    l.selection_ticket = ticket;
    l.close_mission_reader_on_bind = close_mission_reader;
    if l.adopt_recovered_for
        .as_ref()
        .is_some_and(|(id, expected_ticket)| {
            !(candidates.len() == 1 && candidates[0].0 == *id && *expected_ticket == ticket)
        })
    {
        l.adopt_recovered_for = None;
    }
    l.rebinding_failed = recovery;
    l.job("sessionList.reload.error", async move {
        let mut missing = Vec::new();
        for (id, step) in candidates {
            let started = Instant::now();
            match b.bind_session_placed(&p, &id, false).await {
                Ok((bound, session, slug)) => {
                    return Ok(Reply::Selected(
                        missing,
                        Some((bound, session.title, step, started, slug)),
                        dismiss,
                        allow_streaming,
                    ));
                }
                Err(err) if err.is::<SessionMissing>() => missing.push((
                    id,
                    err.downcast_ref::<SessionMissing>()
                        .is_some_and(|reason| reason.is_deleted()),
                )),
                Err(err) if missing.is_empty() => return Err(err),
                Err(_) => break,
            }
        }
        Ok(Reply::Selected(missing, None, dismiss, allow_streaming))
    });
    if recovery {
        s.commands = None;
        s.incoming = None;
        s.phase = Phase::Reconnecting;
    }
}
fn session_switch_allowed(s: &State) -> bool {
    !s.composer.blocks_navigation()
        && !crate::workspace::unconfirmed_drafts_full(s)
        && !s.files.as_ref().is_some_and(|ui| ui.document.pending())
        && !s.transcript_display.messages.pending()
        && !s.status_permissions.settling()
        && crate::workspace::input_ready(s)
        && !crate::agent::navigation_blocked(s)
}

pub fn can_change_session(s: &State) -> bool {
    s.phase != Phase::Streaming && session_switch_allowed(s)
}

pub fn can_open_child_session(s: &State) -> bool {
    s.screen.launcher().is_some() && session_switch_allowed(s)
}

pub(crate) fn can_rebind_session(s: &State, id: &str) -> bool {
    can_rebind(s, id)
}

pub(super) fn can_rebind(s: &State, id: &str) -> bool {
    !s.screen.is_launcher()
        && s.phase == Phase::Failed
        && !s.composer.pending()
        && !s.status_permissions.writing()
        && crate::workspace::active_session(s) == Some(id)
}
pub fn can_visit(s: &State, back: bool) -> bool {
    s.screen
        .launcher()
        .is_some_and(|l| l.visits.steps(back, shown(s)).next().is_some())
}
pub fn visit(s: &mut State, back: bool) {
    let Some(l) = s.screen.launcher() else { return };
    let candidates = l
        .visits
        .steps(back, shown(s))
        .map(|(step, id)| (id.into(), Some(step)))
        .collect();
    s.notifications.supersede_navigation();
    choose_from(s, candidates, None, None);
}
fn shown(s: &State) -> Option<&str> {
    (!s.screen.is_launcher())
        .then(|| crate::workspace::active_session(s))
        .flatten()
}

pub(super) fn dismiss_origin_panel(s: &mut State, origin: Option<u64>, tx: &mut Tx) {
    if origin.is_some() && origin == s.shell.floating_panel() {
        s.shell.close_floating(tx);
    }
}

fn clear_conversation_only(s: &mut State) {
    s.attachments.cancel();
    s.composer.picker.reset();
    s.composer.device.cancel();
    s.commands = None;
    s.incoming = None;
    s.reader = None;
    s.agent = None;
    s.attachments = Default::default();
    s.composer = Default::default();
    s.transcript_display.messages = Default::default();
    s.transcript_display.pictures.clear();
    s.transcript_display.usage_family = Default::default();
    s.status_permissions.attach(None);
    s.status_services.attach(None);
    s.status_usage.invalidate();
    s.history_detached = false;
    s.stream_offline = false;
    s.messages.clear();
    s.chat_title.clear();
    s.draft = TextEdit::new("");
    s.phase = Phase::Ready;
}

pub fn close_session(s: &mut State, tx: &mut Tx) -> bool {
    let tab_key = s.workspace.as_ref().map(|ui| ui.active_key()).or_else(|| {
        s.screen
            .launcher()
            .and_then(|l| l.project.as_ref())
            .map(|p| p.id.as_str())
    });
    if s.screen.is_launcher()
        || !can_change_session(s)
        || s.composer.device.busy()
        || tab_key.is_some_and(|key| s.documents.has_tab_edits(key))
        || s.files
            .as_ref()
            .is_some_and(|ui| ui.document.pending() || ui.document.dirty())
        || s.screen
            .launcher()
            .is_none_or(|l| l.project.is_none() || l.pending)
    {
        return false;
    }
    let active = crate::workspace::active_session(s).map(str::to_owned);
    if s.workspace.is_some() {
        let Some(id) = active else {
            return false;
        };
        crate::workspace::unselect_session(s, &id);
    } else if !s.draft.text.is_empty()
        || !s.composer.draft.attachments.is_empty()
        || s.composer.unconfirmed_id().is_some()
        || s.command_receipts.has_for_state(s)
    {
        return false;
    }
    s.notifications.supersede_navigation();
    crate::timeline::search::close(s);
    clear_conversation_only(s);
    s.show_launcher();
    if let Some(files) = &mut s.files {
        files.close_reader();
        files.online(false);
    }
    if s.git.owner.is_some() {
        crate::git::online(s, false);
    }
    crate::git::detach_session(s);
    crate::workspace::schedule_catalogue_refresh(s);
    tx.instant();
    true
}

pub(super) fn retire_session(s: &mut State, id: &str, recover_draft: bool) {
    let unselected = if recover_draft {
        crate::workspace::unselect_missing(s, id)
    } else {
        crate::workspace::unselect_session(s, id)
    };
    if !unselected {
        return;
    }
    clear_conversation_only(s);
    s.files = None;
    s.show_launcher();
    if let Some(l) = s.screen.launcher_mut() {
        l.sessions.retain(|row| row.id != id);
        l.error = Some("rune.open_error");
    }
}
pub(super) fn bind(
    s: &mut State,
    b: Backend,
    title: String,
    visit: Option<usize>,
    slug: &str,
    tx: &mut Tx,
) {
    bind_at(s, b, title, visit, slug, None, false, tx);
}

pub(super) fn bind_created(s: &mut State, b: Backend, title: String, slug: &str, tx: &mut Tx) {
    bind_at(s, b, title, None, slug, None, true, tx);
}

pub(crate) fn bind_search(
    s: &mut State,
    b: Backend,
    title: String,
    slug: &str,
    message: String,
    tx: &mut Tx,
) {
    bind_at(s, b, title, None, slug, Some(message), false, tx);
}

#[allow(clippy::too_many_arguments)]
fn bind_at(
    s: &mut State,
    b: Backend,
    title: String,
    visit: Option<usize>,
    slug: &str,
    anchor: Option<String>,
    adopt_recovered: bool,
    tx: &mut Tx,
) {
    let same_session =
        !s.screen.is_launcher() && crate::workspace::active_session(s) == Some(b.session.as_str());
    let should_adopt = adopt_recovered
        || s.screen
            .launcher_mut()
            .and_then(|l| l.adopt_recovered_for.take())
            .is_some_and(|(id, expected_ticket)| {
                id == b.session
                    && expected_ticket
                        .is_none_or(|ticket| ticket == s.notifications.navigation_ticket())
            });
    if let Some(l) = s.screen.launcher_mut() {
        l.visits
            .record(&b.session, visit, l.listed_sessions.contains(&b.session));
        if let Some(row) = l.sessions.iter_mut().find(|row| row.id == b.session) {
            row.title.clone_from(&title);
        } else if let Some(row) = l.linked.rows.iter_mut().find(|row| row.id == b.session) {
            row.title.clone_from(&title);
        } else {
            l.sessions.insert(
                0,
                Session {
                    id: b.session.clone(),
                    title: title.clone(),
                },
            );
        }
    }
    let draft = crate::workspace::bound_with_adopt(s, &b, should_adopt);
    s.transcript_display.bind(&b.base, &b.workspace, &b.session);
    s.chat_title = title;
    if !same_session {
        s.reader = None;
        crate::files::bind(s, &b);
        s.agent = None;
        s.attachments = Default::default();
        s.messages.clear();
        s.can_older = false;
    } else if let Some(agent) = &mut s.agent {
        if !agent.uses_connection(&b) {
            agent.reauthenticate(crate::agent::start(b.clone(), s.wake.clone()));
            crate::files::bind(s, &b);
        } else {
            // This is the same owned occurrence and session; the in-flight reply guard stays live.
            agent.mark_offline();
            if matches!(s.phase, Phase::Failed | Phase::Reconnecting) {
                crate::git::close_preview(s);
                if let Some(files) = &mut s.files {
                    files.close_reader();
                }
            }
        }
    } else if s.files.as_ref().is_none_or(|ui| !ui.uses_connection(&b)) {
        crate::files::bind(s, &b);
    } else if matches!(s.phase, Phase::Failed | Phase::Reconnecting) {
        crate::git::close_preview(s);
        if let Some(files) = &mut s.files {
            files.close_reader();
        }
    }
    s.draft = TextEdit::new(draft);
    crate::composer::literal::restore(&mut s.draft, &s.composer.draft.literal_spans);
    if !(same_session && s.phase == Phase::Reconnecting) {
        s.phase = Phase::Loading;
    }
    crate::git::online(s, false);
    crate::git::connected_placed(s, &b, slug);
    crate::workspace::restore_files_mode(s);
    s.paging = false;
    s.history_error = false;
    s.history_detached = false;
    s.revision += 1;
    crate::transport::start_bound_at(s, b, anchor);
    s.show_chat();
    crate::workspace::capture(s);
    if !same_session {
        tx.scroll_to_bottom_instant("history");
    }
}

pub(super) fn attach(s: &mut State, b: Backend) {
    crate::transport::start_bound(s, b);
}
#[cfg(feature = "test-support")]
pub fn back(s: &mut State) {
    if !matches!(s.phase, Phase::Ready | Phase::Failed)
        || (!s.draft.text.is_empty() && s.workspace.is_none())
        || crate::agent::navigation_blocked(s)
        || s.screen.launcher().is_none()
    {
        return;
    }
    crate::workspace::capture(s);
    s.agent = None;
    s.commands = None;
    s.incoming = None;
    s.reader = None;
    s.files = None;
    if let Some(git) = &mut s.git.owner {
        git.online(false);
        git.close_preview();
    }
    s.show_launcher();
    list(s, false);
}
