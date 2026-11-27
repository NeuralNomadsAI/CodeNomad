//! Preferences owns its native window; its confirmed host settings also feed the shell.
mod advanced;
mod behavior;
mod config_files;
mod contrast;
mod conversation;
mod general;
mod host_support;
mod info;
mod integrations;
mod memory;
pub(crate) mod notification_routing;
mod notification_settings;
mod opencode;
mod palettes;
mod preferences;
mod providers;
mod remote;
pub(crate) mod startup_state;
mod stats;
pub(crate) mod transcript_filters;
mod transcript_preset;
pub(crate) use transcript_preset::Row as TranscriptRow;

pub(crate) fn show_timeline(s: &crate::State) -> bool {
    s.settings.shared.borrow().show_timeline()
}
#[cfg(not(target_arch = "wasm32"))]
mod view;
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
mod web_contrast;

mod appearance;
mod connection;
mod delivery;
pub(crate) mod shortcuts;
mod window;

use appearance::awaiting_appearance;
#[cfg(test)]
use appearance::effective_contrast;
#[cfg(not(target_arch = "wasm32"))]
use appearance::render_with;
pub(crate) use appearance::{app_locale, render};
pub(crate) use connection::{
    authentication_required, bound_backend, connected, connection_event,
    conversation_authentication, invalidate, stop_before_conversation, tab_activated,
};
#[cfg(test)]
use connection::{provider_changed, provider_stopped};
pub(crate) use delivery::{ConfirmedRoute, Delivery, notification_route, system_notification};
#[cfg(test)]
pub(crate) use delivery::{
    notification_fixture, notification_fixture_for, notification_test_config,
};
pub(crate) use shortcuts::{shortcut_label, with_shortcut_label, with_shortcut_label_excluding};
#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub(crate) use window::gallery;
pub(crate) use window::{
    close, close_request, direct_entry, entries, open_preferences, open_providers,
};
#[cfg(not(target_arch = "wasm32"))]
use window::{launch_preferences, settle_close, warn_save_failed};

use crate::{State, backend::Backend, strings};
use preferences::Preferences;
#[cfg(not(target_arch = "wasm32"))]
use std::cell::Cell;
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ServerOwner {
    client_id: String,
    base: String,
    server: Option<String>,
}

impl ServerOwner {
    pub fn from_backend(backend: &Backend) -> Self {
        Self {
            client_id: backend.client_id.clone(),
            base: backend.base.clone(),
            server: (!backend.client.attestation_revoked())
                .then(|| backend.client.server_identity().map(str::to_owned))
                .flatten(),
        }
    }

    #[cfg(test)]
    pub fn fixture() -> Self {
        Self {
            client_id: "fixture".into(),
            base: "http://127.0.0.1/".into(),
            server: Some("fixture".into()),
        }
    }

    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    pub fn server(&self) -> Option<&str> {
        self.server.as_deref()
    }

    pub fn seen_key(&self) -> &str {
        self.server.as_deref().unwrap_or(&self.base)
    }

    pub fn backend_verified(backend: &Backend) -> bool {
        !backend.client.attestation_revoked()
            && !backend.client.needs_capability_recheck()
            && !(backend.client.tracks_server_attestation()
                && backend.client.has_unattested_stream_drop())
    }

    pub fn same_server(&self, other: &Self) -> bool {
        (self.client_id == other.client_id
            && (self.server.is_none() || other.server.is_none() || self.server == other.server))
            || (self.base == other.base && self.server.is_some() && self.server == other.server)
    }

    pub fn same_backend_server(&self, backend: &Backend) -> bool {
        let backend_id = backend.client.server_identity();
        if self.client_id == backend.client_id {
            self.server.is_none() || backend_id.is_none() || self.server.as_deref() == backend_id
        } else {
            self.base == backend.base
                && self.server.is_some()
                && !backend.client.attestation_revoked()
                && self.server.as_deref() == backend_id
        }
    }

    pub fn verified_for_write(&self, backend: &Backend) -> bool {
        self.same_backend_server(backend) && Self::backend_verified(backend)
    }

