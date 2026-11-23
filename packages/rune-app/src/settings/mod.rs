//! Preferences owns its native window; its confirmed host settings also feed the shell.
mod advanced;
mod behavior;
mod config_files;
mod contrast;
mod conversation;
mod host_support;
mod info;
mod memory;
pub(crate) mod notification_routing;
mod notification_settings;
mod opencode;
mod preferences;
mod providers;
mod remote;
mod stats;
pub(crate) mod transcript_filters;
mod transcript_preset;
pub(crate) use transcript_preset::Row as TranscriptRow;
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
    bound_backend, connected, connection_event, conversation_authentication, invalidate,
    stop_before_conversation,
};
#[cfg(test)]
use connection::{provider_changed, provider_stopped};
pub(crate) use delivery::{ConfirmedRoute, Delivery, notification_route, system_notification};
#[cfg(test)]
pub(crate) use delivery::{notification_fixture, notification_test_config};
pub(crate) use shortcuts::matches_shortcut;
#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub(crate) use window::gallery;
pub(crate) use window::{close, direct_entry, entries};
#[cfg(not(target_arch = "wasm32"))]
use window::{launch_preferences, settle_close, warn_save_failed};

use crate::{State, strings};
use preferences::Preferences;
#[cfg(not(target_arch = "wasm32"))]
use std::cell::Cell;
use std::{cell::RefCell, rc::Rc};

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
    last_display: Option<([&'static str; 5], bool)>,
    last_transcript: Option<[&'static str; transcript_preset::ROW_COUNT]>,
    transcript_filters: transcript_filters::Filters,
    memory_cleanup: Option<memory::cleanup::Run>,
}

pub(crate) fn message_usage_visibility(s: &State) -> &'static str {
    s.settings.shared.borrow().usage_visibility(false)
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
pub(crate) fn fixture_message_usage(s: &mut State, mode: &str) {
    s.settings.shared.borrow_mut().fixture_usage(mode);
    s.revision += 1;
}

pub(crate) fn poll_window_actions(s: &mut State, tx: &mut rune::Tx) -> bool {
    let changed = memory::cleanup::poll(s, tx);
    #[cfg(target_arch = "wasm32")]
    return changed
        | s.settings
            .web
            .poll_window_actions(&s.settings.shared.borrow(), tx);
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
    if let Some((request, editor)) = s.settings.window.as_ref().and_then(|(_, _, request)| {
        let editor = request.reopen.borrow_mut().take();
        (editor.is_some() || request.config_reopen.borrow().is_some())
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
    if expired {
        if let Some(launcher) = s.screen.launcher_mut() {
            launcher.authentication_required = true;
        }
        s.phase = crate::Phase::Failed;
    }
    {
        let watch = s.screen.launcher().and_then(|l| l.catalogue_watch.as_ref());
        let observation = watch.map(|watch| watch.take_provider_changes());
        let stats_changes = watch.map(|watch| {
            watch.take_stats_changes(
                shared
                    .provider_target
                    .as_ref()
                    .map(|target| target.location().0),
            )
        });
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
            if let Some(target) = &mut shared.provider_target
                && !target.validate(s, backend.as_ref(), &changes, &stopped, generation)
            {
                shared.provider_target = None;
            }
            let stats_changed = shared
                .provider_target
                .as_mut()
                .zip(stats_changes.as_ref())
                .is_some_and(|(target, (changes, status))| {
                    target.stats_catalogue(changes, *status)
                });
            if (old
                != shared
                    .provider_target
                    .as_ref()
                    .map(|target| target.revision())
                || !matches!(changes, codenomad_client::stream::CatalogueChanges::None)
                || bound
                || stats_changed)
                && let Some(wake) = &shared.window_wake
            {
                wake();
            }
        }
    }
    if crate::workspace::has_conversation_stream(s)
        || s.screen
            .launcher()
            .is_some_and(|launcher| launcher.authentication_required)
    {
        shared.unwatch();
    } else {
        shared.watch(&s.wake);
    }
    let preferences_changed = bound | shared.poll();
    if preferences_changed && let Some(wake) = &shared.window_wake {
        wake();
    }
    let display = Some((
        [
            shared.locale().unwrap_or_else(strings::locale),
            shared.mode(),
            shared.palette(false).map_or("", |p| p.id),
            shared.palette(true).map_or("", |p| p.id),
            shared.contrast(),
        ],
        awaiting_appearance(s, &shared),
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
    let (reconnected, missions) = shared.mission_changes();
    let locale = shared.locale().unwrap_or_else(strings::locale);
    let notify_failure = shared.take_notification_failure();
    let update = shared.notification_update.take();
    drop(shared);
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
        s.show_launcher();
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
    changed
        | expired
        | filters_changed
        | transcript_changed
        | (display != std::mem::replace(&mut s.settings.last_display, display))
}

#[cfg(test)]
pub(crate) fn fixture_shortcuts(s: &State, overrides: serde_json::Value) {
    s.settings.shared.borrow_mut().fixture_shortcuts(overrides);
}
