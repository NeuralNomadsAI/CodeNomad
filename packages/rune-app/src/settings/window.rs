#[cfg(target_arch = "wasm32")]
use super::web;
#[cfg(not(target_arch = "wasm32"))]
use super::{Preferences, memory, notification_settings, providers, view};
use crate::State;
#[cfg(not(target_arch = "wasm32"))]
use crate::strings;
use rune::El;
#[cfg(not(target_arch = "wasm32"))]
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

pub(crate) fn entries(touch: bool, skip_tab: bool) -> impl IntoIterator<Item = El> {
    #[cfg(not(target_arch = "wasm32"))]
    return [rune_theme_codenomad::tabs::BarAction::Settings
        .button(touch, strings::t("settings.title"), open)
        .tab_index(if skip_tab { -1 } else { 0 })
        .key("open-preferences")];
    #[cfg(target_arch = "wasm32")]
    return [web::entry(touch, skip_tab)];
}

pub(crate) fn direct_entry(s: &State, touch: bool, skip_tab: bool) -> El {
    if s.workspace.is_none() && s.settings.shared.borrow().backend.is_some() {
        rune_theme_codenomad::layout::action_row().children(entries(touch, skip_tab))
    } else {
        rune::el()
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn open(s: &mut State) {
    s.shell.leave_project();
    open_window(s, false);
}

pub(crate) fn open_preferences(s: &mut State) {
    #[cfg(not(target_arch = "wasm32"))]
    open(s);
    #[cfg(target_arch = "wasm32")]
    web::open(s);
}

pub(crate) fn open_providers(s: &mut State) {
    #[cfg(not(target_arch = "wasm32"))]
    open_window(s, true);
    #[cfg(target_arch = "wasm32")]
    web::open_providers(s);
}

#[cfg(not(target_arch = "wasm32"))]
fn open_window(s: &mut State, providers: bool) {
    let host = &s.settings;
    if providers {
        let target = providers::Target::capture(s);
        let opener = super::missions::opener_directory(s);
        let mut prefs = host.shared.borrow_mut();
        prefs.missions.capture_opener(opener, target.as_ref());
        prefs.provider_target = target;
        prefs.open_providers = true;
    }
    if let Some((window, token, request)) = &host.window
        && Rc::strong_count(token) > 1
    {
        if providers {
            window.focus();
            if let Some(wake) = &host.shared.borrow().window_wake {
                wake();
            }
        } else {
            request.requested.set(true);
            window.focus();
            let mut prefs = host.shared.borrow_mut();
            prefs.hide_opencode();
            if let Some(wake) = &prefs.window_wake {
                wake();
            }
        }
        return;
    }
    if host.window.as_ref().is_some_and(|(_, _, request)| {
        request.reopen.borrow().is_some()
            || request.config_reopen.borrow().is_some()
            || request.palette_reopen.borrow().is_some()
    }) {
        return;
    }
    let target = providers::Target::capture(s);
    let opener = super::missions::opener_directory(s);
    {
        let mut prefs = host.shared.borrow_mut();
        prefs.missions.capture_opener(opener, target.as_ref());
        prefs.provider_target = target;
        prefs.open_providers = providers;
        prefs
            .memory
            .bind_seen(crate::workspace::native_window_store(s));
    }
    launch_preferences(s, Rc::new(view::CloseRequest::default()), None);
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn launch_preferences(
    s: &mut State,
    request: Rc<view::CloseRequest>,
    editor: Option<memory::editor::Editor>,
) {
    let host = &s.settings;
    let token = Rc::new(Cell::new(false));
    let mut state = view::Window::new(host.shared.clone(), token.clone())
        .with_close_request(request.clone(), editor)
        .with_notification_permission(notification_settings::native_permission(s));
    state.focused = s.notifications.preferences_focused.clone();
    let locale = host
        .shared
        .borrow()
        .locale()
        .unwrap_or_else(strings::locale);
    let spec = strings::with_locale(locale, view::spec);
    let window = crate::platform::preferences_window(s, spec, state, view::closed, view::focus);
    s.settings.window = Some((window, token, request));
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn settle_close(shared: &RefCell<Preferences>, warn: impl FnOnce(&'static str)) {
    let mut prefs = shared.borrow_mut();
    if !prefs.flush() {
        let locale = prefs.locale().unwrap_or_else(strings::locale);
        drop(prefs);
        warn(locale);
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn warn_save_failed(locale: &'static str) {
    crate::platform::preferences_save_warning(locale, view::save_warning);
}

pub(crate) fn close_request(
    s: &mut State,
    _tx: &mut rune::Tx,
) -> rune_theme_codenomad::shell::CloseResponse {
    #[cfg(not(target_arch = "wasm32"))]
    if let Some((window, token, request)) = &s.settings.window {
        let alive = Rc::strong_count(token) > 1;
        let has_reopen = request.reopen.borrow().is_some()
            || request.config_reopen.borrow().is_some()
            || request.palette_reopen.borrow().is_some();
        if (alive && request.guard_close.get()) || has_reopen {
            request.close_main_after.set(true);
            request.requested.set(true);
            if alive {
                window.focus();
                if let Some(wake) = &s.settings.shared.borrow().window_wake {
                    wake();
                }
            } else {
                let request = request.clone();
                let editor = request.reopen.borrow_mut().take();
                launch_preferences(s, request, editor);
            }
            return rune_theme_codenomad::shell::CloseResponse::Defer;
        }
    }
    #[cfg(target_arch = "wasm32")]
    let _ = s;
    rune_theme_codenomad::shell::CloseResponse::Close
}

pub(crate) fn close(s: &mut State) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        #[cfg(target_os = "windows")]
        crate::platform::preferences_placement::closed();
        s.notifications.preferences_focused.set(false);
        s.settings.shared.borrow_mut().hide_opencode();
        settle_close(&s.settings.shared, warn_save_failed);
        if let Some((window, token, _)) = s.settings.window.take() {
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
