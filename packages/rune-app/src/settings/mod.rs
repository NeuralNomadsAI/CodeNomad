//! Preferences owns its native window; its confirmed host settings also feed the shell.
mod behavior;
mod contrast;
mod conversation;
pub(crate) mod transcript_filters;
pub(crate) use transcript_preset::Row as TranscriptRow;
mod memory;
pub(crate) fn show_timeline(s: &crate::State) -> bool {
    s.settings.shared.borrow().show_timeline()
}
#[cfg(not(target_arch = "wasm32"))]
mod opencode;
mod preferences;
mod providers;
mod transcript_preset;
#[cfg(not(target_arch = "wasm32"))]
mod view;
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
mod web_contrast;

use crate::{State, strings};
use preferences::Preferences;
use rune::{Cx, El};
#[cfg(not(target_arch = "wasm32"))]
use std::cell::Cell;
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(crate) struct Host {
    shared: Rc<RefCell<Preferences>>,
    #[cfg(not(target_arch = "wasm32"))]
    window: Option<(rune::WindowHandle, Rc<Cell<bool>>)>,
    #[cfg(target_arch = "wasm32")]
    web: web::Panel,
    #[cfg(target_arch = "wasm32")]
    contrast: Option<web_contrast::Watch>,
    #[cfg(target_arch = "wasm32")]
    last_contrast: bool,
    last_display: Option<([&'static str; 5], bool)>,
    last_transcript: Option<[&'static str; transcript_preset::ROW_COUNT]>,
    transcript_filters: transcript_filters::Filters,
}

pub(crate) fn poll(s: &mut State, tx: &mut rune::Tx) -> bool {
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
        let observation = s
            .screen
            .launcher()
            .and_then(|l| l.catalogue_watch.as_ref())
            .map(|watch| watch.take_provider_changes());
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
            if (old
                != shared
                    .provider_target
                    .as_ref()
                    .map(|target| target.revision())
                || !matches!(changes, codenomad_client::stream::CatalogueChanges::None)
                || bound)
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
    if transcript_changed {
        if s.settings.last_transcript.is_some() {
            s.transcript_display
                .reading_mut()
                .keep_passage(tx, |row| shared.transcript_mode(row, false) != "hidden");
        }
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
        contrast_changed
            | s.settings.web.poll(&shared, &s.wake)
            | (s.settings.web.shown() && preferences_changed)
    };
    #[cfg(not(target_arch = "wasm32"))]
    let changed = false;
    let (reconnected, missions) = shared.mission_changes();
    drop(shared);
    if expired {
        s.show_launcher();
        crate::workspace::suspend_missions(s);
    } else {
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

pub(crate) fn message_usage_visibility(s: &State) -> &'static str {
    s.settings.shared.borrow().usage_visibility(false)
}

pub(crate) fn transcript_mode(s: &State, row: TranscriptRow) -> &'static str {
    s.settings.shared.borrow().transcript_mode(row, false)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn locale(s: &State) -> &'static str {
    s.settings
        .shared
        .borrow()
        .locale()
        .unwrap_or_else(strings::locale)
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

pub(crate) fn connected(s: &mut State, backend: &crate::backend::Backend) {
    if s.screen.launcher().is_none() {
        s.settings.shared.borrow_mut().bind(Some(backend.clone()));
    }
}

pub(crate) fn bound_backend(s: &State) -> Option<crate::backend::Backend> {
    s.settings.shared.borrow().backend.clone()
}

pub(crate) fn stop_before_conversation(s: &State) -> Option<codenomad_client::Receiver<()>> {
    s.settings.shared.borrow_mut().stop_before_conversation()
}

pub(crate) fn conversation_authentication(
    s: &mut State,
    auth: codenomad_client::transport::Authentication,
) -> bool {
    if !authentication_required(s, &auth.backend) {
        return false;
    }
    s.commands = None;
    s.paging = false;
    #[cfg(not(target_arch = "wasm32"))]
    crate::chat::authentication::expired(s, auth);
    true
}

fn authentication_required(s: &mut State, expired: &crate::backend::Backend) -> bool {
    let mut prefs = s.settings.shared.borrow_mut();
    let current = match s.screen.launcher() {
        Some(launcher) => launcher.connection.as_ref(),
        None => prefs.backend.as_ref(),
    };
    if let Some(current) = current {
        if !current.client.same_connection(&expired.client) {
            return false;
        }
        prefs.require_authentication();
        if let Some(launcher) = s.screen.launcher_mut() {
            launcher.authentication_required = true;
        }
        drop(prefs);
        s.show_launcher();
        crate::workspace::suspend_missions(s);
    }
    true
}

pub(crate) fn invalidate(s: &State, owner: codenomad_client::settings::Owner) {
    s.settings.shared.borrow_mut().invalidate(owner);
}

fn provider_stopped(s: &State, workspace: &str) {
    {
        let mut prefs = s.settings.shared.borrow_mut();
        if prefs
            .provider_target
            .as_ref()
            .is_some_and(|target| target.is_workspace(workspace))
        {
            prefs.provider_target = None;
            if let Some(wake) = &prefs.window_wake {
                wake();
            }
        }
    }
}

fn provider_changed(s: &State, workspace: &str) {
    {
        if s.screen
            .launcher()
            .is_some_and(|l| l.catalogue_watch.is_some())
        {
            return;
        }
        let mut prefs = s.settings.shared.borrow_mut();
        if prefs
            .provider_target
            .as_mut()
            .is_some_and(|target| target.hint(workspace))
            && let Some(wake) = &prefs.window_wake
        {
            wake();
        }
    }
}

pub(crate) fn connection_event(s: &State, event: &crate::transport::Event) {
    use codenomad_client::transport::{Event, WorkspaceEvent};
    match event {
        Event::Workspace(WorkspaceEvent::MemoryChanged) => {
            s.settings.shared.borrow_mut().memory.invalidate();
        }
        Event::Workspace(WorkspaceEvent::ProvidersChanged { workspace_id }) => {
            provider_changed(s, workspace_id)
        }
        Event::Workspace(WorkspaceEvent::Stopped { workspace_id }) => {
            provider_stopped(s, workspace_id)
        }
        Event::AgentHint(true) => {
            s.settings.shared.borrow_mut().memory.transport(true);
            provider_transport(s, true);
        }
        Event::ConnectionLost => {
            s.settings.shared.borrow_mut().memory.transport(false);
            provider_transport(s, false);
        }
        _ => {}
    }
}

fn provider_transport(s: &State, online: bool) {
    if s.screen.launcher().is_some() {
        return;
    }
    let mut prefs = s.settings.shared.borrow_mut();
    if let Some(target) = &mut prefs.provider_target {
        target.transport(online);
        if let Some(wake) = &prefs.window_wake {
            wake();
        }
    }
}

pub(crate) fn render(s: &State, cx: &mut Cx<State>, view: impl FnOnce(&mut Cx<State>) -> El) -> El {
    let prefs = s.settings.shared.borrow();
    if awaiting_appearance(s, &prefs) {
        return rune::el().key("preferences-bootstrap");
    }
    #[cfg(target_arch = "wasm32")]
    let more = s
        .settings
        .contrast
        .as_ref()
        .is_some_and(web_contrast::Watch::more);
    #[cfg(not(target_arch = "wasm32"))]
    let more = cx.system_increased_contrast();
    render_with(cx, &prefs, more, |cx| {
        let body = view(cx);
        #[cfg(target_arch = "wasm32")]
        if let Some(panel) = web::view(s, &prefs, more) {
            use rune_theme_codenomad::layout::Layout;
            return rune::col()
                .full_width()
                .full_height()
                .child(body)
                .child(panel);
        }
        body
    })
}

fn awaiting_appearance(s: &State, prefs: &Preferences) -> bool {
    prefs.awaiting_appearance()
        || prefs.backend.is_none()
            && (s
                .screen
                .launcher()
                .is_some_and(|launcher| launcher.pending && !launcher.authentication_required)
                || s.screen.launcher().is_none()
                    && s.incoming.is_some()
                    && s.phase == crate::Phase::Loading)
}

fn render_with<S>(
    cx: &mut Cx<S>,
    prefs: &Preferences,
    system_more: bool,
    view: impl FnOnce(&mut Cx<S>) -> El,
) -> El {
    let dark = prefs.dark(cx.system_dark());
    let locale = prefs.locale().unwrap_or_else(strings::locale);
    use rune_theme_codenomad::layout::Layout;
    let more = effective_contrast(prefs.contrast(), system_more);
    let palette = prefs.palette(dark);
    let palette = if more {
        rune_theme_codenomad::palettes::increased_contrast(palette, dark)
    } else {
        palette
    };
    rune_theme_codenomad::settings::render(cx, dark, palette, |cx| {
        strings::with_locale(locale, || view(cx).locale_direction(locale))
    })
}

fn effective_contrast(preference: &str, system: bool) -> bool {
    preference == "on" || preference == "auto" && system
}

pub(crate) fn entry() -> El {
    #[cfg(not(target_arch = "wasm32"))]
    return rune_theme_codenomad::layout::button(strings::t("settings.title"), false, open)
        .key("open-preferences");
    #[cfg(target_arch = "wasm32")]
    web::entry()
}

pub(crate) fn matches_shortcut(
    s: &State,
    action: &str,
    event: &rune::KeyEvent,
    default: char,
) -> bool {
    let mods = event.mods;
    let settings = s.settings.shared.borrow();
    let Some(overrides) = settings.shortcut(action) else {
        return matches!(event.key, rune::Key::Command(key) if key.eq_ignore_ascii_case(&default))
            && mods.ctrl
            && !mods.shift
            && !mods.alt;
    };
    let function = match event.key {
        rune::Key::Function(n @ 1..=24) => Some(format!("f{n}")),
        _ => None,
    };
    overrides.iter().any(|rule| {
        let enabled = |name| rule[name].as_bool() == Some(true);
        let command = enabled("mod");
        let mac = cfg!(target_os = "macos");
        (mac || !enabled("meta"))
            && mods.ctrl == (enabled("ctrl") || command && !mac)
            && (!mac || mods.cmd == (enabled("meta") || command))
            && mods.shift == enabled("shift")
            && mods.alt == enabled("alt")
            && rule["key"].as_str().is_some_and(|value| match event.key {
                rune::Key::Command(key) => {
                    let mut chars = value.chars();
                    chars
                        .next()
                        .is_some_and(|value| key.eq_ignore_ascii_case(&value))
                        && chars.next().is_none()
                }
                _ => function
                    .as_ref()
                    .is_some_and(|key| key.eq_ignore_ascii_case(value)),
            })
    })
}

#[cfg(all(test, target_os = "windows"))]
#[test]
fn shell_shortcuts_use_confirmed_overrides_without_changing_the_default() {
    let s = crate::init();
    let chord = |key| rune::KeyEvent {
        key: rune::Key::Command(key),
        mods: rune::Mods {
            ctrl: true,
            ..Default::default()
        },
    };
    assert!(matches_shortcut(&s, "close-instance", &chord('w'), 'w'));
    s.settings
        .shared
        .borrow_mut()
        .fixture_shortcuts(serde_json::json!({
            "close-instance": [],
            "new-instance": [{"key": "t", "mod":true}]
        }));
    assert!(!matches_shortcut(&s, "close-instance", &chord('w'), 'w'));
    assert!(!matches_shortcut(&s, "new-instance", &chord('n'), 'n'));
    assert!(matches_shortcut(&s, "new-instance", &chord('t'), 'n'));
    s.settings
        .shared
        .borrow_mut()
        .fixture_shortcuts(serde_json::json!({
            "close-instance": [{"key":"f9","mod":true}],
            "new-instance": [{"key":"f10"}]
        }));
    let f = |n, ctrl| rune::KeyEvent {
        key: rune::Key::Function(n),
        mods: rune::Mods {
            ctrl,
            ..Default::default()
        },
    };
    assert!(matches_shortcut(&s, "close-instance", &f(9, true), 'w'));
    assert!(!matches_shortcut(&s, "close-instance", &f(9, false), 'w'));
    assert!(!matches_shortcut(&s, "close-instance", &chord('w'), 'w'));
    assert!(matches_shortcut(&s, "new-instance", &f(10, false), 'n'));
}

pub(crate) fn direct_entry(s: &State) -> El {
    if s.workspace.is_none() && s.settings.shared.borrow().backend.is_some() {
        entry()
    } else {
        rune::el()
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn open(s: &mut State) {
    let host = &s.settings;
    if let Some((window, token)) = &host.window
        && Rc::strong_count(token) > 1
    {
        window.close();
        return;
    }
    let token = Rc::new(Cell::new(false));
    let target = providers::Target::capture(s);
    host.shared.borrow_mut().provider_target = target;
    let state = view::Window::new(host.shared.clone(), token.clone());
    let locale = host
        .shared
        .borrow()
        .locale()
        .unwrap_or_else(strings::locale);
    let spec = strings::with_locale(locale, view::spec);
    let window = crate::platform::preferences_window(s, spec, state, view::closed);
    s.settings.window = Some((window, token));
}

#[cfg(not(target_arch = "wasm32"))]
fn settle_close(shared: &RefCell<Preferences>, warn: impl FnOnce(&'static str)) {
    let mut prefs = shared.borrow_mut();
    if !prefs.flush() {
        let locale = prefs.locale().unwrap_or_else(strings::locale);
        drop(prefs);
        warn(locale);
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn warn_save_failed(locale: &'static str) {
    crate::platform::preferences_save_warning(locale, view::save_warning);
}

pub(crate) fn close(s: &mut State) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        #[cfg(target_os = "windows")]
        crate::platform::preferences_placement::closed();
        settle_close(&s.settings.shared, warn_save_failed);
        if let Some((window, token)) = s.settings.window.take() {
            token.set(true);
            window.close();
        }
    }
    #[cfg(target_arch = "wasm32")]
    let _ = s;
}

#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub(crate) fn gallery() {
    rune::run(view::spec())
}
