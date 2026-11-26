use super::{Preferences, ServerOwner};
use crate::{backend::Backend, platform, strings::t};
use codenomad_client::{Receiver, Sender, bounded, settings::config_files as api};
use rune::{El, TextEdit, Waker, col, text};
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
mod syntax;

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

#[derive(Default)]
pub(super) struct Editor {
    authority: Arc<AtomicU64>,
    owner: Option<ServerOwner>,
    files: Option<Vec<api::File>>,
    active: Option<usize>,
    original: Option<String>,
    draft: TextEdit,
    exists: bool,
    crlf: bool,
    syntax_line: Option<usize>,
    read: Option<(Stamp, Sender<()>, Receiver<Read>)>,
    write: Option<Receiver<(String, bool)>>,
    goal: Option<usize>,
    confirm: Option<usize>,
    notice: Option<&'static str>,
    saved_notice: bool,
    last_stamp: Option<Stamp>,
    verified_stamp: Option<Stamp>,
    reverify: bool,
    conflict: bool,
}

type Stamp = (u64, u64, u64);

enum Read {
    List(Option<Vec<api::File>>),
    Content(usize, Option<api::Content>),
    Verify(usize, Option<api::Content>),
    Unverified,
}

enum ReadKind {
    List,
    Content(usize, String),
    Verify(usize, String),
}

impl Editor {
    pub fn dirty(&self) -> bool {
        self.original
            .as_ref()
            .is_some_and(|saved| saved != &self.draft.text)
    }

    pub fn busy(&self) -> bool {
        self.write.is_some()
    }

    pub fn suspend(&mut self) {
        self.read = None;
        self.goal = None;
        self.confirm = None;
    }

    pub fn has_editor(&self) -> bool {
        self.active.is_some() || self.dirty()
    }

    fn current_stamp(prefs: &Preferences, backend: &Backend) -> Stamp {
        (
            prefs.authority_handle().load(Ordering::SeqCst),
            backend.client.drop_generation(),
            backend.client.stream_drop_epoch(),
        )
    }

    pub fn can_write(&self, prefs: &Preferences) -> bool {
        !self.reverify
            && !self.conflict
            && prefs.can_retry()
            && !prefs.transport_lost()
            && prefs.backend.as_ref().is_some_and(|backend| {
                self.owner
                    .as_ref()
                    .is_some_and(|owner| owner.verified_for_write(backend))
                    && (self.active.is_none()
                        || self.verified_stamp == Some(Self::current_stamp(prefs, backend)))
            })
    }

