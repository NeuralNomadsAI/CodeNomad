//! Preferences owns its native window; its confirmed host settings also feed the shell.
mod behavior;
mod contrast;
mod memory;
pub(crate) mod notification_routing;
mod notification_settings;
mod opencode;
mod preferences;
mod providers;
mod remote;
#[cfg(not(target_arch = "wasm32"))]
mod view;
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
mod web_contrast;

use crate::{State, strings};
use preferences::Preferences;
use rune::{Cx, El};
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
    memory_cleanup: Option<memory::cleanup::Run>,
}

pub(crate) fn poll_memory_cleanup(s: &mut State, tx: &mut rune::Tx) -> bool {
    memory::cleanup::poll(s, tx)
}

pub(crate) fn app_locale(s: &State) -> &'static str {
    s.settings
        .shared
        .borrow()
        .locale()
        .unwrap_or_else(strings::locale)
}

pub(crate) fn poll(s: &mut State) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    if let Some((request, editor)) = s.settings.window.as_ref().and_then(|(_, _, request)| {
        request
            .reopen
            .borrow_mut()
            .take()
            .map(|editor| (request.clone(), editor))
    }) {
        launch_preferences(s, request, Some(editor));
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
        if reconnected {
            crate::workspace::mission_event(s, None);
        }
        for event in &missions {
            crate::workspace::mission_event(s, Some(event));
        }
    }
    changed | expired | (display != std::mem::replace(&mut s.settings.last_display, display))
}

pub(crate) enum Delivery {
    Suppressed,
    WaitingForSettings,
    Body(String, notification_routing::Route, bool),
}

pub(crate) enum ConfirmedRoute {
    Unavailable,
    Refreshing,
    Missing,
    Ready(notification_routing::Route, bool),
}

pub(crate) fn notification_route(
    s: &State,
    source: &crate::backend::Backend,
    category: notification_routing::Category,
) -> ConfirmedRoute {
    let prefs = s.settings.shared.borrow();
    if !prefs.can_retry()
        || !prefs.backend.as_ref().is_some_and(|backend| {
            backend.base == source.base && backend.client.same_connection(&source.client)
        })
    {
        return ConfirmedRoute::Unavailable;
    }
    if prefs.notification_config_refreshing() {
        return ConfirmedRoute::Refreshing;
    }
    let config = prefs.notification_config();
    notification_routing::route(config, category).map_or(ConfirmedRoute::Missing, |route| {
        ConfirmedRoute::Ready(route, notification_routing::allow_focused(config))
    })
}

pub(crate) fn system_notification(
    s: &State,
    target: &crate::shell::notifications::Target,
    category: notification_routing::Category,
    focused: bool,
    label: &str,
) -> Delivery {
    let prefs = s.settings.shared.borrow();
    if !prefs.can_retry()
        || !prefs.backend.as_ref().is_some_and(|backend| {
            backend.base == target.backend_url
                && backend.client.server_identity() == target.server.as_deref()
        })
    {
        return Delivery::Suppressed;
    }
    if prefs.notification_config_refreshing() {
        return Delivery::WaitingForSettings;
    }
    let config = prefs.notification_config();
    if let Some(route) = notification_routing::route(config, category)
        && (route.screen
            || route.history
            || route.system && (!focused || notification_routing::allow_focused(config)))
    {
        let key = match category {
            notification_routing::Category::NeedsInput => "sessionEvents.notify.needsInput",
            notification_routing::Category::SessionDone => "sessionEvents.notify.done",
            _ => return Delivery::Suppressed,
        };
        Delivery::Body(
            strings::with_locale(prefs.locale().unwrap_or_else(strings::locale), || {
                strings::t(key).replace("{label}", label)
            }),
            route,
            notification_routing::allow_focused(config),
        )
    } else {
        Delivery::Suppressed
    }
}

#[cfg(test)]
pub(crate) fn notification_fixture(s: &State) {
    let mut prefs = s.settings.shared.borrow_mut();
    prefs.backend = Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    prefs.reset_notification_fixture();
}

#[cfg(test)]
pub(crate) fn notification_test_config(s: &State, snapshot: impl Into<Option<serde_json::Value>>) {
    s.settings
        .shared
        .borrow_mut()
        .notification_test_config(snapshot.into());
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
    if let Some((window, token, request)) = &host.window
        && Rc::strong_count(token) > 1
    {
        request.requested.set(true);
        window.focus();
        let mut prefs = host.shared.borrow_mut();
        prefs.hide_opencode();
        if let Some(wake) = &prefs.window_wake {
            wake();
        }
        return;
    }
    if host
        .window
        .as_ref()
        .is_some_and(|(_, _, request)| request.reopen.borrow().is_some())
    {
        return;
    }
    let target = providers::Target::capture(s);
    {
        let mut prefs = host.shared.borrow_mut();
        prefs.provider_target = target;
        prefs
            .memory
            .bind_seen(crate::workspace::native_window_store(s));
    }
    launch_preferences(s, Rc::new(view::CloseRequest::default()), None);
}

#[cfg(not(target_arch = "wasm32"))]
fn launch_preferences(
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
    let window = crate::platform::preferences_window(s, spec, state, view::closed);
    s.settings.window = Some((window, token, request));
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
        s.notifications.preferences_focused.set(false);
        #[cfg(target_os = "windows")]
        crate::platform::preferences_placement::closed();
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
