use super::{ErrorText, Preferences, Remote, pairing_view};
use crate::{backend::Backend, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::remote::{
        self, AuthStatus, DirectAccessMeta, ListeningMode, NetworkAddress, PasswordSaved,
        split_remote_addresses,
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
    meta_verified: bool,
    meta_server: Option<String>,
    meta_drop_gen: Option<u64>,
    meta_stream_drop_epoch: Option<u64>,
    meta_auth_gen: u64,
    auth: Option<AuthStatus>,
    auth_error: Option<ErrorText>,
    auth_gen: u64,
    pending_refresh: bool,
    meta_flight: Option<(u64, FlightStamp, Sender<()>, Receiver<MetaReply>)>,
    mode_flight: Option<(FlightStamp, Receiver<Result<Option<String>, remote::Error>>)>,
    password_flight: Option<(FlightStamp, Receiver<PasswordReply>)>,
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

type FlightStamp = (String, Option<String>, u64, u64, u64);

enum PasswordReply {
    Verified(PasswordSaved),
    ReauthRequired,
    Failed(remote::Error),
}

struct MetaReply {
    meta: Result<DirectAccessMeta, remote::Error>,
    auth: Result<AuthStatus, remote::Error>,
    verified: bool,
}

impl DirectAccess {
    fn current_stamp(prefs: &Preferences, backend: &Backend) -> FlightStamp {
        (
            backend.client_id.clone(),
            backend.client.server_identity().map(str::to_owned),
            backend.client.drop_generation(),
            backend.client.stream_drop_epoch(),
            prefs
                .authority_handle()
                .load(std::sync::atomic::Ordering::SeqCst),
        )
    }

    fn stamp_matches(prefs: &Preferences, backend: &Backend, stamp: &FlightStamp) -> bool {
        !prefs.transport_lost()
            && super::super::ServerOwner::backend_verified(backend)
            && stamp.0 == backend.client_id
            && stamp.1.as_deref() == backend.client.server_identity()
            && stamp.2 == backend.client.drop_generation()
            && stamp.3 == backend.client.stream_drop_epoch()
            && stamp.4
                == prefs
                    .authority_handle()
                    .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn close(&mut self) {
        let open_seq = self.open_seq.wrapping_add(1);
        self.wipe_password_fields();
        *self = Self {
            open_seq,
            ..Self::default()
        };
    }

    pub fn on_unverified(&mut self) {
        self.meta_flight = None;
        self.meta_verified = false;
        self.meta_drop_gen = None;
        self.meta_stream_drop_epoch = None;
        self.confirm_mode = None;
        self.auth = None;
    }

    fn form_matches_backend(&self, prefs: &Preferences, backend: &Backend) -> bool {
        self.meta_verified
            && !prefs.transport_lost()
            && super::super::ServerOwner::backend_verified(backend)
            && self.owner.as_deref() == Some(backend.client_id.as_str())
            && self.meta_drop_gen == Some(backend.client.drop_generation())
            && self.meta_stream_drop_epoch == Some(backend.client.stream_drop_epoch())
            && self.meta_server.as_deref() == backend.client.server_identity()
            && self.meta_auth_gen
                == prefs
                    .authority_handle()
                    .load(std::sync::atomic::Ordering::SeqCst)
    }

    fn wipe_password_fields(&mut self) {
        self.password = TextEdit::new("");
        self.confirm = TextEdit::new("");
    }

    fn mutating(&self, prefs: &Preferences) -> bool {
        self.mode_flight.is_some()
            || self.password_flight.is_some()
            || prefs.direct_access_locked(self.owner.as_deref())
    }

    pub fn refresh(&mut self, prefs: &Preferences, backend: &Backend, wake: &Waker) {
        if self.meta_flight.is_some() || self.mutating(prefs) {
            self.pending_refresh = true;
            return;
        }
        self.pending_refresh = false;
        self.owner = Some(backend.client_id.clone());
        self.meta_error = None;
        let auth_gen = self.auth_gen;
        let flight_stamp = Self::current_stamp(prefs, backend);
        let expected_server = flight_stamp.1.clone();
        let prepared_gen = flight_stamp.2;
        let prepared_stream_epoch = flight_stamp.3;
        let prefs_auth = prefs.authority_handle();
        let prefs_gen = flight_stamp.4;
        let (cancel, cancelled) = bounded(1);
        let (out, input) = bounded(1);
        self.meta_flight = Some((auth_gen, flight_stamp, cancel, input));
        let (backend, wake) = (backend.clone(), wake.clone());
        platform::spawn(async move {
            let still_ok = || {
                prefs_auth.load(std::sync::atomic::Ordering::SeqCst) == prefs_gen
                    && backend.client.drop_generation() == prepared_gen
                    && backend.client.stream_drop_epoch() == prepared_stream_epoch
                    && super::super::ServerOwner::backend_verified(&backend)
                    && expected_server
                        .as_deref()
                        .is_none_or(|id| backend.client.server_identity() == Some(id))
            };
            let task = async {
                let pre_ok = still_ok()
                    && (!backend.client.tracks_server_attestation()
                        || backend.attest_server().await.is_ok())
                    && still_ok();
                if !pre_ok {
                    return MetaReply {
                        meta: Err(remote::Error::Transport),
                        auth: Err(remote::Error::Transport),
                        verified: false,
                    };
                }
                let (meta, auth) = remote::direct_access_snapshot(&backend).await;
                let verified = still_ok()
                    && (!backend.client.tracks_server_attestation()
                        || backend.attest_server().await.is_ok())
                    && still_ok();
                MetaReply {
                    meta: if verified {
                        meta
                    } else {
                        Err(remote::Error::Transport)
                    },
                    auth: if verified {
                        auth
                    } else {
                        Err(remote::Error::Transport)
                    },
                    verified,
                }
            };
            let Some(reply) = platform::reads::cancellable(&cancelled, task).await else {
                return;
            };
            if out.send(reply).await.is_ok() {
                wake();
            }
        });
    }

    pub fn poll(&mut self, prefs: &Preferences, backend: Option<&Backend>, wake: &Waker) -> bool {
        let owner = backend.map(|b| b.client_id.as_str());
        if self.owner.as_deref() != owner {
            self.close();
            self.owner = owner.map(str::to_owned);
            if let Some(backend) = backend {
                self.refresh(prefs, backend, wake);
            }
            return true;
        }
        let mut changed = self.address_copy.poll();
        if let Some(backend) = backend
            && self.meta_verified
            && !self.form_matches_backend(prefs, backend)
        {
            self.on_unverified();
            self.refresh(prefs, backend, wake);
            changed = true;
        }
        if self.mode_flight.is_none()
            && self.password_flight.is_none()
            && prefs.take_finished_direct_access_lock(owner)
        {
            self.pending_refresh = true;
            changed = true;
        }
        if let Some((flight_auth_gen, flight_stamp, _, flight)) = &self.meta_flight {
            let flight_auth_gen = *flight_auth_gen;
            match flight.try_recv() {
                Ok(reply) => {
                    let flight_stamp = flight_stamp.clone();
                    self.meta_flight = None;
                    let verified = reply.verified
                        && backend.is_some_and(|b| Self::stamp_matches(prefs, b, &flight_stamp));
                    match reply.meta {
                        Ok(meta) if verified => {
                            self.meta = Some(meta);
                            self.meta_verified = true;
                            self.meta_server =
                                backend.and_then(|b| b.client.server_identity().map(str::to_owned));
                            self.meta_drop_gen = backend.map(|b| b.client.drop_generation());
                            self.meta_stream_drop_epoch =
                                backend.map(|b| b.client.stream_drop_epoch());
                            self.meta_auth_gen = prefs
                                .authority_handle()
                                .load(std::sync::atomic::Ordering::SeqCst);
                            self.meta_error = None;
                            self.show_other_addresses = false;
                        }
                        Ok(_) => {
                            self.on_unverified();
                            self.meta_error = Some(ErrorText::Key("rune.connect_error"));
                        }
                        Err(err) => {
                            self.on_unverified();
                            self.meta_error = Some(if verified {
                                ErrorText::from_remote(err, "rune.connect_error")
                            } else {
                                ErrorText::Key("rune.connect_error")
                            });
                        }
                    }
                    if flight_auth_gen == self.auth_gen && verified {
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
                    }
                    changed = true;
                }
                Err(_) if flight.is_closed() => {
                    self.on_unverified();
                    self.meta_error = Some(ErrorText::Key("rune.connect_error"));
                    changed = true;
                }
                Err(_) => {}
            }
        }
        if let Some((flight_stamp, flight)) = &self.mode_flight {
            match flight.try_recv() {
                Ok(result) => {
                    let flight_stamp = flight_stamp.clone();
                    self.mode_flight = None;
                    prefs.clear_direct_access_lock();
                    let current =
                        backend.is_some_and(|b| Self::stamp_matches(prefs, b, &flight_stamp));
                    match result {
                        Ok(warning) if current => {
                            self.restart_notice = true;
                            self.mode_error = warning.map(ErrorText::Raw);
                            if let Some(backend) = backend {
                                self.refresh(prefs, backend, wake);
                            }
                        }
                        Ok(_) => {
                            self.on_unverified();
                            self.restart_notice = false;
                            self.mode_error = Some(ErrorText::Key("settings.preferenceSaveFailed"));
                        }
                        Err(err) => {
                            self.restart_notice = false;
                            if !current {
                                self.on_unverified();
                            }
                            self.mode_error = Some(if current {
                                ErrorText::from_remote(err, "settings.preferenceSaveFailed")
                            } else {
                                ErrorText::Key("settings.preferenceSaveFailed")
                            });
                        }
                    }
                    changed = true;
                }
                Err(_) if flight.is_closed() => {
                    self.mode_flight = None;
                    prefs.clear_direct_access_lock();
                    self.mode_error = Some(ErrorText::Key("settings.preferenceSaveFailed"));
                    changed = true;
                }
                Err(_) => {}
            }
        }
        if let Some((flight_stamp, flight)) = &self.password_flight {
            match flight.try_recv() {
                Ok(result) => {
                    let flight_stamp = flight_stamp.clone();
                    self.password_flight = None;
                    prefs.clear_direct_access_lock();
                    let current =
                        backend.is_some_and(|b| Self::stamp_matches(prefs, b, &flight_stamp));
                    match result {
                        PasswordReply::Verified(saved) if current => {
                            self.auth_gen = self.auth_gen.wrapping_add(1);
                            self.wipe_password_fields();
                            self.password_form_open = false;
                            self.password_error = None;
                            match saved.auth {
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
                        }
                        PasswordReply::ReauthRequired => {
                            // Saving the password revoked the calling session cookie as expected;
                            // close the form and wait for an attested new session to report auth
                            // status without replaying POST or surfacing a bogus failure.
                            self.auth_gen = self.auth_gen.wrapping_add(1);
                            self.wipe_password_fields();
                            self.password_form_open = false;
                            self.password_error = None;
                            self.auth_error = None;
                            self.on_unverified();
                        }
                        PasswordReply::Verified(_) => {
                            self.on_unverified();
                            self.password_error =
                                Some(ErrorText::Key("settings.preferenceSaveFailed"));
                            if let Some(backend) = backend {
                                self.refresh(prefs, backend, wake);
                            }
                        }
                        PasswordReply::Failed(err) => {
                            if !current {
                                self.on_unverified();
                            }
                            self.password_error = Some(if current {
                                ErrorText::from_remote(err, "settings.preferenceSaveFailed")
                            } else {
                                ErrorText::Key("settings.preferenceSaveFailed")
                            });
                            if let Some(backend) = backend {
                                self.refresh(prefs, backend, wake);
                            }
                        }
                    }
                    changed = true;
                }
                Err(_) if flight.is_closed() => {
                    self.password_flight = None;
                    prefs.clear_direct_access_lock();
                    self.password_error = Some(ErrorText::Key("settings.preferenceSaveFailed"));
                    if let Some(backend) = backend {
                        self.refresh(prefs, backend, wake);
                    }
                    changed = true;
                }
                Err(_) => {}
            }
        }
        if self.pending_refresh
            && self.meta_flight.is_none()
            && !self.mutating(prefs)
            && let Some(backend) = backend
        {
            self.refresh(prefs, backend, wake);
            changed = true;
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

    fn start_listening_mode(
        &mut self,
        prefs: &Preferences,
        backend: &Backend,
        wake: &Waker,
        target: ListeningMode,
    ) {
        if self.mutating(prefs)
            || self.meta_flight.is_some()
            || !self.form_matches_backend(prefs, backend)
            || !self
                .meta
                .as_ref()
                .is_some_and(|m| !m.listening_locked && m.local_request)
        {
            return;
        }
        self.confirm_mode = None;
        self.mode_error = None;
        self.restart_notice = false;
        let flight_stamp = Self::current_stamp(prefs, backend);
        let expected_server = flight_stamp.1.clone();
        let prepared_gen = flight_stamp.2;
        let prepared_stream_epoch = flight_stamp.3;
        let prefs_auth = prefs.authority_handle();
        let prefs_gen = flight_stamp.4;
        let (out, input) = bounded(1);
        let (lock_tx, lock_rx) = bounded::<()>(1);
        self.mode_flight = Some((flight_stamp, input));
        prefs.set_direct_access_lock(backend.client_id.clone(), lock_rx);
        let (backend, wake) = (backend.clone(), wake.clone());
        platform::spawn(async move {
            let still_ok = || {
                prefs_auth.load(std::sync::atomic::Ordering::SeqCst) == prefs_gen
                    && backend.client.drop_generation() == prepared_gen
                    && backend.client.stream_drop_epoch() == prepared_stream_epoch
                    && super::super::ServerOwner::backend_verified(&backend)
                    && expected_server
                        .as_deref()
                        .is_none_or(|id| backend.client.server_identity() == Some(id))
            };
            let attest = || async {
                still_ok()
                    && (!backend.client.tracks_server_attestation()
                        || backend.attest_server().await.is_ok())
                    && still_ok()
            };
            let result = if attest().await {
                match remote::set_listening_mode(&backend, target).await {
                    Ok(warning) if attest().await => Ok(warning),
                    Ok(_) => Err(remote::Error::Transport),
                    Err(remote::Error::Server(msg)) if attest().await => {
                        Err(remote::Error::Server(msg))
                    }
                    Err(remote::Error::Server(_)) => Err(remote::Error::Transport),
                    Err(err) => Err(err),
                }
            } else {
                Err(remote::Error::Transport)
            };
            drop(lock_tx);
            let _ = out.send(result).await;
            wake();
        });
    }

    fn submit_password(&mut self, prefs: &Preferences, backend: &Backend, wake: &Waker) {
        if self.mutating(prefs)
            || !self.form_matches_backend(prefs, backend)
            || !self.meta.as_ref().is_some_and(|m| m.local_request)
        {
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
        self.auth_gen = self.auth_gen.wrapping_add(1);
        let flight_stamp = Self::current_stamp(prefs, backend);
        let expected_server = flight_stamp.1.clone();
        let prepared_gen = flight_stamp.2;
        let prepared_stream_epoch = flight_stamp.3;
        let prefs_auth = prefs.authority_handle();
        let prefs_gen = flight_stamp.4;
        let (out, input) = bounded(1);
        let (lock_tx, lock_rx) = bounded::<()>(1);
        self.password_flight = Some((flight_stamp, input));
        prefs.set_direct_access_lock(backend.client_id.clone(), lock_rx);
        let (backend, wake) = (backend.clone(), wake.clone());
        platform::spawn(async move {
            let still_ok = || {
                prefs_auth.load(std::sync::atomic::Ordering::SeqCst) == prefs_gen
                    && backend.client.drop_generation() == prepared_gen
                    && backend.client.stream_drop_epoch() == prepared_stream_epoch
                    && super::super::ServerOwner::backend_verified(&backend)
                    && expected_server
                        .as_deref()
                        .is_none_or(|id| backend.client.server_identity() == Some(id))
            };
            let attest = || async {
                still_ok()
                    && (!backend.client.tracks_server_attestation()
                        || backend.attest_server().await.is_ok())
                    && still_ok()
            };
            let result = if attest().await {
                match remote::set_password(&backend, &next).await {
                    Ok(saved) => {
                        let auth_revoked = matches!(&saved.auth, Ok(auth) if !auth.authenticated);
                        if !backend.client.tracks_server_attestation() {
                            if still_ok() {
                                PasswordReply::Verified(saved)
                            } else {
                                PasswordReply::Failed(remote::Error::Transport)
                            }
                        } else {
                            match backend.attest_server().await {
                                Ok(_) if still_ok() => PasswordReply::Verified(saved),
                                Err(err)
                                    if auth_revoked
                                        && codenomad_client::http::is_unauthorized(&err) =>
                                {
                                    PasswordReply::ReauthRequired
                                }
                                _ => PasswordReply::Failed(remote::Error::Transport),
                            }
                        }
                    }
                    Err(remote::Error::Server(msg)) if attest().await => {
                        PasswordReply::Failed(remote::Error::Server(msg))
                    }
                    Err(remote::Error::Server(_)) => {
                        PasswordReply::Failed(remote::Error::Transport)
                    }
                    Err(err) => PasswordReply::Failed(err),
                }
            } else {
                PasswordReply::Failed(remote::Error::Transport)
            };
            drop(lock_tx);
            let _ = out.send(result).await;
            wake();
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
            .child(
                text(t("remoteAccess.direct.help"))
                    .text_role(TextRole::Small)
                    .wrap(),
            )
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
        let applying = self.mutating(&shared.borrow());
        let locked = self.meta.as_ref().is_some_and(|m| m.listening_locked);
        let local_request = self.meta.as_ref().is_none_or(|m| m.local_request);
        let allow_external = self.allow_external();
        let refresh_shared = shared.clone();
        let refresh = chrome::secondary_action(
            t("remoteAccess.refresh"),
            !available || loading || applying,
            move |s: &mut S| {
                let Some(state) = access(s) else { return };
                state.direct.password_error = None;
                let prefs = refresh_shared.borrow();
                if let Some(backend) = prefs.backend.as_ref().filter(|_| prefs.can_retry())
                    && let Some(wake) = prefs.window_wake.as_ref().or(prefs.main_wake.as_ref())
                {
                    state.direct.refresh(&prefs, backend, wake);
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
            !available
                || loading
                || applying
                || locked
                || !local_request
                || !self.meta_verified
                || self.meta.is_none(),
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
                text(t("remoteAccess.toggle.caption.locked").replace("{host}", host))
                    .text_role(TextRole::Small)
                    .wrap(),
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
                    .inset_surface()
                    .pad(Space::Sm)
                    .separate(Space::Xs)
                    .key("remote-listening-confirm")
                    .child(
                        text(t(title_key))
                            .text_role(TextRole::Title)
                            .role("heading"),
                    )
                    .child(
                        text(t("remoteAccess.listeningMode.restartConfirm.message"))
                            .text_role(TextRole::Small)
                            .wrap(),
                    )
                    .child(
                        layout::action_row()
                            .child(
                                chrome::primary_action(
                                    t("remoteAccess.listeningMode.restartConfirm.confirmLabel"),
                                    !available || loading || applying || !self.meta_verified,
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
                                            state.direct.start_listening_mode(
                                                &prefs, backend, wake, target,
                                            );
                                        }
                                    },
                                )
                                .key("remote-listening-confirm-apply"),
                            )
                            .child(
                                chrome::secondary_action(
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
                    .text_role(TextRole::Small)
                    .role("status")
                    .wrap(),
            );
        }
        if let Some(err) = &self.mode_error {
            card = card.child(chrome::palette::save_error(err.as_str()));
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
            .child(
                text(t("remoteAccess.sections.serverPassword.help"))
                    .text_role(TextRole::Small)
                    .wrap(),
            );

        let Some(auth) = self.auth.as_ref().filter(|a| a.authenticated) else {
            let message = self
                .auth_error
                .as_ref()
                .map(ErrorText::as_str)
                .unwrap_or_else(|| t("remoteAccess.authStatus.unavailable"));
            return chrome::card(
                card.child(text(message).text_role(TextRole::Small).wrap())
                    .children(
                        self.password_error
                            .as_ref()
                            .map(|err| chrome::palette::save_error(err.as_str())),
                    ),
            );
        };

        let username = auth.username.as_deref().unwrap_or("codenomad");
        let status_key = if auth.password_user_provided {
            "remoteAccess.password.status.set"
        } else {
            "remoteAccess.password.status.unset"
        };
        let saving = self.password_flight.is_some();
        let mutating = self.mutating(&shared.borrow());
        let local_request = self.meta.as_ref().is_some_and(|m| m.local_request);
        card = card
            .child(
                text(t("remoteAccess.username").replace("{username}", username))
                    .text_role(TextRole::Small)
                    .wrap(),
            )
            .child(text(t(status_key)).text_role(TextRole::Small).wrap());

        if local_request {
            let toggle_label = t(if self.password_form_open {
                "remoteAccess.password.actions.cancel"
            } else if auth.password_user_provided {
                "remoteAccess.password.actions.change"
            } else {
                "remoteAccess.password.actions.set"
            });
            card = card.child(
                chrome::secondary_action(
                    toggle_label,
                    !available || mutating || !self.meta_verified,
                    move |s: &mut S| {
                        if let Some(state) = access(s) {
                            state.direct.password_form_open = !state.direct.password_form_open;
                            state.direct.password_error = None;
                            if !state.direct.password_form_open {
                                state.direct.wipe_password_fields();
                            }
                        }
                    },
                )
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
                    .autofill(rune::Autofill::NewPassword)
                    .disabled(saving)
                    .on_edit(move |s: &mut S| &mut edit(s).direct.password)
                    .build(&field_kit(layout::dark()))
                    .literal_direction()
                    .key("remote-password-new");
            let confirm_input = layout::literal_field(&self.confirm)
                .label(confirm_label)
                .secure()
                .autofill(rune::Autofill::NewPassword)
                .disabled(saving)
                .on_edit(move |s: &mut S| &mut edit(s).direct.confirm)
                .on_submit(move |s: &mut S, _| {
                    let Some(state) = access(s) else { return };
                    let prefs = submit_shared.borrow();
                    if let Some(backend) = prefs.backend.as_ref().filter(|_| prefs.can_retry())
                        && let Some(wake) = prefs.window_wake.as_ref().or(prefs.main_wake.as_ref())
                    {
                        state.direct.submit_password(&prefs, backend, wake);
                    }
                })
                .build(&field_kit(layout::dark()))
                .key("remote-password-confirm");

            card = card
                .child(text(new_label).text_role(TextRole::Label))
                .child(password_input)
                .child(text(confirm_label).text_role(TextRole::Label))
                .child(confirm_input)
                .children(
                    self.password_error
                        .as_ref()
                        .map(|err| chrome::palette::save_error(err.as_str())),
                )
                .child(
                    chrome::primary_action(
                        t(if saving {
                            "remoteAccess.password.save.saving"
                        } else {
                            "remoteAccess.password.save.label"
                        }),
                        !available || mutating || !self.meta_verified,
                        move |s: &mut S| {
                            let Some(state) = access(s) else { return };
                            let prefs = save_shared.borrow();
                            if let Some(backend) =
                                prefs.backend.as_ref().filter(|_| prefs.can_retry())
                                && let Some(wake) =
                                    prefs.window_wake.as_ref().or(prefs.main_wake.as_ref())
                            {
                                state.direct.submit_password(&prefs, backend, wake);
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

        if let Some(err) = &self.meta_error {
            return chrome::card(card.child(chrome::palette::save_error(err.as_str())));
        }
        if !self.meta_verified {
            return chrome::card(
                card.child(
                    text(t("remoteAccess.addresses.loading"))
                        .text_role(TextRole::Small)
                        .role("status")
                        .wrap(),
                ),
            );
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
            return chrome::card(
                card.child(
                    text(t("remoteAccess.addresses.none"))
                        .text_role(TextRole::Small)
                        .wrap(),
                ),
            );
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
                chrome::secondary_action(&label, false, move |s: &mut S| {
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
            card = card.child(chrome::palette::save_error(t(
                "settings.info.actions.failed",
            )));
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
            .inset_surface()
            .pad(Space::Sm)
            .separate(Space::Xs)
            .child(
                text(url)
                    .text_role(TextRole::Mono)
                    .wrap()
                    .literal_direction(),
            )
            .child(text(subtitle).text_role(TextRole::Small).wrap())
            .child(
                layout::action_row()
                    .child(
                        chrome::secondary_action_tx(
                            open_label,
                            !available || !self.meta_verified,
                            move |s: &mut S, tx| {
                                let Some(state) = access(s) else { return };
                                if !state.direct.meta_verified {
                                    return;
                                }
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
                            },
                        )
                        .label(&format!("{open_label} · {url}")),
                    )
                    .child(
                        chrome::secondary_action_tx(
                            copy_label,
                            !available || !self.meta_verified,
                            move |s: &mut S, tx| {
                                let Some(state) = access(s) else { return };
                                if !state.direct.meta_verified {
                                    return;
                                }
                                let prefs = copy_shared.borrow();
                                state.direct.address_copy.write(&copy_url, &prefs, tx);
                            },
                        )
                        .label(&format!("{copy_label} · {url}")),
                    ),
            )
            .children(
                self.address_copy
                    .failed(url)
                    .then(|| chrome::palette::save_error(t("messageSection.quote.copyFailed"))),
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
