use super::{ErrorText, Preferences, Remote, pairing_view};
use crate::{backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::remote::{
        self, AuthStatus, DirectAccessMeta, ListeningMode, NetworkAddress, split_remote_addresses,
    },
};
use rune::{El, TextEdit, Waker, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(super) struct DirectAccess {
    owner: Option<String>,
    meta: Option<DirectAccessMeta>,
    auth: Option<AuthStatus>,
    auth_error: Option<ErrorText>,
    meta_flight: Option<(Sender<()>, Receiver<MetaReply>)>,
    mode_flight: Option<Receiver<Result<(), remote::Error>>>,
    password_flight: Option<Receiver<Result<AuthStatus, remote::Error>>>,
    meta_error: Option<ErrorText>,
    disclosure_override: Option<bool>,
    locked_info_open: bool,
    confirm_mode: Option<ListeningMode>,
    restart_notice: bool,
    mode_error: Option<ErrorText>,
    password_form_open: bool,
    password: TextEdit,
    confirm: TextEdit,
    password_error: Option<ErrorText>,
    show_other_addresses: bool,
    address_copy: pairing_view::Copy,
    open_failed: bool,
    open_seq: u64,
}

struct MetaReply {
    meta: Result<DirectAccessMeta, remote::Error>,
    auth: Result<AuthStatus, remote::Error>,
}

impl DirectAccess {
    pub fn close(&mut self) {
        let open_seq = self.open_seq.wrapping_add(1);
        self.wipe_password_fields();
        *self = Self {
            open_seq,
            ..Self::default()
        };
    }

    fn wipe_password_fields(&mut self) {
        self.password = TextEdit::new("");
        self.confirm = TextEdit::new("");
    }

    pub fn refresh(&mut self, backend: &Backend, wake: &Waker) {
        if self.meta_flight.is_some() {
            return;
        }
        self.owner = Some(backend.client_id.clone());
        self.meta_error = None;
        let (cancel, cancelled) = bounded(1);
        let (out, input) = bounded(1);
        self.meta_flight = Some((cancel, input));
        let (backend, wake) = (backend.clone(), wake.clone());
        platform::spawn(async move {
            let Some((meta, auth)) =
                platform::reads::cancellable(&cancelled, remote::direct_access_snapshot(&backend))
                    .await
            else {
                return;
            };
            if out.send(MetaReply { meta, auth }).await.is_ok() {
                wake();
            }
        });
    }

    pub fn poll(&mut self, backend: Option<&Backend>, wake: &Waker) -> bool {
        let owner = backend.map(|b| b.client_id.as_str());
        if self.owner.as_deref() != owner {
            self.close();
            self.owner = owner.map(str::to_owned);
            if let Some(backend) = backend {
                self.refresh(backend, wake);
            }
            return true;
        }
        let mut changed = self.address_copy.poll();
        if let Some((_, flight)) = &self.meta_flight {
            match flight.try_recv() {
                Ok(reply) => {
                    self.meta_flight = None;
                    match reply.meta {
                        Ok(meta) => {
                            self.meta = Some(meta);
                            self.meta_error = None;
                            self.show_other_addresses = false;
                        }
                        Err(err) => {
                            self.meta_error =
                                Some(ErrorText::from_remote(err, "rune.connect_error"))
                        }
                    }
                    match reply.auth {
                        Ok(auth) => {
                            self.auth = Some(auth);
                            self.auth_error = None;
                        }
                        Err(err) => {
                            self.auth = None;
                            self.auth_error = Some(ErrorText::from_remote(
                                err,
                                "remoteAccess.authStatus.unavailable",
                            ));
                        }
                    }
                    changed = true;
                }
                Err(_) if flight.is_closed() => {
                    self.meta_flight = None;
                    self.meta_error = Some(ErrorText::Key("rune.connect_error"));
                    changed = true;
                }
                Err(_) => {}
            }
        }
        if let Some(flight) = &self.mode_flight {
            match flight.try_recv() {
                Ok(result) => {
                    self.mode_flight = None;
                    match result {
                        Ok(()) => {
                            self.restart_notice = true;
                            self.mode_error = None;
                            if let Some(backend) = backend {
                                self.refresh(backend, wake);
                            }
                        }
                        Err(err) => {
                            self.restart_notice = false;
                            self.mode_error =
                                Some(ErrorText::from_remote(err, "settings.preferenceSaveFailed"));
                        }
                    }
                    changed = true;
                }
                Err(_) if flight.is_closed() => {
                    self.mode_flight = None;
                    self.mode_error = Some(ErrorText::Key("settings.preferenceSaveFailed"));
                    changed = true;
                }
                Err(_) => {}
            }
        }
        if let Some(flight) = &self.password_flight {
            match flight.try_recv() {
                Ok(result) => {
                    self.password_flight = None;
                    match result {
                        Ok(auth) => {
                            self.auth = Some(auth);
                            self.wipe_password_fields();
                            self.password_form_open = false;
                            self.password_error = None;
                        }
                        Err(err) => {
                            self.password_error =
                                Some(ErrorText::from_remote(err, "settings.preferenceSaveFailed"));
                            if let Some(backend) = backend {
                                self.refresh(backend, wake);
                            }
                        }
                    }
                    changed = true;
                }
                Err(_) if flight.is_closed() => {
                    self.password_flight = None;
                    self.password_error = Some(ErrorText::Key("settings.preferenceSaveFailed"));
                    if let Some(backend) = backend {
                        self.refresh(backend, wake);
                    }
                    changed = true;
                }
                Err(_) => {}
            }
        }
        changed
    }

    fn current_mode(&self) -> ListeningMode {
        self.meta
            .as_ref()
            .map(|m| m.listening_mode)
            .unwrap_or(ListeningMode::Local)
    }

    fn allow_external(&self) -> bool {
        self.current_mode() == ListeningMode::All
    }

    fn start_listening_mode(&mut self, backend: &Backend, wake: &Waker, target: ListeningMode) {
        if self.mode_flight.is_some()
            || self
                .meta
                .as_ref()
                .is_some_and(|m| m.listening_locked || !m.local_request)
        {
            return;
        }
        self.confirm_mode = None;
        self.mode_error = None;
        self.restart_notice = false;
        let (out, input) = bounded(1);
        self.mode_flight = Some(input);
        let (backend, wake) = (backend.clone(), wake.clone());
        platform::spawn(async move {
            let result = remote::set_listening_mode(&backend, target).await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    fn submit_password(&mut self, backend: &Backend, wake: &Waker) {
        if self.password_flight.is_some() || !self.meta.as_ref().is_some_and(|m| m.local_request) {
            return;
        }
        self.password_error = None;
        let next = self.password.text.clone();
        let confirm = self.confirm.text.clone();
        if next.trim().chars().count() < 8 {
            self.password_error = Some(ErrorText::Key("remoteAccess.password.error.tooShort"));
            return;
        }
        if next != confirm {
            self.password_error = Some(ErrorText::Key("remoteAccess.password.error.mismatch"));
            return;
        }
        // Cancel any pre-save meta/auth read so an older authenticated snapshot cannot overwrite
        // the post-save auth status after session revocation.
        self.meta_flight = None;
        let (out, input) = bounded(1);
        self.password_flight = Some(input);
        let (backend, wake) = (backend.clone(), wake.clone());
        platform::spawn(async move {
            let result = remote::set_password(&backend, &next).await;
            if out.send(result).await.is_ok() {
                wake();
            }
        });
    }

    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        available: bool,
        access: fn(&mut S) -> Option<&mut Remote>,
        edit: fn(&mut S) -> &mut Remote,
    ) -> El {
        let allow_external = self.allow_external();
        let open = self.disclosure_override.unwrap_or(allow_external);
        let body = col()
            .full_width()
            .separate(Space::Md)
            .child(text(t("remoteAccess.direct.help")).wrap())
            .child(self.listening_card(shared, available, access))
            .child(self.password_card(shared, available, access, edit))
            .child(self.addresses_card(shared, available, access));
        chrome::disclosure(
            t("remoteAccess.direct.title"),
            open,
            body,
            move |s: &mut S| {
                if let Some(state) = access(s) {
                    let currently_open = state
                        .direct
                        .disclosure_override
                        .unwrap_or_else(|| state.direct.allow_external());
                    state.direct.disclosure_override = Some(!currently_open);
                }
            },
        )
    }

    fn listening_card<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        available: bool,
        access: fn(&mut S) -> Option<&mut Remote>,
    ) -> El {
        let loading = self.meta_flight.is_some();
        let applying = self.mode_flight.is_some();
        let locked = self.meta.as_ref().is_some_and(|m| m.listening_locked);
        let local_request = self.meta.as_ref().is_none_or(|m| m.local_request);
        let allow_external = self.allow_external();
        let refresh_shared = shared.clone();
        let refresh = layout::button(
            t("remoteAccess.refresh"),
            !available || loading,
            move |s: &mut S| {
                let Some(state) = access(s) else { return };
                state.direct.password_error = None;
                let prefs = refresh_shared.borrow();
                if let Some(backend) = prefs.backend.as_ref().filter(|_| prefs.can_retry())
                    && let Some(wake) = prefs.window_wake.as_ref().or(prefs.main_wake.as_ref())
                {
                    state.direct.refresh(backend, wake);
                }
            },
        )
        .key("remote-access-refresh");

        let info = locked.then(|| {
            chrome::info_tip(
                t("remoteAccess.toggle.title"),
                t("remoteAccess.toggle.locked"),
                self.locked_info_open,
                move |s: &mut S| {
                    if let Some(state) = access(s) {
                        state.direct.locked_info_open = !state.direct.locked_info_open;
                    }
                },
            )
            .key("remote-listening-locked-info")
        });
        let next_mode = if allow_external {
            ListeningMode::Local
        } else {
            ListeningMode::All
        };
        let switch = chrome::setting_switch(
            t("remoteAccess.toggle.title"),
            allow_external,
            !available || loading || applying || locked || !local_request || self.meta.is_none(),
            move |s: &mut S| {
                if let Some(state) = access(s) {
                    state.direct.disclosure_override = Some(true);
                    state.direct.mode_error = None;
                    state.direct.confirm_mode = Some(next_mode);
                }
            },
        )
        .key("remote-listening-mode-switch");

        let mut card = col()
            .full_width()
            .separate(Space::Sm)
            .child(
                layout::action_row()
                    .child(
                        text(t("remoteAccess.sections.listeningMode.label"))
                            .text_role(TextRole::Title)
                            .role("heading"),
                    )
                    .child(refresh),
            )
            .child(chrome::setting_row_with_info(
                t("remoteAccess.toggle.title"),
                info,
                switch,
            ));

        if locked && let Some(host) = self.meta.as_ref().and_then(|m| m.host.as_deref()) {
            card = card.child(
                text(t("remoteAccess.toggle.caption.locked").replace("{host}", host)).wrap(),
            );
        }
        if let Some(target) = self.confirm_mode {
            let title_key = if target == ListeningMode::All {
                "remoteAccess.listeningMode.restartConfirm.title.all"
            } else {
                "remoteAccess.listeningMode.restartConfirm.title.local"
            };
            let confirm_shared = shared.clone();
            card = card.child(
                col()
                    .full_width()
                    .separate(Space::Xs)
                    .key("remote-listening-confirm")
                    .child(
                        text(t(title_key))
                            .text_role(TextRole::Title)
                            .role("heading"),
                    )
                    .child(text(t("remoteAccess.listeningMode.restartConfirm.message")).wrap())
                    .child(
                        layout::action_row()
                            .child(
                                chrome::primary_action(
                                    t("remoteAccess.listeningMode.restartConfirm.confirmLabel"),
                                    !available || applying,
                                    move |s: &mut S| {
                                        let Some(state) = access(s) else { return };
                                        let prefs = confirm_shared.borrow();
                                        if let Some(backend) =
                                            prefs.backend.as_ref().filter(|_| prefs.can_retry())
                                            && let Some(wake) = prefs
                                                .window_wake
                                                .as_ref()
                                                .or(prefs.main_wake.as_ref())
                                        {
                                            state
                                                .direct
                                                .start_listening_mode(backend, wake, target);
                                        }
                                    },
                                )
                                .key("remote-listening-confirm-apply"),
                            )
                            .child(
                                layout::button(
                                    t("remoteAccess.listeningMode.restartConfirm.cancelLabel"),
                                    applying,
                                    move |s: &mut S| {
                                        if let Some(state) = access(s) {
                                            state.direct.confirm_mode = None;
                                        }
                                    },
                                )
                                .key("remote-listening-confirm-cancel"),
                            ),
                    ),
            );
        }
        if self.restart_notice {
            card = card.child(
                text(t("remoteAccess.restart.errorManual"))
                    .role("status")
                    .wrap(),
            );
        }
        if let Some(err) = &self.mode_error {
            card = card.child(text(err.as_str()).role("alert").wrap());
        }
        chrome::card(card)
    }

    fn password_card<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        available: bool,
        access: fn(&mut S) -> Option<&mut Remote>,
        edit: fn(&mut S) -> &mut Remote,
    ) -> El {
        let mut card = col()
            .full_width()
            .separate(Space::Sm)
            .child(
                text(t("remoteAccess.sections.serverPassword.label"))
                    .text_role(TextRole::Title)
                    .role("heading"),
            )
            .child(text(t("remoteAccess.sections.serverPassword.help")).wrap());

        let Some(auth) = self.auth.as_ref().filter(|a| a.authenticated) else {
            let message = self
                .auth_error
                .as_ref()
                .map(ErrorText::as_str)
                .unwrap_or_else(|| t("remoteAccess.authStatus.unavailable"));
            return chrome::card(card.child(text(message).wrap()));
        };

        let username = auth.username.as_deref().unwrap_or("codenomad");
        let status_key = if auth.password_user_provided {
            "remoteAccess.password.status.set"
        } else {
            "remoteAccess.password.status.unset"
        };
        let saving = self.password_flight.is_some();
        let local_request = self.meta.as_ref().is_some_and(|m| m.local_request);
        card = card
            .child(text(t("remoteAccess.username").replace("{username}", username)).wrap())
            .child(text(t(status_key)).wrap());

        if local_request {
            let toggle_label = t(if self.password_form_open {
                "remoteAccess.password.actions.cancel"
            } else if auth.password_user_provided {
                "remoteAccess.password.actions.change"
            } else {
                "remoteAccess.password.actions.set"
            });
            card = card.child(
                layout::button(toggle_label, !available || saving, move |s: &mut S| {
                    if let Some(state) = access(s) {
                        state.direct.password_form_open = !state.direct.password_form_open;
                        state.direct.password_error = None;
                        if !state.direct.password_form_open {
                            state.direct.wipe_password_fields();
                        }
                    }
                })
                .key("remote-password-toggle"),
            );
        }

        if local_request && self.password_form_open {
            let new_label = t("remoteAccess.password.form.newPassword");
            let confirm_label = t("remoteAccess.password.form.confirmPassword");
            let submit_shared = shared.clone();
            let save_shared = shared.clone();
            let password_input =
                layout::hinted_field(&self.password, t("remoteAccess.password.form.placeholder"))
                    .label(new_label)
                    .secure()
                    .disabled(saving)
                    .on_edit(move |s: &mut S| &mut edit(s).direct.password)
                    .build(field_kit(layout::dark()))
                    .literal_direction()
                    .key("remote-password-new");
            let confirm_input = layout::literal_field(&self.confirm)
                .label(confirm_label)
                .secure()
                .disabled(saving)
                .on_edit(move |s: &mut S| &mut edit(s).direct.confirm)
                .on_submit(move |s: &mut S, _| {
                    let Some(state) = access(s) else { return };
                    let prefs = submit_shared.borrow();
                    if let Some(backend) = prefs.backend.as_ref().filter(|_| prefs.can_retry())
                        && let Some(wake) = prefs.window_wake.as_ref().or(prefs.main_wake.as_ref())
                    {
                        state.direct.submit_password(backend, wake);
                    }
                })
                .build(field_kit(layout::dark()))
                .key("remote-password-confirm");

            card = card
                .child(text(new_label))
                .child(password_input)
                .child(text(confirm_label))
                .child(confirm_input)
                .children(
                    self.password_error
                        .as_ref()
                        .map(|err| text(err.as_str()).role("alert").wrap()),
                )
                .child(
                    chrome::primary_action(
                        t(if saving {
                            "remoteAccess.password.save.saving"
                        } else {
                            "remoteAccess.password.save.label"
                        }),
                        !available || saving,
                        move |s: &mut S| {
                            let Some(state) = access(s) else { return };
                            let prefs = save_shared.borrow();
                            if let Some(backend) =
                                prefs.backend.as_ref().filter(|_| prefs.can_retry())
                                && let Some(wake) =
                                    prefs.window_wake.as_ref().or(prefs.main_wake.as_ref())
                            {
                                state.direct.submit_password(backend, wake);
                            }
                        },
                    )
                    .key("remote-password-save"),
                );
        }

        chrome::card(card)
    }

    fn addresses_card<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        available: bool,
        access: fn(&mut S) -> Option<&mut Remote>,
    ) -> El {
        let mut card = col().full_width().separate(Space::Sm).child(
            text(t("remoteAccess.sections.addresses.label"))
                .text_role(TextRole::Title)
                .role("heading"),
        );

        if self.meta_flight.is_some() && self.meta.is_none() {
            return chrome::card(
                card.child(
                    text(t("remoteAccess.addresses.loading"))
                        .role("status")
                        .wrap(),
                ),
            );
        }
        if let Some(err) = &self.meta_error {
            return chrome::card(card.child(text(err.as_str()).role("alert").wrap()));
        }

        let local_url = self.meta.as_ref().and_then(|m| m.local_url.as_deref());
        let (recommended, hidden) = if self.allow_external() {
            self.meta
                .as_ref()
                .map(|m| split_remote_addresses(&m.addresses))
                .unwrap_or((None, Vec::new()))
        } else {
            (None, Vec::new())
        };

        if local_url.is_none() && recommended.is_none() {
            return chrome::card(card.child(text(t("remoteAccess.addresses.none")).wrap()));
        }

        if let Some(url) = local_url {
            card = card.child(self.address_row(
                url,
                t("remoteAccess.address.scope.loopback"),
                shared,
                available,
                access,
            ));
        }
        if let Some(address) = recommended {
            card = card.child(self.network_address_row(address, shared, available, access));
        }
        if !hidden.is_empty() {
            let label = if self.show_other_addresses {
                t("remoteAccess.addresses.actions.hideOther").to_owned()
            } else {
                t("remoteAccess.addresses.actions.showOther")
                    .replace("{count}", &hidden.len().to_string())
            };
            card = card.child(
                layout::button(&label, false, move |s: &mut S| {
                    if let Some(state) = access(s) {
                        state.direct.show_other_addresses = !state.direct.show_other_addresses;
                    }
                })
                .expanded(self.show_other_addresses)
                .key("remote-addresses-toggle-other"),
            );
            if self.show_other_addresses {
                for address in hidden {
                    card = card.child(self.network_address_row(address, shared, available, access));
                }
            }
        }
        if self.open_failed {
            card = card.child(text(t("settings.info.actions.failed")).role("alert").wrap());
        }
        chrome::card(card)
    }

    fn network_address_row<S: 'static>(
        &self,
        address: &NetworkAddress,
        shared: &Rc<RefCell<Preferences>>,
        available: bool,
        access: fn(&mut S) -> Option<&mut Remote>,
    ) -> El {
        let scope = match address.scope.as_str() {
            "external" => t("remoteAccess.address.scope.network"),
            "loopback" => t("remoteAccess.address.scope.loopback"),
            _ => t("remoteAccess.address.scope.internal"),
        };
        let meta = format!(
            "{} · {scope} · {}",
            address.family.to_uppercase(),
            address.ip
        );
        self.address_row(&address.remote_url, &meta, shared, available, access)
    }

    fn address_row<S: 'static>(
        &self,
        url: &str,
        subtitle: &str,
        shared: &Rc<RefCell<Preferences>>,
        available: bool,
        access: fn(&mut S) -> Option<&mut Remote>,
    ) -> El {
        let open_url = url.to_owned();
        let copy_url = url.to_owned();
        let copy_shared = shared.clone();
        let open_label = t("remoteAccess.address.open");
        let copy_label = t(if self.address_copy.copied(url) {
            "remoteControl.pairing.copied"
        } else {
            "remoteControl.pairing.copy"
        });
        col()
            .full_width()
            .separate(Space::Xs)
            .child(text(url).wrap().literal_direction())
            .child(text(subtitle).wrap())
            .child(
                layout::action_row()
                    .child(
                        layout::button_tx(open_label, !available, move |s: &mut S, tx| {
                            let Some(state) = access(s) else { return };
                            state.direct.open_seq = state.direct.open_seq.wrapping_add(1);
                            state.direct.open_failed = false;
                            let seq = state.direct.open_seq;
                            let launch =
                                tx.open_url_then(&open_url, move |s: &mut S, result, _| {
                                    if let Some(state) = access(s)
                                        && state.direct.open_seq == seq
                                    {
                                        state.direct.open_failed = result.is_err();
                                    }
                                });
                            if launch.is_err() {
                                state.direct.open_failed = true;
                            }
                        })
                        .label(&format!("{open_label} · {url}")),
                    )
                    .child(
                        layout::button_tx(copy_label, !available, move |s: &mut S, tx| {
                            let Some(state) = access(s) else { return };
                            let prefs = copy_shared.borrow();
                            state.direct.address_copy.write(&copy_url, &prefs, tx);
                        })
                        .label(&format!("{copy_label} · {url}")),
                    ),
            )
            .children(
                self.address_copy
                    .failed(url)
                    .then(|| text(t("messageSection.quote.copyFailed")).role("alert")),
            )
    }

    #[cfg(test)]
    pub(super) fn meta_loaded(&self) -> bool {
        self.meta_flight.is_none() && self.meta.is_some()
    }

    #[cfg(test)]
    pub(super) fn mode_idle(&self) -> bool {
        self.mode_flight.is_none()
    }

    #[cfg(test)]
    pub(super) fn restart_notice_shown(&self) -> bool {
        self.mode_flight.is_none() && self.restart_notice
    }

    #[cfg(test)]
    pub(super) fn set_password_drafts(&mut self, password: &str, confirm: &str) {
        self.password = TextEdit::new(password);
        self.confirm = TextEdit::new(confirm);
    }

    #[cfg(test)]
    pub(super) fn password_idle(&self) -> bool {
        self.password_flight.is_none() && self.password_error.is_some()
    }

    #[cfg(test)]
    pub(super) fn password_saved(&self) -> bool {
        self.password_flight.is_none() && !self.password_form_open
    }

    #[cfg(test)]
    pub(super) fn password_drafts_empty(&self) -> bool {
        self.password.text.is_empty() && self.confirm.text.is_empty()
    }
}
