//! Preferences owns its native window; its confirmed host settings also feed the shell.
#[cfg(not(target_arch = "wasm32"))]
mod opencode;
mod preferences;
#[cfg(not(target_arch = "wasm32"))]
mod view;

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
    expired | (display != std::mem::replace(&mut s.settings.last_display, display))
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

pub(crate) fn authentication_required(s: &mut State, expired: &crate::backend::Backend) -> bool {
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

pub(crate) fn render(s: &State, cx: &mut Cx<State>, view: impl FnOnce(&mut Cx<State>) -> El) -> El {
    render_with(cx, &s.settings.shared.borrow(), view)
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
    rune::el()
}

pub(crate) fn matches_shortcut(
    s: &State,
    action: &str,
    event: &rune::KeyEvent,
    default: char,
) -> bool {
    let rune::Key::Command(key) = event.key else {
        return false;
    };
    let mods = event.mods;
    if !mods.ctrl && !mods.alt && !mods.cmd {
        return false;
    }
    let settings = s.settings.shared.borrow();
    let Some(overrides) = settings.shortcut(action) else {
        return key.eq_ignore_ascii_case(&default) && mods.ctrl && !mods.shift && !mods.alt;
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
            && rule["key"].as_str().is_some_and(|value| {
                let mut chars = value.chars();
                chars
                    .next()
                    .is_some_and(|value| key.eq_ignore_ascii_case(&value))
                    && chars.next().is_none()
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
