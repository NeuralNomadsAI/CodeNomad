use super::Preferences;
use crate::{
    platform,
    strings::{locale, t},
};
use codenomad_client::{Receiver, backend::Backend, bounded, settings::memory};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
    settings as chrome,
};
pub(super) mod cleanup;
pub(super) mod editor;
pub(super) mod review;
mod seen;

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

#[derive(Default)]
pub(super) struct Setting {
    pub visible: bool,
    online: bool,
    current: Option<bool>,
    refresh: bool,
    failed: bool,
    pending: Option<(bool, u64)>,
    flight: Option<(u64, bool, Receiver<(Option<bool>, bool)>)>,
    review: review::Review,
    owner_gen: u64,
    prompt_token: Arc<AtomicU64>,
}

impl Setting {
    pub fn show(&mut self, visible: bool) {
        if visible && !self.visible {
            self.review.begin_visit();
            self.invalidate();
        }
        self.visible = visible;
        if !visible {
            self.prompt_token.fetch_add(1, Ordering::SeqCst);
            self.review.suspend();
        }
    }

    pub fn prompt_token(&self) -> (Arc<AtomicU64>, u64) {
        (
            self.prompt_token.clone(),
            self.prompt_token.load(Ordering::SeqCst),
        )
    }

    pub fn active_scope(&self, project: Option<&super::providers::Target>) -> memory::Scope {
        self.review.active_scope(project)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn bind_seen(&mut self, store: Option<crate::platform::storage::Store>) {
        self.review.bind_seen(store);
    }

    pub fn bind(&mut self, same: bool) {
        if same {
            if self.pending.take().is_some() {
                self.failed = true;
            }
            self.invalidate();
        } else {
            self.prompt_token.fetch_add(1, Ordering::SeqCst);
            self.review.revoke_authority();
            let owner_gen = self.owner_gen.wrapping_add(1);
            *self = Self {
                visible: self.visible,
                refresh: self.visible,
                owner_gen,
                ..Self::default()
            };
        }
    }

    pub fn invalidate(&mut self) {
        self.refresh = true;
        self.review.invalidate();
    }

    pub fn poll_pending_writes(&mut self, current_auth: u64, verified: bool) -> bool {
        let mut changed = self.review.poll_write();
        if let Some((flight_gen, is_write, flight)) = &self.flight {
            let (flight_gen, is_write) = (*flight_gen, *is_write);
            match flight.try_recv() {
                Ok((current, failed)) => {
                    self.flight = None;
                    if flight_gen == current_auth && verified {
                        self.failed = failed;
                        if let Some(current) = current {
                            self.current = Some(current);
                            if !current {
                                self.review.revoke_cleanup_disable();
                            }
                        }
                    } else {
                        if is_write {
                            self.failed = true;
                        }
                        self.refresh = true;
                    }
                    changed = true;
                }
                Err(_) if flight.is_closed() => {
                    self.flight = None;
                    self.failed = true;
                    self.refresh = true;
                    changed = true;
                }
                Err(_) => {}
            }
        }
        changed
    }

    pub fn on_authentication_required(&mut self) {
        if self.pending.take().is_some() {
            self.failed = true;
        }
        self.review.on_authentication_required();
    }

    pub fn poll_review(
        &mut self,
        backend: &Backend,
        project: Option<&super::providers::Target>,
        transport_lost: bool,
        prefs_authority: &std::sync::Arc<std::sync::atomic::AtomicU64>,
        main: &Option<rune::Waker>,
        window: &Option<rune::Waker>,
    ) -> bool {
        self.review.poll(
            (self.visible && self.current == Some(true)).then_some(backend),
            project,
            transport_lost,
            prefs_authority,
            main,
            window,
        )
    }

    pub fn transport(&mut self, online: bool) {
        let previous = std::mem::replace(&mut self.online, online);
        if online && !previous {
            self.invalidate();
        }
    }

    #[cfg(test)]
    pub(super) fn review_first_edit(&self) -> Option<review::Edit> {
        self.review.first_edit()
    }

    #[cfg(test)]
    pub(super) fn review_is_current(&self, edit: &review::Edit) -> bool {
        self.review.is_current(edit)
    }

    #[cfg(test)]
    pub(super) fn review_writable(&self, edit: &review::Edit) -> bool {
        self.review.writable(edit)
    }

    pub fn poll_editor(&self, backend: Option<&Backend>, editor: &mut editor::Editor) -> bool {
        editor.poll(&self.review, backend, self.owner_gen)
    }

    pub fn cleanup_current(&self, intent: &cleanup::Intent) -> bool {
        self.visible
            && self.current == Some(true)
            && !self.busy()
            && !self.failed
            && self.review.cleanup_current(intent)
    }

    pub fn cancel_cleanup_confirmation(&mut self) -> bool {
        self.review.cancel_cleanup_confirmation()
    }

    pub fn take_cleanup(&mut self) -> Option<cleanup::Intent> {
        if self.busy() {
            if let Some(intent) = self.review.take_cleanup() {
                self.review.cleanup_failed(&intent);
            }
            return None;
        }
        self.review.take_cleanup()
    }

    pub fn cleanup_prompting(&mut self, intent: &cleanup::Intent) {
        self.review.cleanup_prompting(intent);
    }

    pub fn cleanup_failed(&mut self, intent: &cleanup::Intent) {
        self.review.cleanup_failed(intent);
    }

    pub fn cleanup_succeeded(&mut self, intent: &cleanup::Intent) {
        self.review.cleanup_succeeded(intent);
    }

    pub fn editor_view<S: 'static>(
        &self,
        editor: &editor::Editor,
        access: fn(&mut S) -> &mut editor::Editor,
        action: impl Fn(&mut S, review::Action) -> bool + Clone + 'static,
    ) -> Option<El> {
        editor
            .view(&self.review, access, action.clone())
            .or_else(|| self.review.cleanup_confirmation(action))
    }

