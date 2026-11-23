use super::{Backend, Instant, Launcher, Reply, Session, Sessions, State, TextEdit, Tx, bounded};
use crate::{Phase, catalog::SessionMissing};
use std::{
    collections::HashSet,
    hash::{DefaultHasher, Hash, Hasher},
};
const MAX_SESSION_PAGES: usize = 1_000;

fn cursor_hash(cursor: &str) -> u64 {
    let mut hash = DefaultHasher::new();
    cursor.hash(&mut hash);
    hash.finish()
}

impl Launcher {
    pub(super) fn apply_directory_refresh(&mut self, page: Sessions, selected: Option<&str>) {
        self.creation_uncertain = false;
        self.listed_sessions = page.rows.iter().map(|row| row.id.clone()).collect();
        self.next = None;
        self.consumed_cursors.clear();
        // The first folder page cannot decide which linked sessions disappeared.
        self.apply_passive_listing(page, selected, false);
    }

    pub(super) fn consume_cursor(&mut self, cursor: &str) {
        self.consumed_cursors.insert(cursor_hash(cursor));
    }

    pub(crate) fn can_page(&self) -> bool {
        self.next.as_ref().is_some_and(|next| {
            self.consumed_cursors.len() + 1 < MAX_SESSION_PAGES
                && !self.consumed_cursors.contains(&cursor_hash(next))
        })
    }

    pub(crate) fn apply_passive_listing(
        &mut self,
        mut page: Sessions,
        selected: Option<&str>,
        authoritative: bool,
    ) {
        let complete = page.next.is_none() && authoritative;
        let listed: HashSet<_> = page.rows.iter().map(|row| row.id.clone()).collect();
        let published = Instant::now();
        for id in &listed {
            self.visits.verified(id, published);
        }
        page.rows.extend(self.sessions.drain(..).filter(|row| {
            (!complete || selected == Some(row.id.as_str())) && !listed.contains(&row.id)
        }));
        self.sessions = page.rows;
        self.visits.observe_listing(&listed);
        if self.next.is_none() && page.next.is_some() || complete {
            self.listed_sessions = listed;
            self.next = page.next;
            self.consumed_cursors.clear();
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
            self.creation_uncertain = false;
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
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    if l.pending || more && !l.can_page() {
        return;
    }
    l.listing = true;
    let cursor = if more { l.next.clone() } else { None };
    l.job("rune.list_error", async move {
        Ok(Reply::Listed(
            b.sessions(&p, cursor.as_deref()).await?,
            cursor,
        ))
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
    if l.creation_uncertain || l.title.text.trim().is_empty() {
        return;
    }
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    let title = l.title.text.clone();
    // A create request is never automatically retried. Refresh reconciles a lost response.
    l.job("rune.create_error", async move {
        let session = b.create_session(&p, &title).await?;
        let (backend, _, slug) = b.bind_session_placed(&p, &session.id, true).await?;
        Ok(Reply::Created(backend, session.title, slug, title, dismiss))
    });
}
pub fn choose(s: &mut State, id: String, tx: &mut Tx) {
    if !s.screen.is_launcher()
        && crate::workspace::active_session(s) == Some(id.as_str())
        && s.phase != Phase::Failed
    {
        if s.shell.floating_sessions().is_some() {
            s.shell.close_floating(tx);
        }
    } else {
        choose_from(s, vec![(id, None)], s.shell.floating_sessions());
    }
}
fn choose_from(s: &mut State, candidates: Vec<(String, Option<usize>)>, dismiss: Option<u64>) {
    let recovery = candidates
        .first()
        .is_some_and(|(id, step)| step.is_none() && can_rebind(s, id));
    if candidates.is_empty()
        || !crate::workspace::input_ready(s)
        || !recovery && !can_change_session(s)
    {
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
    l.job("rune.open_error", async move {
        let mut missing = Vec::new();
        for (id, step) in candidates {
            let started = Instant::now();
            match b.bind_session_placed(&p, &id, false).await {
                Ok((bound, session, slug)) => {
                    return Ok(Reply::Selected(
                        missing,
                        Some((bound, session.title, step, started, slug)),
                        dismiss,
                    ));
                }
                Err(err) if err.is::<SessionMissing>() => missing.push(id),
                Err(err) if missing.is_empty() => return Err(err),
                Err(_) => break,
            }
        }
        Ok(Reply::Selected(missing, None, dismiss))
    });
}
pub fn can_change_session(s: &State) -> bool {
    s.phase != Phase::Streaming
        && crate::workspace::input_ready(s)
        && !crate::agent::navigation_blocked(s)
}
pub(super) fn can_rebind(s: &State, id: &str) -> bool {
    !s.screen.is_launcher()
        && s.phase == Phase::Failed
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
    choose_from(s, candidates, None);
}
fn shown(s: &State) -> Option<&str> {
    (!s.screen.is_launcher())
        .then(|| crate::workspace::active_session(s))
        .flatten()
}

pub(super) fn dismiss_origin_panel(s: &mut State, origin: Option<u64>, tx: &mut Tx) {
    if origin.is_some() && origin == s.shell.floating_sessions() {
        s.shell.close_floating(tx);
    }
}

pub(super) fn retire_session(s: &mut State, id: &str) {
    if !crate::workspace::unselect_missing(s, id) {
        return;
    }
    s.commands = None;
    s.incoming = None;
    s.agent = None;
    s.files = None;
    s.messages.clear();
    s.chat_title.clear();
    s.draft = TextEdit::new("");
    s.phase = Phase::Ready;
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
    let same_session =
        !s.screen.is_launcher() && crate::workspace::active_session(s) == Some(b.session.as_str());
    let mut reauthenticated = false;
    if let Some(l) = s.screen.launcher_mut() {
        reauthenticated = l.reauthenticated_session.take().as_deref() == Some(b.session.as_str());
        l.visits
            .record(&b.session, visit, l.listed_sessions.contains(&b.session));
        if let Some(row) = l.sessions.iter_mut().find(|row| row.id == b.session) {
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
    let draft = crate::workspace::bound(s, &b);
    s.transcript_display.bind(&b.base, &b.workspace, &b.session);
    s.chat_title = title;
    if !same_session {
        crate::files::bind(s, &b);
        s.agent = None;
        s.messages.clear();
        s.can_older = false;
    } else if let Some(agent) = &mut s.agent {
        if reauthenticated {
            agent.reauthenticate(crate::agent::start(b.clone(), s.wake.clone()));
            crate::files::bind(s, &b);
        } else {
            // This is the same owned occurrence and session; the in-flight reply guard stays live.
            agent.online = false;
            agent.pending_known = false;
        }
    }
    s.draft = TextEdit::new(draft);
    s.phase = Phase::Loading;
    crate::git::online(s, false);
    crate::git::connected_placed(s, &b, slug);
    crate::workspace::restore_files_mode(s);
    s.paging = false;
    s.history_error = false;
    s.revision += 1;
    crate::transport::start_bound(s, b);
    s.show_chat();
    crate::workspace::capture(s);
    if !same_session {
        tx.scroll_to_bottom_instant("history");
    }
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
    s.files = None;
    if let Some(git) = &mut s.git.owner {
        git.online(false);
        git.close_preview();
    }
    s.show_launcher();
    list(s, false);
}
