//! Preferences owns its native window; its confirmed host settings also feed the shell.
#[cfg(not(target_arch = "wasm32"))]
mod opencode;
mod preferences;
mod providers;
#[cfg(not(target_arch = "wasm32"))]
mod view;
#[cfg(target_arch = "wasm32")]
mod web_providers;

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
    web_providers: web_providers::Panel,
    last_display: Option<[&'static str; 4]>,
}

pub(crate) fn poll(s: &mut State) -> bool {
    let mut shared = s.settings.shared.borrow_mut();
    if shared.main_wake.is_none() {
        shared.main_wake = Some(s.wake.clone());
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
    if (bound | shared.poll())
        && let Some(wake) = &shared.window_wake
    {
        wake();
    }
    let display = Some([
        shared.locale().unwrap_or_else(strings::locale),
        shared.mode(),
        shared.palette(false).map_or("", |p| p.id),
        shared.palette(true).map_or("", |p| p.id),
    ]);
    #[cfg(target_arch = "wasm32")]
    let changed = s.settings.web_providers.poll(&shared, &s.wake);
    #[cfg(not(target_arch = "wasm32"))]
    let changed = false;
    changed | expired | (display != std::mem::replace(&mut s.settings.last_display, display))
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

pub(crate) fn provider_connection_event(s: &State, event: &crate::transport::Event) {
    use codenomad_client::transport::{Event, WorkspaceEvent};
    match event {
        Event::Workspace(WorkspaceEvent::ProvidersChanged { workspace_id }) => {
            provider_changed(s, workspace_id)
        }
        Event::Workspace(WorkspaceEvent::Stopped { workspace_id }) => {
            provider_stopped(s, workspace_id)
        }
        Event::AgentHint(true) => provider_transport(s, true),
        Event::ConnectionLost => provider_transport(s, false),
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
    render_with(cx, &prefs, |cx| {
        let body = view(cx);
        #[cfg(target_arch = "wasm32")]
        if let Some(panel) = web_providers::view(s, &prefs) {
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

fn render_with<S>(cx: &mut Cx<S>, prefs: &Preferences, view: impl FnOnce(&mut Cx<S>) -> El) -> El {
    let dark = prefs.dark(cx.system_dark());
    let locale = prefs.locale().unwrap_or_else(strings::locale);
    use rune_theme_codenomad::layout::Layout;
    rune_theme_codenomad::settings::render(cx, dark, prefs.palette(dark), |cx| {
        strings::with_locale(locale, || view(cx).locale_direction(locale))
    })
}

pub(crate) fn entry() -> El {
    #[cfg(not(target_arch = "wasm32"))]
    return rune_theme_codenomad::layout::button(strings::t("settings.title"), false, open)
        .key("open-preferences");
    #[cfg(target_arch = "wasm32")]
    web_providers::entry()
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