    pub fn poll(&mut self, prefs: &Preferences, wake: &Waker, visible: bool) -> bool {
        let mut changed = false;
        if let Some(backend) = prefs.backend.as_ref()
            && let Some(owner) = self.owner.as_mut()
        {
            if owner.same_backend_server(backend) {
                if owner.adopt_same_server(backend) {
                    // Re-authenticated to the same server: preserve loaded files and unsaved edits,
                    // cancelling reads and invalidating the baseline stamp so clean files reload
                    // and dirty drafts run a non-destructive baseline check before any PUT.
                    self.authority.fetch_add(1, Ordering::SeqCst);
                    self.read = None;
                    self.verified_stamp = None;
                    self.last_stamp = None;
                    self.saved_notice = false;
                    if let Some(index) = self.active {
                        self.conflict = false;
                        self.notice = None;
                        if self.dirty() {
                            self.reverify = true;
                        } else {
                            self.reverify = false;
                            self.goal = Some(index);
                        }
                    }
                    changed = true;
                }
            } else {
                self.authority.fetch_add(1, Ordering::SeqCst);
                let authority = self.authority.clone();
                *self = Self {
                    authority,
                    owner: Some(ServerOwner::from_backend(backend)),
                    ..Self::default()
                };
                changed = true;
            }
        }
        // Drain in-flight saves even while authentication/transport is down so busy() never
        // locks Preferences open; a foreign owner adoption above already dropped stale writes.
        if let Some(inbox) = self.write.as_ref() {
            match inbox.try_recv() {
                Ok((draft, saved)) => {
                    self.write = None;
                    if saved {
                        self.original = Some(draft);
                        self.exists = true;
                        self.notice = None;
                        self.saved_notice = true;
                    } else {
                        self.saved_notice = false;
                        self.notice = Some("settings.configFiles.errors.save");
                    }
                    changed = true;
                }
                Err(_) if inbox.is_closed() => {
                    self.write = None;
                    self.saved_notice = false;
                    self.notice = Some("settings.configFiles.errors.save");
                    changed = true;
                }
                Err(_) => {}
            }
        }
        let Some(backend) = prefs.backend.as_ref().filter(|_| prefs.can_retry()) else {
            self.suspend();
            return changed;
        };
        if !visible {
            self.suspend();
            return changed;
        }
        self.owner
            .get_or_insert_with(|| ServerOwner::from_backend(backend));
        if prefs.transport_lost() || !ServerOwner::backend_verified(backend) {
            if self.read.take().is_some() || self.goal.take().is_some() {
                changed = true;
            }
            return changed;
        }
        let stamp = Self::current_stamp(prefs, backend);
        let stamp_changed = self.last_stamp != Some(stamp);
        if stamp_changed {
            self.last_stamp = Some(stamp);
            self.saved_notice = false;
            if let Some(index) = self.active
                && self.verified_stamp != Some(stamp)
                && !self.busy()
            {
                self.notice = None;
                if self.dirty() {
                    self.reverify = true;
                    self.conflict = false;
                } else {
                    self.reverify = false;
                    self.conflict = false;
                    self.goal = Some(index);
                }
                changed = true;
            }
        } else if let Some(index) = self.active
            && self.verified_stamp != Some(stamp)
            && !self.busy()
        {
            if self.dirty() {
                if !self.reverify && !self.conflict {
                    self.reverify = true;
                    self.notice = None;
                    changed = true;
                }
            } else if self.goal != Some(index) && self.read.is_none() && self.notice.is_none() {
                self.reverify = false;
                self.conflict = false;
                self.goal = Some(index);
                changed = true;
            }
        }
        if let Some((read_stamp, _, inbox)) = self.read.as_ref() {
            if *read_stamp != stamp {
                self.read = None;
                changed = true;
            } else {
                match inbox.try_recv() {
                    Ok(result) => {
                        self.read = None;
                        let still_verified = !prefs.transport_lost()
                            && ServerOwner::backend_verified(backend)
                            && self
                                .owner
                                .as_ref()
                                .is_some_and(|owner| owner.same_backend_server(backend));
                        if !still_verified || matches!(result, Read::Unverified) {
                            self.goal = None;
                        } else {
                            match result {
                                Read::List(Some(files)) => {
                                    self.goal = (!files.is_empty()).then_some(0);
                                    self.files = Some(files);
                                }
                                Read::List(None) => {
                                    self.notice = Some("settings.configFiles.errors.loadList");
                                }
                                Read::Content(index, Some(content)) => {
                                    if self.goal == Some(index) {
                                        self.goal = None;
                                    }
                                    self.active = Some(index);
                                    self.exists = content.exists;
                                    self.crlf = content.contents.contains("\r\n")
                                        && !content.contents.replace("\r\n", "").contains('\n');
                                    let input = content.contents.replace("\r\n", "\n");
                                    self.draft = TextEdit::new(&input);
                                    self.original = Some(input);
                                    self.verified_stamp = Some(stamp);
                                    self.reverify = false;
                                    self.conflict = false;
                                    self.diagnose();
                                }
                                Read::Content(_, None) => {
                                    self.goal = None;
                                    self.notice = Some("settings.configFiles.errors.loadContent");
                                }
                                Read::Verify(index, Some(content)) => {
                                    if self.active == Some(index) {
                                        let disk_crlf = content.contents.contains("\r\n")
                                            && !content.contents.replace("\r\n", "").contains('\n');
                                        let disk = content.contents.replace("\r\n", "\n");
                                        let unchanged = content.exists == self.exists
                                            && self.original.as_deref() == Some(disk.as_str());
                                        self.reverify = false;
                                        if unchanged {
                                            self.crlf = disk_crlf;
                                            self.verified_stamp = Some(stamp);
                                            self.conflict = false;
                                            self.notice = None;
                                        } else {
                                            self.verified_stamp = None;
                                            self.conflict = true;
                                            self.notice = Some("settings.configFiles.errors.save");
                                        }
                                    } else {
                                        self.reverify = false;
                                    }
                                }
                                Read::Verify(_, None) => {
                                    self.notice = Some("settings.configFiles.errors.loadContent");
                                }
                                Read::Unverified => {}
                            }
                        }
                        changed = true;
                    }
                    Err(_) if inbox.is_closed() => {
                        self.read = None;
                        self.goal = None;
                        self.notice = Some(if self.files.is_none() {
                            "settings.configFiles.errors.loadList"
                        } else {
                            "settings.configFiles.errors.loadContent"
                        });
                        changed = true;
                    }
                    Err(_) => {}
                }
            }
        }
        if self.read.is_none()
            && !self.busy()
            && self.notice.is_none()
            && !prefs.transport_lost()
            && ServerOwner::backend_verified(backend)
        {
            if self.files.is_none() {
                self.start_read(prefs, backend, stamp, wake, ReadKind::List);
                changed = true;
            } else if let Some(index) = self.goal.or_else(|| self.active.is_none().then_some(0))
                && let Some(id) = self
                    .files
                    .as_ref()
                    .and_then(|files| files.get(index))
                    .map(|file| file.id.clone())
            {
                self.goal = Some(index);
                self.start_read(prefs, backend, stamp, wake, ReadKind::Content(index, id));
                changed = true;
            } else if self.reverify
                && let Some(index) = self.active
                && let Some(id) = self
                    .files
                    .as_ref()
                    .and_then(|files| files.get(index))
                    .map(|file| file.id.clone())
            {
                self.start_read(prefs, backend, stamp, wake, ReadKind::Verify(index, id));
                changed = true;
            }
        }
        changed
    }