    fn set(&mut self, next: bool, auth_gen: u64) {
        if self.visible && !self.busy() && self.current.is_some_and(|current| current != next) {
            if !next {
                self.review.revoke_cleanup_disable();
            }
            self.pending = Some((next, auth_gen));
            self.failed = false;
        }
    }

    fn busy(&self) -> bool {
        self.pending.is_some() || self.flight.is_some()
    }

    pub fn poll(
        &mut self,
        backend: &Backend,
        transport_lost: bool,
        prefs_authority: &Arc<AtomicU64>,
        main: &Option<rune::Waker>,
        window: &Option<rune::Waker>,
    ) -> bool {
        let current_auth = prefs_authority.load(Ordering::SeqCst);
        let verified = !transport_lost && super::ServerOwner::backend_verified(backend);
        let mut changed = self.poll_pending_writes(current_auth, verified);
        if self.flight.is_some() {
            return changed;
        }
        if let Some((_, admitted_gen)) = self.pending
            && (admitted_gen != current_auth || !verified)
        {
            self.pending = None;
            self.failed = true;
            changed = true;
        }
        if !verified {
            if self.visible {
                self.refresh = true;
            }
            return changed;
        }
        if self.pending.is_none() && (!self.visible || !self.refresh) {
            return changed;
        }
        let desired = self.pending.take();
        let is_write = desired.is_some();
        self.refresh = false;
        let (out, input) = bounded(1);
        self.flight = Some((current_auth, is_write, input));
        let (backend, main, window) = (backend.clone(), main.clone(), window.clone());
        let auth = prefs_authority.clone();
        let prepared_gen = backend.client.drop_generation();
        platform::spawn(async move {
            let still_ok = |expected_auth: u64| {
                auth.load(Ordering::SeqCst) == expected_auth
                    && backend.client.drop_generation() == prepared_gen
                    && super::ServerOwner::backend_verified(&backend)
            };
            let result = if let Some((desired, admitted_gen)) = desired {
                let attested = still_ok(admitted_gen)
                    && (!backend.client.tracks_server_attestation()
                        || backend.attest_server().await.is_ok())
                    && still_ok(admitted_gen);
                if !attested {
                    (None, true)
                } else {
                    match memory::set_enabled(&backend, desired).await {
                        Ok(actual) if actual == desired => {
                            let post_ok = still_ok(admitted_gen)
                                && (!backend.client.tracks_server_attestation()
                                    || backend.attest_server().await.is_ok())
                                && still_ok(admitted_gen);
                            if post_ok {
                                (Some(actual), false)
                            } else {
                                (None, true)
                            }
                        }
                        _ => {
                            let readback = if still_ok(admitted_gen)
                                && (!backend.client.tracks_server_attestation()
                                    || backend.attest_server().await.is_ok())
                                && still_ok(admitted_gen)
                            {
                                let actual = memory::enabled(&backend).await.ok();
                                let post_ok = still_ok(admitted_gen)
                                    && (!backend.client.tracks_server_attestation()
                                        || backend.attest_server().await.is_ok())
                                    && still_ok(admitted_gen);
                                actual.filter(|_| post_ok)
                            } else {
                                None
                            };
                            (readback, true)
                        }
                    }
                }
            } else if !still_ok(current_auth)
                || (backend.client.tracks_server_attestation()
                    && backend.attest_server().await.is_err())
                || !still_ok(current_auth)
            {
                (None, true)
            } else {
                let actual = memory::enabled(&backend).await.ok();
                let post_ok = still_ok(current_auth)
                    && (!backend.client.tracks_server_attestation()
                        || backend.attest_server().await.is_ok())
                    && still_ok(current_auth);
                let actual = actual.filter(|_| post_ok);
                (actual, actual.is_none())
            };
            let _ = out.send(result).await;
            for wake in [main, window].into_iter().flatten() {
                wake();
            }
        });
        true
    }
}

