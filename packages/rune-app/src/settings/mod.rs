//! Preferences owns its native window; its confirmed host settings also feed the shell.
pub(crate) mod notification_routing;
#[cfg(not(target_arch = "wasm32"))]
mod opencode;
mod preferences;
#[cfg(not(target_arch = "wasm32"))]
mod view;

use crate::{State, strings};
use preferences::Preferences;
use rune::{Cx, El};
use std::cell::Cell;
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(crate) struct Host {
    shared: Rc<RefCell<Preferences>>,
    #[cfg(not(target_arch = "wasm32"))]
    window: Option<(rune::WindowHandle, Rc<Cell<bool>>)>,
    last_display: Option<[&'static str; 4]>,
    #[cfg(target_arch = "wasm32")]
    notification_permission_changed: Rc<Cell<bool>>,
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
    #[cfg(target_arch = "wasm32")]
    let permission_changed = s.settings.notification_permission_changed.replace(false);
    #[cfg(not(target_arch = "wasm32"))]
    let permission_changed = false;
    expired
        | (display != std::mem::replace(&mut s.settings.last_display, display))
        | permission_changed
}

pub(crate) fn system_notification(
    s: &State,
    category: notification_routing::Category,
    focused: bool,
    label: &str,
) -> Option<String> {
    let prefs = s.settings.shared.borrow();
    let config = prefs.saved(codenomad_client::settings::Owner::Config);
    crate::shell::notifications::system_allowed(config, category, focused).then(|| {
        let key = match category {
            notification_routing::Category::NeedsInput => "sessionEvents.notify.needsInput",
            notification_routing::Category::SessionDone => "sessionEvents.notify.done",
        };
        strings::with_locale(prefs.locale().unwrap_or_else(strings::locale), || {
            strings::t(key).replace("{label}", label)
        })
    })
}

#[cfg(test)]
pub(crate) fn notification_fixture(s: &State) {
    s.settings.shared.borrow_mut().fixture();
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
    {
        use web_sys::NotificationPermission;
        if crate::platform::notifications::permission() != Some(NotificationPermission::Default) {
            return rune::el();
        }
        rune_theme_codenomad::layout::button(
            strings::t("settings.notifications.requestPermission.action"),
            false,
            |s: &mut State| {
                if let Some(permission) = crate::platform::notifications::request_permission() {
                    let changed = s.settings.notification_permission_changed.clone();
                    let wake = s.wake.clone();
                    wasm_bindgen_futures::spawn_local(async move {
                        let _ = wasm_bindgen_futures::JsFuture::from(permission).await;
                        changed.set(true);
                        wake();
                    });
                }
            },
        )
        .key("notification-permission")
    }
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
