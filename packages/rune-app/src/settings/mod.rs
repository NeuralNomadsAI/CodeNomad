//! Preferences owns its native window; its confirmed host settings also feed the shell.
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
    if s.incoming.is_none() || s.phase == crate::Phase::Failed {
        shared.watch(&s.wake);
    } else {
        shared.unwatch();
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
    display != std::mem::replace(&mut s.settings.last_display, display)
}

pub(crate) fn connected(s: &mut State, backend: &crate::backend::Backend) {
    if s.screen.launcher().is_none() {
        s.settings.shared.borrow_mut().bind(Some(backend.clone()));
    }
}

pub(crate) fn invalidate(s: &State, owner: codenomad_client::settings::Owner) {
    s.settings.shared.borrow_mut().invalidate(owner);
}

pub(crate) fn render(s: &State, cx: &mut Cx<State>, view: impl FnOnce(&mut Cx<State>) -> El) -> El {
    render_with(cx, &s.settings.shared.borrow(), view)
}

fn render_with<S>(cx: &mut Cx<S>, prefs: &Preferences, view: impl FnOnce(&mut Cx<S>) -> El) -> El {
    let dark = match prefs.mode() {
        "light" => false,
        "dark" => true,
        _ => cx.system_dark(),
    };
    let locale = prefs.locale().unwrap_or_else(strings::locale);
    use rune_theme_codenomad::layout::Layout;
    rune_theme_codenomad::settings::render(cx, dark, prefs.palette(dark), |cx| {
        strings::with_locale(locale, || view(cx).locale_direction(locale))
    })
}

pub(crate) fn entry() -> El {
    #[cfg(not(target_arch = "wasm32"))]
    return rune_theme_codenomad::layout::button(
        strings::t("settings.title"),
        false,
        |s: &mut State| open(&mut s.settings),
    )
    .key("open-preferences");
    #[cfg(target_arch = "wasm32")]
    rune::el()
}

pub(crate) fn direct_entry(s: &State) -> El {
    if s.workspace.is_none() && s.settings.shared.borrow().backend.is_some() {
        entry()
    } else {
        rune::el()
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn open(host: &mut Host) {
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
    let window = crate::platform::preferences_window(spec, state, view::closed);
    host.window = Some((window, token));
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