    fn start_read(
        &mut self,
        prefs: &Preferences,
        backend: &Backend,
        stamp: Stamp,
        wake: &Waker,
        kind: ReadKind,
    ) {
        let (cancel, cancelled) = bounded(1);
        let (out, reply) = bounded(1);
        self.read = Some((stamp, cancel, reply));
        let (backend, wake) = (backend.clone(), wake.clone());
        let expected_server = self
            .owner
            .as_ref()
            .and_then(|o| o.server().map(str::to_owned));
        let prefs_auth = prefs.authority_handle();
        let (prefs_gen, prepared_gen, prepared_stream_epoch) = stamp;
        let editor_auth = self.authority.clone();
        let editor_gen = editor_auth.load(Ordering::SeqCst);
        platform::spawn(async move {
            let still_ok = || {
                prefs_auth.load(Ordering::SeqCst) == prefs_gen
                    && editor_auth.load(Ordering::SeqCst) == editor_gen
                    && backend.client.drop_generation() == prepared_gen
                    && backend.client.stream_drop_epoch() == prepared_stream_epoch
                    && ServerOwner::backend_verified(&backend)
                    && expected_server
                        .as_deref()
                        .is_none_or(|id| backend.client.server_identity() == Some(id))
            };
            let read = async {
                if !still_ok() {
                    return Read::Unverified;
                }
                let failed = |kind: &ReadKind| match kind {
                    ReadKind::List => Read::List(None),
                    ReadKind::Content(index, _) => Read::Content(*index, None),
                    ReadKind::Verify(index, _) => Read::Verify(*index, None),
                };
                if backend.client.tracks_server_attestation()
                    && backend.attest_server().await.is_err()
                {
                    return if still_ok() {
                        failed(&kind)
                    } else {
                        Read::Unverified
                    };
                }
                if !still_ok() {
                    return Read::Unverified;
                }
                let result = match &kind {
                    ReadKind::List => Read::List(api::list(&backend).await.ok()),
                    ReadKind::Content(index, id) => {
                        Read::Content(*index, api::read(&backend, id).await.ok())
                    }
                    ReadKind::Verify(index, id) => {
                        Read::Verify(*index, api::read(&backend, id).await.ok())
                    }
                };
                if !still_ok() {
                    return Read::Unverified;
                }
                if backend.client.tracks_server_attestation()
                    && backend.attest_server().await.is_err()
                {
                    return if still_ok() {
                        failed(&kind)
                    } else {
                        Read::Unverified
                    };
                }
                if !still_ok() {
                    Read::Unverified
                } else {
                    result
                }
            };
            if let Some(result) = platform::reads::cancellable(&cancelled, read).await
                && out.try_send(result).is_ok()
            {
                wake();
            }
        });
    }

    fn choose(&mut self, index: usize) {
        if self.busy() || self.read.is_some() {
            return;
        }
        if self.dirty() {
            self.confirm = Some(index);
        } else {
            self.reload(index);
        }
    }

    fn reload(&mut self, index: usize) {
        self.notice = None;
        self.saved_notice = false;
        self.goal = Some(index);
    }

    fn diagnose(&mut self) {
        let language = self
            .active
            .and_then(|index| self.files.as_ref()?.get(index))
            .map(|file| file.language.as_str());
        self.syntax_line = match language {
            Some("json") => syntax::error_line(&self.draft.text, false),
            Some("jsonc") => syntax::error_line(&self.draft.text, true),
            _ => None,
        };
    }

    fn save(&mut self, prefs: &Preferences) {
        if !self.can_write(prefs) {
            return;
        }
        let Some(backend) = prefs.backend.as_ref() else {
            return;
        };
        let Some(file) = self
            .active
            .and_then(|index| self.files.as_ref()?.get(index))
        else {
            return;
        };
        let Some(wake) = prefs.window_wake.as_ref().or(prefs.main_wake.as_ref()) else {
            return;
        };
        if self.busy()
            || self.read.is_some()
            || !self.dirty()
            || self.draft.text.len() > api::MAX_CONTENT
        {
            return;
        }
        let (out, inbox) = bounded(1);
        let (backend, wake, id, draft) = (
            backend.clone(),
            wake.clone(),
            file.id.clone(),
            self.draft.text.clone(),
        );
        let expected_server = self
            .owner
            .as_ref()
            .and_then(|o| o.server().map(str::to_owned));
        let prepared_gen = backend.client.drop_generation();
        let prepared_stream_epoch = backend.client.stream_drop_epoch();
        let prefs_auth = prefs.authority_handle();
        let prefs_gen = prefs_auth.load(Ordering::SeqCst);
        let editor_auth = self.authority.clone();
        let editor_gen = editor_auth.load(Ordering::SeqCst);
        let payload = if self.crlf {
            draft.replace('\n', "\r\n")
        } else {
            draft.clone()
        };
        self.write = Some(inbox);
        self.notice = None;
        self.saved_notice = false;
        platform::spawn(async move {
            let same_server = || {
                backend.client.drop_generation() == prepared_gen
                    && ServerOwner::backend_verified(&backend)
                    && expected_server
                        .as_deref()
                        .is_none_or(|id| backend.client.server_identity() == Some(id))
            };
            let still_authorized = || {
                prefs_auth.load(Ordering::SeqCst) == prefs_gen
                    && editor_auth.load(Ordering::SeqCst) == editor_gen
                    && backend.client.stream_drop_epoch() == prepared_stream_epoch
                    && same_server()
            };
            // Re-attest live HTTP routing right before sending the draft when attestation is
            // tracked; the server HTTP route has no server-id precondition header, so a fresh
            // /api/meta check on the same client prevents sending to a foreign profile even if
            // SSE remained attached to the old host.
            let verified = if !still_authorized() {
                false
            } else if backend.client.tracks_server_attestation() {
                backend.attest_server().await.is_ok() && still_authorized()
            } else {
                true
            };
            let saved = if !verified || !still_authorized() {
                false
            } else {
                match api::save(&backend, &id, &payload).await {
                    Ok(()) => {
                        same_server()
                            && (!backend.client.tracks_server_attestation()
                                || backend.attest_server().await.is_ok())
                            && same_server()
                    }
                    Err(_) => {
                        let read_ok = still_authorized()
                            && (!backend.client.tracks_server_attestation()
                                || backend.attest_server().await.is_ok())
                            && still_authorized()
                            && api::read(&backend, &id).await.is_ok_and(|content| {
                                still_authorized() && content.exists && content.contents == payload
                            });
                        read_ok
                            && (!backend.client.tracks_server_attestation()
                                || backend.attest_server().await.is_ok())
                            && still_authorized()
                    }
                }
            };
            if out.try_send((draft, saved)).is_ok() {
                wake();
            }
        });
    }