pub(super) fn view<S: 'static>(
    prefs: &Preferences,
    help: &super::ExternalLink,
    apply: impl Fn(&mut S, Option<bool>) + Clone + 'static,
    help_link: fn(&mut S) -> Option<&mut super::ExternalLink>,
    open: impl Fn(&mut S, review::Edit) + Clone + 'static,
    review_action: impl Fn(&mut S, review::Action) + Clone + 'static,
) -> El {
    let setting = &prefs.memory;
    let title = t("settings.memory.title");
    let hint = t("settings.memory.info");
    let url = format!(
        "https://neuralnomadsai.github.io/CodeNomad/{}/settings.html#agent-memory",
        locale()
    );
    let info = chrome::info_link(hint, move |s, tx| {
        if let Some(link) = help_link(s) {
            link.open(&url, tx, help_link);
        }
    });
    let next = !setting.current.unwrap_or(false);
    let set = apply.clone();
    let verified = prefs.can_retry()
        && !prefs.transport_lost()
        && prefs
            .backend
            .as_ref()
            .is_some_and(super::ServerOwner::backend_verified);
    let enabled = verified && !setting.busy() && setting.current.is_some();
    chrome::card(
        col()
            .full_width()
            .separate(Space::Sm)
            .child(chrome::setting_row_with_info(
                title,
                Some(info),
                chrome::setting_switch(title, !next, !enabled, move |s| set(s, Some(next))),
            ))
            .children(setting.failed.then(|| {
                layout::action_row()
                    .child(chrome::palette::save_error(t(
                        "settings.memory.error.unavailable",
                    )))
                    .child(layout::button(
                        t("settings.memory.retry"),
                        !verified || setting.busy(),
                        move |s| apply(s, None),
                    ))
            }))
            .children(
                help.failed()
                    .then(|| chrome::palette::save_error(t("commands.openHelp.failed"))),
            )
            .children(
                (setting.current == Some(true) && prefs.can_retry()).then(|| {
                    setting.review.view(
                        prefs.provider_target.as_ref(),
                        setting.busy(),
                        open,
                        review_action,
                    )
                }),
            ),
    )
}

pub(super) fn review_action(prefs: &mut Preferences, action: review::Action) -> bool {
    if prefs.can_retry() && prefs.memory.visible && prefs.memory.current == Some(true) {
        if matches!(
            action,
            review::Action::Tidy | review::Action::ConfirmTidy(..)
        ) && prefs.memory.busy()
        {
            return false;
        }
        let write = matches!(action, review::Action::Write(..));
        let was_writing = prefs.memory.review.writing();
        let scope_before = prefs.memory.active_scope(prefs.provider_target.as_ref());
        let authority = prefs.authority_handle();
        prefs
            .memory
            .review
            .action(action, prefs.provider_target.as_ref(), &authority);
        if prefs.memory.active_scope(prefs.provider_target.as_ref()) != scope_before {
            prefs.memory.prompt_token.fetch_add(1, Ordering::SeqCst);
        }
        for wake in [&prefs.main_wake, &prefs.window_wake].into_iter().flatten() {
            wake();
        }
        return !write || (!was_writing && prefs.memory.review.writing());
    }
    false
}

pub(super) fn action(prefs: &mut Preferences, desired: Option<bool>) {
    let verified = prefs.can_retry()
        && !prefs.transport_lost()
        && prefs
            .backend
            .as_ref()
            .is_some_and(super::ServerOwner::backend_verified);
    if verified && prefs.memory.visible {
        let auth_gen = prefs.authority_handle().load(Ordering::SeqCst);
        match desired {
            Some(desired) => prefs.memory.set(desired, auth_gen),
            None => prefs.memory.invalidate(),
        }
        for wake in [&prefs.main_wake, &prefs.window_wake].into_iter().flatten() {
            wake();
        }
    }
}