    pub fn adopt_same_server(&mut self, backend: &Backend) -> bool {
        if self.server.is_none() && !backend.client.attestation_revoked() {
            self.server = backend.client.server_identity().map(str::to_owned);
        }
        if self.client_id != backend.client_id {
            self.client_id = backend.client_id.clone();
            true
        } else {
            false
        }
    }
}

#[derive(Default)]
pub(crate) struct Host {
    shared: Rc<RefCell<Preferences>>,
    #[cfg(not(target_arch = "wasm32"))]
    window: Option<(rune::WindowHandle, Rc<Cell<bool>>, Rc<view::CloseRequest>)>,
    #[cfg(target_arch = "wasm32")]
    web: web::Panel,
    #[cfg(target_arch = "wasm32")]
    contrast: Option<web_contrast::Watch>,
    #[cfg(target_arch = "wasm32")]
    last_contrast: bool,
    last_display: Option<([&'static str; 3], String, String, bool, bool, bool)>,
    last_revision: u64,
    last_transcript: Option<[&'static str; transcript_preset::ROW_COUNT]>,
    transcript_filters: transcript_filters::Filters,
    memory_cleanup: Option<memory::cleanup::Run>,
}

pub(crate) fn message_usage_visibility(s: &State) -> &'static str {
    s.settings.shared.borrow().usage_visibility(false)
}

pub(crate) fn match_shortcut<T>(
    s: &State,
    event: &rune::KeyEvent,
    tx: &rune::Tx,
    find: impl FnOnce(&dyn Fn(&str) -> bool) -> Option<T>,
) -> Option<T> {
    let preferences = s.settings.shared.borrow();
    let matches = |id: &str| shortcuts::matches_shortcut_in(&preferences, id, event, tx);
    find(&matches)
}

pub(crate) fn blocks_shell_shortcuts(s: &State) -> bool {
    let awaiting = awaiting_appearance(s, &s.settings.shared.borrow());
    let filters = s.settings.transcript_filters.is_open(&s.input_scope);
    #[cfg(target_arch = "wasm32")]
    return awaiting || filters || s.settings.web.shown();
    #[cfg(not(target_arch = "wasm32"))]
    {
        awaiting || filters
    }
}

pub(crate) fn transcript_mode(s: &State, row: TranscriptRow) -> &'static str {
    s.settings.shared.borrow().transcript_mode(row, false)
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) fn fixture_transcript(s: &mut State, settings: serde_json::Value) {
    s.settings.shared.borrow_mut().fixture_transcript(settings);
    s.revision += 1;
}

#[cfg(test)]
pub(crate) fn fixture_appearance(
    s: &mut State,
    light_scheme: &str,
    dark_scheme: &str,
    high_contrast: &str,
) {
    s.settings
        .shared
        .borrow_mut()
        .fixture_appearance(light_scheme, dark_scheme, high_contrast);
    s.revision += 1;
}

#[cfg(test)]
pub(crate) fn fixture_message_usage(s: &mut State, mode: &str) {
    s.settings.shared.borrow_mut().fixture_usage(mode);
    s.revision += 1;
}

pub(crate) fn poll_window_actions(s: &mut State, tx: &mut rune::Tx) -> bool {
    let changed = memory::cleanup::poll(s, tx);
    #[cfg(target_arch = "wasm32")]
    return changed
        | s.settings.web.poll_window_actions(
            &s.settings.shared.borrow(),
            s.settings.transcript_filters.is_open(&s.input_scope),
            !crate::platform::pairing::required(s),
            tx,
        );
    #[cfg(not(target_arch = "wasm32"))]
    changed
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn poll_stats(s: &mut State, now: f64, tx: &mut rune::Tx) -> bool {
    let paired = !crate::platform::pairing::required(s);
    let mut shared = s.settings.shared.borrow_mut();
    let language = shared.locale().unwrap_or_else(strings::locale);
    strings::with_locale(language, || {
        s.settings
            .web
            .poll_stats(&mut shared, &s.wake, paired, now, tx)
    })
}

pub(crate) fn poll(s: &mut State, tx: &mut rune::Tx) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    if s.settings
        .window
        .as_ref()
        .is_some_and(|(_, _, request)| request.close_main_now.replace(false))
    {
        tx.close_window();
        return true;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if let Some((request, editor)) = s.settings.window.as_ref().and_then(|(_, _, request)| {
        let editor = request.reopen.borrow_mut().take();
        (editor.is_some()
            || request.config_reopen.borrow().is_some()
            || request.palette_reopen.borrow().is_some())
        .then(|| (request.clone(), editor))
    }) {
        launch_preferences(s, request, editor);
    }
    let mut shared = s.settings.shared.borrow_mut();
    if shared.main_wake.is_none() {
        shared.main_wake = Some(s.wake.clone());
        #[cfg(target_arch = "wasm32")]
        {
            s.settings.contrast = web_contrast::Watch::new(s.wake.clone());
        }
    }
    let bound = s
        .screen
        .launcher()
        .is_some_and(|launcher| shared.bind(launcher.connection.clone()));
    let expired = shared.observe_authentication();
    let mut renewing = false;
    if expired {
        let expired_backend = shared.backend.clone();
        if let Some(launcher) = s.screen.launcher_mut() {
            launcher.authentication_required = true;
            if let Some(expired_backend) = &expired_backend {
                renewing = launcher.start_managed_renewal(expired_backend);
            }
        }
        s.phase = if renewing {
            crate::Phase::Reconnecting
        } else {
            crate::Phase::Failed
        };
        s.workspace_open.cancel();
        s.command_palette.dismiss();
        s.tab_rename.dismiss();
        s.temporary.cancel_for_auth();
        s.blank_cleanup.cancel();
    }
    {
        let watch = s.screen.launcher().and_then(|l| l.catalogue_watch.as_ref());
        let observation = watch.map(|watch| watch.take_provider_changes());
        let location_changes = watch
            .map(|watch| watch.take_provider_location_changes())
            .unwrap_or_default();
        let moves = watch
            .map(|watch| watch.take_provider_moves())
            .unwrap_or_default();
        let stats_changes = watch.map(|watch| {
            watch.take_stats_changes(
                shared
                    .provider_target
                    .as_ref()
                    .map(|target| target.location().0),
            )
        });
        let integration_changes = watch.map(|watch| watch.take_integration_changes());
        let (changes, stopped, generation) = observation.map_or_else(
            || (Default::default(), Default::default(), None),
            |(changes, stopped, generation)| (changes, stopped, Some(generation)),
        );
        if shared.provider_target.is_some() {
            let backend = shared.backend.clone();
            let old = shared
                .provider_target
                .as_ref()
                .map(|target| target.revision());
            let mut native_changed = false;
            if let Some(target) = &mut shared.provider_target {
                if !target.validate(s, backend.as_ref(), &changes, &moves, &stopped, generation) {
                    shared.provider_target = None;
                } else {
                    if let Some((_, status)) = stats_changes.as_ref() {
                        native_changed = target.observe_native_status(*status);
                    }
                    if target.matches(&location_changes) {
                        target.invalidate_location();
                    }
                }
            }
            let stats_changed = shared
                .provider_target
                .as_mut()
                .zip(stats_changes.as_ref())
                .is_some_and(|(target, (changes, status))| {
                    target.stats_catalogue(changes, *status)
                });
            let integrations_changed = shared
                .provider_target
                .as_mut()
                .zip(integration_changes.as_ref())
                .is_some_and(|(target, (changes, session_changes))| {
                    target.integrations_catalogue(changes, session_changes)
                });
            if (old
                != shared
                    .provider_target
                    .as_ref()
                    .map(|target| target.revision())
                || !matches!(changes, codenomad_client::stream::CatalogueChanges::None)
                || native_changed
                || bound
                || stats_changed
                || integrations_changed)
                && let Some(wake) = &shared.window_wake
            {
                wake();
            }
        }
    }
    let stream_clients = crate::workspace::conversation_stream_clients(s);
    shared.observe_conversation_clients(&stream_clients);
    if s.screen
        .launcher()
        .is_some_and(|launcher| launcher.authentication_required)
    {
        shared.unwatch();
    } else if let Some(project) = crate::workspace::mission_observation_project(s) {
        shared.watch_project(Some(project), &s.wake);
    } else if crate::workspace::has_conversation_stream(s) {
        shared.unwatch();
    } else {
        shared.watch(&s.wake);
    }
    let preferences_changed = bound | shared.poll();
    if preferences_changed && let Some(wake) = &shared.window_wake {
        wake();
    }
    let locale = shared.locale().unwrap_or_else(strings::locale);
    #[cfg(target_arch = "wasm32")]
    if s.settings
        .last_display
        .as_ref()
        .is_none_or(|(last, ..)| last[0] != locale)
        && let Some(root) = web_sys::window()
            .and_then(|window| window.document())
            .and_then(|document| document.document_element())
    {
        let _ = root.set_attribute("lang", locale);
    }
    let display = Some((
        [locale, shared.mode(), shared.contrast()],
        shared.palette_display_signature(false),
        shared.palette_display_signature(true),
        awaiting_appearance(s, &shared),
        shared.show_timeline(),
        shared.transcript_ready(),
    ));
    let mut rows = TranscriptRow::all();
    let transcript = Some(std::array::from_fn(|_| {
        shared.transcript_mode(rows.next().unwrap(), false)
    }));
    let transcript_changed = s.settings.last_transcript != transcript;
    let keep_passage = transcript_changed && s.settings.last_transcript.is_some();
    if transcript_changed {
        s.settings.last_transcript = transcript;
        s.revision += 1;
    }
    #[cfg(target_arch = "wasm32")]
    let changed = {
        let more = s
            .settings
            .contrast
            .as_ref()
            .is_some_and(web_contrast::Watch::more);
        let contrast_changed = std::mem::replace(&mut s.settings.last_contrast, more) != more;
        let paired = !crate::platform::pairing::required(s);
        contrast_changed
            | s.settings.web.poll(&mut shared, &s.wake, paired)
            | (s.settings.web.shown() && preferences_changed)
    };
    #[cfg(not(target_arch = "wasm32"))]
    let changed = false;
    let revision_changed =
        shared.revision != std::mem::replace(&mut s.settings.last_revision, shared.revision);
    let (reconnected, missions) = shared.mission_changes();
    let locale = shared.locale().unwrap_or_else(strings::locale);
    let notify_failure = shared.take_notification_failure();
    let update = shared.notification_update.take();
    let startup_notice = shared.startup.take_notice();
    drop(shared);
    let startup_changed = startup_state::StartupState::poll_main(s);
    let startup_notice =
        startup_notice.or_else(|| s.settings.shared.borrow_mut().startup.take_notice());
    strings::with_locale(locale, || {
        use crate::shell::notifications::{Category, emit, emit_outcome};
        if notify_failure {
            emit_outcome(
                s,
                Category::Settings,
                None,
                strings::t("settings.preferenceSaveFailed"),
                true,
            );
        }
        if let Some((key, failed)) = startup_notice {
            emit_outcome(s, Category::Settings, None, strings::t(key), failed);
        }
        if let Some(version) = update {
            emit(
                s,
                Category::Updates,
                Some(strings::t("releases.devUpdateAvailable.title").into()),
                strings::t("settings.opencode.update.available").replace("{version}", &version),
            );
        }
    });
    if expired {
        if !renewing {
            s.show_launcher();
        }
        crate::workspace::suspend_missions(s);
    } else {
        if keep_passage {
            crate::chat::reading::keep_passage(s, tx);
        }
        if reconnected {
            crate::workspace::mission_event(s, None);
        }
        for event in &missions {
            crate::workspace::mission_event(s, Some(event));
        }
    }
    let filters_changed =
        preferences_changed && s.settings.transcript_filters.is_open(&s.input_scope);
    let display_changed = s.settings.last_display != display;
    s.settings.last_display = display;
    preferences_changed
        | revision_changed
        | changed
        | startup_changed
        | expired
        | filters_changed
        | transcript_changed
        | display_changed
}

pub(crate) fn queues_follow_ups(s: &State) -> bool {
    s.settings.shared.borrow().queues_follow_ups()
}

pub(crate) fn with_shortcut<T>(
    s: &State,
    action: &str,
    read: impl FnOnce(Option<&[serde_json::Value]>) -> T,
) -> T {
    read(s.settings.shared.borrow().shortcut(action))
}

pub(crate) fn show_provider_usage_credit_balance(s: &State) -> bool {
    s.settings
        .shared
        .borrow()
        .saved(codenomad_client::settings::Owner::Config)
        .is_some_and(|config| config["settings"]["showProviderUsageCreditBalance"] == true)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn keep_computer_awake(s: &State) -> bool {
    s.settings
        .shared
        .borrow()
        .general_toggle(preferences::behavior::GeneralToggle::KeepComputerAwake)
        == Some(true)
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn focus_existing_window_on_second_launch(s: &State) -> bool {
    s.settings
        .shared
        .borrow()
        .advanced_toggle(advanced::Toggle::SecondLaunch)
        == Some(true)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn locale(s: &State) -> &'static str {
    s.settings
        .shared
        .borrow()
        .locale()
        .unwrap_or_else(strings::locale)
}

#[cfg(test)]
pub(crate) fn fixture_shortcuts(s: &State, overrides: serde_json::Value) {
    s.settings.shared.borrow_mut().fixture_shortcuts(overrides);
}

#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) fn fixture_config(s: &mut State, url: &str, settings: serde_json::Value) {
    s.settings.shared.borrow_mut().fixture_config(url, settings);
}

#[derive(Default)]
pub(super) struct ExternalLink {
    failed: bool,
    seq: u64,
}

impl ExternalLink {
    pub(super) fn failed(&self) -> bool {
        self.failed
    }

    pub(super) fn clear(&mut self) {
        self.seq = self.seq.wrapping_add(1);
        self.failed = false;
    }

    pub(super) fn open<S: 'static>(
        &mut self,
        url: &str,
        tx: &mut rune::Tx,
        access: impl Fn(&mut S) -> Option<&mut Self> + 'static,
    ) {
        self.clear();
        let seq = self.seq;
        let launch = tx.open_url_then(url, move |s: &mut S, result, _| {
            if let Some(link) = access(s)
                && link.seq == seq
            {
                link.failed = result.is_err();
            }
        });
        if launch.is_err() {
            self.failed = true;
        }
    }
}

#[cfg(test)]
#[test]
fn external_link_reports_sync_validation_and_fences_stale_launches() {
    use rune::{Env, Runtime};
    let mut rt = Runtime::new(
        ExternalLink::default(),
        |_, _| rune::el(),
        (100.0, 100.0),
        Env::default(),
    );
    rt.frame(0.0);
    rt.update(|link, tx| link.open("javascript:alert(1)", tx, |l| Some(l)));
    assert!(rt.state.failed());
    assert!(rt.take_url_requests().is_empty());

    rt.update(|link, tx| {
        link.open(
            "https://neuralnomadsai.github.io/CodeNomad/en/settings.html",
            tx,
            |l| Some(l),
        )
    });
    assert!(!rt.state.failed());
    assert_eq!(
        rt.take_url_requests(),
        ["https://neuralnomadsai.github.io/CodeNomad/en/settings.html"]
    );
    rt.frame(0.02);
    assert!(!rt.state.failed());

    rt.update(|link, tx| {
        link.open(
            "https://neuralnomadsai.github.io/CodeNomad/en/sponsor.html",
            tx,
            |l| Some(l),
        );
        link.clear();
        link.failed = true;
    });
    rt.frame(0.02);
    assert!(
        rt.state.failed(),
        "stale launch completion after clear must not overwrite newer state"
    );
}