    pub fn view<S: 'static>(
        &self,
        layers: &mut Vec<El>,
        shared: &std::rc::Rc<std::cell::RefCell<Preferences>>,
        edit: fn(&mut S) -> &mut Editor,
    ) -> El {
        let prefs = shared.borrow();
        let readable = prefs.can_retry()
            && !prefs.transport_lost()
            && prefs.backend.as_ref().is_some_and(|backend| {
                self.owner
                    .as_ref()
                    .is_some_and(|owner| owner.verified_for_write(backend))
            });
        let writable = self.can_write(&prefs);
        drop(prefs);
        let waiting =
            self.busy() || self.read.is_some() || (self.goal.is_some() && self.notice.is_none());
        let files = self.files.as_deref().unwrap_or_default();
        let names: Vec<_> = files.iter().map(|file| file.label.as_str()).collect();
        let mut view = col().full_width().separate(Space::Sm);
        if files.is_empty() && !waiting && self.notice.is_none() {
            view = view.child(text(t("settings.configFiles.empty")));
        }
        if !files.is_empty() {
            view = view.child(chrome::segments(
                t("settings.configFiles.selector.label"),
                &names,
                self.active,
                waiting || !readable,
                move |s, index| {
                    let editor = edit(s);
                    if editor.active != Some(index) {
                        editor.choose(index);
                    }
                },
            ));
        }
        if let Some(index) = self.active {
            let shared = shared.clone();
            view = view
                .child(text(&files[index].path).literal_direction().wrap())
                .child(
                    layout::textarea(&self.draft)
                        .rows(12)
                        .label(t("settings.configFiles.title"))
                        .disabled(waiting || !writable || self.confirm.is_some())
                        .on_edit(move |s| &mut edit(s).draft)
                        .on_change(move |s, _| {
                            let editor = edit(s);
                            editor.saved_notice = false;
                            editor.diagnose();
                        })
                        .build(&field_kit(layout::dark())),
                )
                .children(self.syntax_line.map(|line| {
                    text(t("settings.configFiles.syntaxLine").replace("{line}", &line.to_string()))
                        .role("status")
                }))
                .child(
                    layout::action_row()
                        .child(chrome::primary_action(
                            t("settings.configFiles.actions.save"),
                            waiting
                                || !writable
                                || !self.dirty()
                                || self.draft.text.len() > api::MAX_CONTENT,
                            move |s| edit(s).save(&shared.borrow()),
                        ))
                        .child(layout::button(
                            t("settings.configFiles.actions.reload"),
                            waiting || !readable,
                            move |s| edit(s).choose(index),
                        )),
                )
                .children((self.dirty() || !self.exists).then(|| {
                    text(t(if self.dirty() {
                        "settings.configFiles.state.unsaved"
                    } else {
                        "settings.configFiles.state.notCreated"
                    }))
                    .role("status")
                }));
        }
        if let Some(key) = self.notice {
            view = view.child(text(t(key)).role(if key.contains(".errors.") {
                "alert"
            } else {
                "status"
            }));
            if self.reverify {
                view = view.child(layout::button(
                    t("sessionList.loadError.retry"),
                    waiting || !readable,
                    move |s| {
                        edit(s).notice = None;
                    },
                ));
            } else if key == "settings.configFiles.errors.loadList" || self.active.is_none() {
                view = view.child(layout::button(
                    t("sessionList.loadError.retry"),
                    waiting,
                    move |s| {
                        let editor = edit(s);
                        editor.notice = None;
                        editor.goal = editor
                            .files
                            .as_ref()
                            .and_then(|list| (!list.is_empty()).then_some(0));
                    },
                ));
            }
        } else if self.saved_notice {
            view = view.child(text(t("settings.configFiles.toast.saveSuccess")).role("status"));
        }
        if let Some(index) = self.confirm {
            layers.push(confirm_discard(move |s, accept, _| {
                let editor = edit(s);
                if editor.confirm.take() == Some(index) && accept {
                    editor.reload(index);
                }
            }));
        }
        chrome::card(view)
    }
}

pub(super) fn confirm_discard<S: 'static>(
    decide: impl Fn(&mut S, bool, &mut rune::Tx) + 'static,
) -> El {
    rune_theme_codenomad::document_reader::editor::confirmation(
        layout::dark(),
        t("settings.configFiles.confirmDiscard.message"),
        t("settings.configFiles.confirmDiscard.cancelLabel"),
        t("settings.configFiles.confirmDiscard.confirmLabel"),
        decide,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switching_and_reloading_a_dirty_config_require_consent() {
        let mut editor = Editor {
            active: Some(0),
            original: Some("{}".into()),
            draft: TextEdit::new("{/* draft */}"),
            ..Editor::default()
        };
        editor.choose(1);
        assert_eq!(editor.confirm.take(), Some(1));
        assert_eq!(editor.goal, None);
        assert!(editor.dirty());
        editor.choose(0);
        assert_eq!(editor.confirm.take(), Some(0));
        assert_eq!(editor.goal, None);
        editor.suspend();
        assert_eq!(editor.draft.text, "{/* draft */}");
    }

    #[test]
    fn reauthentication_on_same_server_preserves_dirty_draft_and_different_profile_resets() {
        use serde_json::{Value, json};
        use std::{
            sync::{Arc, Mutex},
            time::Duration,
        };
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        platform::block_on(async {
            let saved_payload = Arc::new(Mutex::new(None::<String>));
            let saved_srv = saved_payload.clone();
            let server_id = Arc::new(Mutex::new("server-profile-a".to_owned()));
            let server_id_srv = server_id.clone();
            let swap_after_read_meta = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let swap_after_read_meta_srv = swap_after_read_meta.clone();
            let fail_put_once = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let fail_put_once_srv = fail_put_once.clone();
            let swap_on_put_ok = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let swap_on_put_ok_srv = swap_on_put_ok.clone();
            let swap_readback_match = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let swap_readback_match_srv = swap_readback_match.clone();
            let hold_put = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let hold_put_srv = hold_put.clone();
            let put_arrived = Arc::new(tokio::sync::Notify::new());
            let put_arrived_srv = put_arrived.clone();
            let put_release = Arc::new(tokio::sync::Notify::new());
            let put_release_srv = put_release.clone();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/", listener.local_addr().unwrap());
            tokio::spawn(async move {
                while let Ok((mut stream, _)) = listener.accept().await {
                    let saved_srv = saved_srv.clone();
                    let server_id_srv = server_id_srv.clone();
                    let swap_after_read_meta_srv = swap_after_read_meta_srv.clone();
                    let fail_put_once_srv = fail_put_once_srv.clone();
                    let swap_on_put_ok_srv = swap_on_put_ok_srv.clone();
                    let swap_readback_match_srv = swap_readback_match_srv.clone();
                    let hold_put_srv = hold_put_srv.clone();
                    let put_arrived_srv = put_arrived_srv.clone();
                    let put_release_srv = put_release_srv.clone();
                    tokio::spawn(async move {
                        let mut raw = Vec::new();
                        let mut tmp = [0u8; 4096];
                        let header_end = loop {
                            let Ok(n) = stream.read(&mut tmp).await else {
                                return;
                            };
                            if n == 0 {
                                return;
                            }
                            raw.extend_from_slice(&tmp[..n]);
                            if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                                break pos + 4;
                            }
                        };
                        let head = String::from_utf8_lossy(&raw[..header_end]).into_owned();
                        let content_len = head
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        while raw.len() < header_end + content_len {
                            let Ok(n) = stream.read(&mut tmp).await else {
                                return;
                            };
                            if n == 0 {
                                break;
                            }
                            raw.extend_from_slice(&tmp[..n]);
                        }
                        let first = head.lines().next().unwrap_or_default();
                        let mut parts = first.split_whitespace();
                        let method = parts.next().unwrap_or_default();
                        let path = parts.next().unwrap_or_default();
                        let body = String::from_utf8_lossy(
                            &raw[header_end..header_end + content_len.min(raw.len() - header_end)],
                        );
                        let (status, reply) = match (method, path) {
                            ("GET", "/api/meta") => (
                                "200 OK",
                                json!({
                                    "apiContract": 1,
                                    "serverId": server_id_srv.lock().unwrap().clone(),
                                })
                                .to_string(),
                            ),
                            ("GET", "/api/storage/config/ui")
                            | ("GET", "/api/storage/config/ui?authoritative=1") => {
                                ("200 OK", json!({"settings": {"locale": "en"}}).to_string())
                            }
                            ("GET", "/api/storage/state/ui")
                            | ("GET", "/api/storage/state/ui?authoritative=1") => {
                                ("200 OK", json!({}).to_string())
                            }
                            ("GET", "/api/config-files") => (
                                "200 OK",
                                json!([{
                                    "id": "codenomad",
                                    "label": "CodeNomad",
                                    "path": "/tmp/config.yaml",
                                    "language": "yaml"
                                }])
                                .to_string(),
                            ),
                            ("GET", "/api/config-files/codenomad/content") => {
                                let contents = if swap_readback_match_srv
                                    .swap(false, Ordering::SeqCst)
                                {
                                    *server_id_srv.lock().unwrap() = "server-profile-b".to_owned();
                                    "locale: uncertain\n".to_owned()
                                } else {
                                    if swap_after_read_meta_srv.swap(false, Ordering::SeqCst) {
                                        *server_id_srv.lock().unwrap() =
                                            "server-profile-b".to_owned();
                                    }
                                    if *server_id_srv.lock().unwrap() == "server-profile-a" {
                                        saved_srv
                                            .lock()
                                            .unwrap()
                                            .clone()
                                            .unwrap_or_else(|| "locale: en\n".to_owned())
                                    } else {
                                        "locale: foreign-b\n".to_owned()
                                    }
                                };
                                (
                                    "200 OK",
                                    json!({
                                        "id": "codenomad",
                                        "exists": true,
                                        "contents": contents
                                    })
                                    .to_string(),
                                )
                            }
                            ("PUT", "/api/config-files/codenomad/content") => {
                                if fail_put_once_srv.swap(false, Ordering::SeqCst) {
                                    (
                                        "500 Internal Server Error",
                                        json!({"error": "uncertain"}).to_string(),
                                    )
                                } else {
                                    if swap_on_put_ok_srv.swap(false, Ordering::SeqCst) {
                                        *server_id_srv.lock().unwrap() =
                                            "server-profile-b".to_owned();
                                    }
                                    let parsed: Value = serde_json::from_str(&body).unwrap();
                                    *saved_srv.lock().unwrap() =
                                        parsed["contents"].as_str().map(str::to_owned);
                                    if hold_put_srv.swap(false, Ordering::SeqCst) {
                                        put_arrived_srv.notify_one();
                                        put_release_srv.notified().await;
                                    }
                                    ("204 No Content", String::new())
                                }
                            }
                            _ => ("404 Not Found", json!({"error": "not found"}).to_string()),
                        };
                        let response = format!(
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                            reply.len()
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                    });
                }
            });

            let wake: Waker = Arc::new(|| {});
            let backend_a = Backend::connect(&base, "").await.unwrap();
            backend_a.attest_server().await.unwrap();
            assert_eq!(backend_a.client.server_identity(), Some("server-profile-a"));

            let mut prefs = Preferences::default();
            prefs.main_wake = Some(wake.clone());
            prefs.bind(Some(backend_a));
            for _ in 0..100 {
                prefs.poll();
                if !prefs.transport_lost()
                    && prefs
                        .saved(codenomad_client::settings::Owner::Config)
                        .is_some()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!prefs.transport_lost());

            let mut editor = Editor::default();
            for _ in 0..100 {
                prefs.poll();
                editor.poll(&prefs, &wake, true);
                if editor.active == Some(0) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(editor.active, Some(0));
            editor.draft = TextEdit::new("locale: fr\n");
            assert!(editor.dirty());

            // Re-authenticate on the same server through full bind() + poll() revalidation:
            // draft stays read-only while transport_lost, then becomes saveable again.
            let backend_b = Backend::connect(&base, "").await.unwrap();
            backend_b.attest_server().await.unwrap();
            assert_ne!(
                backend_b.client_id,
                prefs.backend.as_ref().unwrap().client_id
            );
            prefs.bind(Some(backend_b));
            assert!(prefs.transport_lost());
            assert!(editor.poll(&prefs, &wake, true));
            assert!(!editor.can_write(&prefs));
            assert!(editor.dirty());
            assert_eq!(editor.draft.text, "locale: fr\n");
            for _ in 0..100 {
                prefs.poll();
                editor.poll(&prefs, &wake, true);
                if !prefs.transport_lost() && editor.can_write(&prefs) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!prefs.transport_lost());
            assert!(editor.can_write(&prefs));
            assert!(editor.dirty());
            assert_eq!(editor.draft.text, "locale: fr\n");

            editor.save(&prefs);
            assert!(editor.busy());
            for _ in 0..100 {
                editor.poll(&prefs, &wake, true);
                if !editor.busy() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!editor.dirty());
            assert!(editor.saved_notice);
            assert_eq!(editor.notice, None);
            assert_eq!(
                saved_payload.lock().unwrap().as_deref(),
                Some("locale: fr\n")
            );

            // Advancing the authority stamp right after a save (while saved_notice is set) must
            // clear the toast and automatically reload a clean file rather than staying locked.
            *saved_payload.lock().unwrap() = Some("locale: it\n".to_owned());
            prefs.authority_handle().fetch_add(1, Ordering::SeqCst);
            assert!(!editor.can_write(&prefs));
            for _ in 0..100 {
                editor.poll(&prefs, &wake, true);
                if editor.can_write(&prefs) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(editor.can_write(&prefs));
            assert!(!editor.saved_notice);
            assert_eq!(editor.draft.text, "locale: it\n");

            // An in-flight save whose PUT already arrived before authentication expires must
            // still drain when its reply arrives so busy() does not lock Preferences open.
            editor.draft = TextEdit::new("locale: es\n");
            assert!(editor.dirty());
            hold_put.store(true, Ordering::SeqCst);
            editor.save(&prefs);
            assert!(editor.busy());
            tokio::time::timeout(Duration::from_secs(2), put_arrived.notified())
                .await
                .expect("PUT should reach mock server before auth expires");
            prefs.require_authentication();
            assert!(!prefs.can_retry());
            put_release.notify_one();
            for _ in 0..100 {
                editor.poll(&prefs, &wake, true);
                if !editor.busy() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!editor.busy());
            assert!(!editor.dirty());
            assert_eq!(
                saved_payload.lock().unwrap().as_deref(),
                Some("locale: es\n")
            );

            // Re-bind on the same server through full revalidation, then swap HTTP routing to
            // profile B without dropping SSE: a reload read must re-attest, revoke attestation,
            // and never overwrite profile A's editor with profile B's file contents.
            let backend_read_swap = Backend::connect(&base, "").await.unwrap();
            backend_read_swap.attest_server().await.unwrap();
            prefs.bind(Some(backend_read_swap.clone()));
            for _ in 0..100 {
                prefs.poll();
                editor.poll(&prefs, &wake, true);
                if !prefs.transport_lost() && editor.can_write(&prefs) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!prefs.transport_lost());
            assert!(editor.can_write(&prefs));
            *server_id.lock().unwrap() = "server-profile-b".to_owned();
            editor.reload(0);
            editor.poll(&prefs, &wake, true);
            for _ in 0..100 {
                editor.poll(&prefs, &wake, true);
                if editor.read.is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(backend_read_swap.client.attestation_revoked());
            assert!(!editor.can_write(&prefs));
            assert_ne!(editor.draft.text, "locale: foreign-b\n");
            assert_eq!(editor.draft.text, "locale: es\n");

            // Also test switching HTTP routing AFTER the pre-read /api/meta returns profile A
            // and before content is served: post-read re-attestation must reject profile B's
            // content before publication.
            *server_id.lock().unwrap() = "server-profile-a".to_owned();
            let backend_post_swap = Backend::connect(&base, "").await.unwrap();
            backend_post_swap.attest_server().await.unwrap();
            prefs.bind(Some(backend_post_swap.clone()));
            for _ in 0..100 {
                prefs.poll();
                editor.poll(&prefs, &wake, true);
                if !prefs.transport_lost() && editor.can_write(&prefs) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!prefs.transport_lost());
            assert!(editor.can_write(&prefs));
            swap_after_read_meta.store(true, Ordering::SeqCst);
            editor.reload(0);
            editor.poll(&prefs, &wake, true);
            for _ in 0..100 {
                editor.poll(&prefs, &wake, true);
                if editor.read.is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(backend_post_swap.client.attestation_revoked());
            assert!(!editor.can_write(&prefs));
            assert_ne!(editor.draft.text, "locale: foreign-b\n");
            assert_eq!(editor.draft.text, "locale: es\n");

            // Restore profile A, re-bind through full revalidation, then swap HTTP routing to
            // profile B without dropping SSE before save(): save() must re-attest live HTTP
            // routing, revoke attestation, and never send the PUT to profile B.
            *server_id.lock().unwrap() = "server-profile-a".to_owned();
            let backend_reauth = Backend::connect(&base, "").await.unwrap();
            backend_reauth.attest_server().await.unwrap();
            prefs.bind(Some(backend_reauth.clone()));
            for _ in 0..100 {
                prefs.poll();
                editor.poll(&prefs, &wake, true);
                if !prefs.transport_lost() && editor.can_write(&prefs) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!prefs.transport_lost());
            assert!(editor.can_write(&prefs));
            editor.draft = TextEdit::new("locale: it\n");
            assert!(editor.dirty());
            *saved_payload.lock().unwrap() = None;
            *server_id.lock().unwrap() = "server-profile-b".to_owned();
            editor.save(&prefs);
            assert!(editor.busy());
            for _ in 0..100 {
                editor.poll(&prefs, &wake, true);
                if !editor.busy() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(backend_reauth.client.attestation_revoked());
            assert!(!editor.can_write(&prefs));
            assert_eq!(saved_payload.lock().unwrap().as_deref(), None);
            assert!(editor.dirty());
            assert_eq!(editor.draft.text, "locale: it\n");
            // Subsequent save attempts while revoked are refused synchronously.
            editor.save(&prefs);
            assert!(!editor.busy());
            assert_eq!(saved_payload.lock().unwrap().as_deref(), None);

            // Uncertain PUT followed by HTTP swap to profile B between readback /api/meta and
            // GET content: even when profile B serves identical content, post-readback
            // re-attestation must reject confirmation and keep the draft dirty.
            *server_id.lock().unwrap() = "server-profile-a".to_owned();
            *saved_payload.lock().unwrap() = Some("locale: es\n".to_owned());
            let backend_readback_swap = Backend::connect(&base, "").await.unwrap();
            backend_readback_swap.attest_server().await.unwrap();
            prefs.bind(Some(backend_readback_swap.clone()));
            for _ in 0..100 {
                prefs.poll();
                editor.poll(&prefs, &wake, true);
                if !prefs.transport_lost() && editor.can_write(&prefs) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!prefs.transport_lost());
            assert!(editor.can_write(&prefs));
            editor.draft = TextEdit::new("locale: uncertain\n");
            assert!(editor.dirty());
            fail_put_once.store(true, Ordering::SeqCst);
            swap_readback_match.store(true, Ordering::SeqCst);
            editor.save(&prefs);
            assert!(editor.busy());
            for _ in 0..100 {
                editor.poll(&prefs, &wake, true);
                if !editor.busy() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(backend_readback_swap.client.attestation_revoked());
            assert!(!editor.can_write(&prefs));
            assert!(editor.dirty());
            assert_eq!(editor.draft.text, "locale: uncertain\n");

            // Swap to profile B AFTER pre-write /api/meta and BEFORE PUT completes with 204:
            // post-write re-attestation must revoke attestation and keep the draft dirty so
            // profile B's 204 cannot confirm the draft as saved on profile A.
            *server_id.lock().unwrap() = "server-profile-a".to_owned();
            let backend_put_swap = Backend::connect(&base, "").await.unwrap();
            backend_put_swap.attest_server().await.unwrap();
            prefs.bind(Some(backend_put_swap.clone()));
            for _ in 0..100 {
                prefs.poll();
                editor.poll(&prefs, &wake, true);
                if !prefs.transport_lost() && editor.can_write(&prefs) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!prefs.transport_lost());
            assert!(editor.can_write(&prefs));
            editor.draft = TextEdit::new("locale: post-put-swap\n");
            assert!(editor.dirty());
            swap_on_put_ok.store(true, Ordering::SeqCst);
            editor.save(&prefs);
            assert!(editor.busy());
            for _ in 0..100 {
                editor.poll(&prefs, &wake, true);
                if !editor.busy() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(backend_put_swap.client.attestation_revoked());
            assert!(!editor.can_write(&prefs));
            assert!(editor.dirty());
            assert_eq!(editor.draft.text, "locale: post-put-swap\n");

            // External disk change during disconnect on same server: re-authentication must
            // re-read without discarding the dirty draft, report conflict, block PUT, and allow
            // explicit reload to recover.
            *server_id.lock().unwrap() = "server-profile-a".to_owned();
            *saved_payload.lock().unwrap() = Some("locale: external\n".to_owned());
            let backend_conflict = Backend::connect(&base, "").await.unwrap();
            backend_conflict.attest_server().await.unwrap();
            prefs.bind(Some(backend_conflict));
            for _ in 0..100 {
                prefs.poll();
                editor.poll(&prefs, &wake, true);
                if !prefs.transport_lost() && !editor.reverify && editor.read.is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!prefs.transport_lost());
            assert!(editor.conflict);
            assert!(!editor.can_write(&prefs));
            assert!(editor.dirty());
            assert_eq!(editor.draft.text, "locale: post-put-swap\n");
            editor.save(&prefs);
            assert!(!editor.busy());
            assert_eq!(
                saved_payload.lock().unwrap().as_deref(),
                Some("locale: external\n")
            );
            editor.reload(0);
            for _ in 0..100 {
                editor.poll(&prefs, &wake, true);
                if !editor.conflict && editor.read.is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(!editor.conflict);
            assert!(editor.can_write(&prefs));
            assert_eq!(editor.draft.text, "locale: external\n");

            // Same-client authority generation advance on a clean file: can_write must turn false
            // immediately and polling must reload the updated disk baseline before any edit/save.
            *saved_payload.lock().unwrap() = Some("locale: after-drop\n".to_owned());
            prefs.authority_handle().fetch_add(1, Ordering::SeqCst);
            assert!(!editor.can_write(&prefs));
            for _ in 0..100 {
                prefs.poll();
                editor.poll(&prefs, &wake, true);
                if editor.can_write(&prefs) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(editor.can_write(&prefs));
            assert_eq!(editor.draft.text, "locale: after-drop\n");

            editor.draft = TextEdit::new("locale: dirty-before-profile-b\n");
            assert!(editor.dirty());

            // Connecting to a different server profile on the same address must reset the draft.
            *server_id.lock().unwrap() = "server-profile-b".to_owned();
            let backend_c = Backend::connect(&base, "").await.unwrap();
            backend_c.attest_server().await.unwrap();
            prefs.bind(Some(backend_c));
            assert!(editor.poll(&prefs, &wake, true));
            assert!(!editor.dirty());
            assert!(editor.draft.text.is_empty());
        });
    }
}
