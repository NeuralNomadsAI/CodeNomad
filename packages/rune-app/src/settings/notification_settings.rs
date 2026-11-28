use super::{
    Preferences,
    notification_routing::{Category, Destination},
};
use crate::strings::t;
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Permission {
    Unsupported,
    Ask,
    Denied,
    Granted,
}

impl Default for Permission {
    fn default() -> Self {
        Self::Unsupported
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn native_permission(_state: &crate::State) -> Permission {
    #[cfg(target_os = "windows")]
    if let Some(delivery) = &_state.notifications.native {
        return match delivery.enabled() {
            Ok(true) => Permission::Granted,
            Ok(false) => Permission::Denied,
            Err(_) => Permission::Unsupported,
        };
    }
    Permission::Unsupported
}

#[cfg(target_arch = "wasm32")]
pub(super) fn web_permission() -> Permission {
    use web_sys::NotificationPermission;
    match crate::platform::notifications::permission() {
        Some(NotificationPermission::Granted) => Permission::Granted,
        Some(NotificationPermission::Denied) => Permission::Denied,
        Some(NotificationPermission::Default) => Permission::Ask,
        _ => Permission::Unsupported,
    }
}

pub(super) fn view<S: 'static>(
    shared: &Rc<RefCell<Preferences>>,
    permission: Permission,
    info_open: Option<Destination>,
    toggle_info: fn(&mut S, Destination),
    request: fn(&mut S),
) -> El {
    let prefs = shared.borrow();
    let label = |destination: Destination| {
        t(&format!(
            "settings.notifications.routing.{}",
            destination.key()
        ))
    };
    let info_text = |destination: Destination| {
        t(&format!(
            "settings.notifications.routing.{}.info",
            destination.key()
        ))
    };
    let supported = permission != Permission::Unsupported;
    let heading = |label: &str| text(label).text_role(TextRole::Title).role("heading");
    let mut table = col()
        .role("table")
        .label(t("settings.notifications.routing.caption"))
        .full_width()
        .child(chrome::checkbox_table_header_with_info(
            t("settings.notifications.routing.category"),
            Destination::ALL.map(|destination| {
                let title = label(destination);
                (
                    title,
                    chrome::info_tip(
                        title,
                        info_text(destination),
                        info_open == Some(destination),
                        move |s| toggle_info(s, destination),
                    )
                    .key(format!("notifications-info-{}", destination.key())),
                )
            }),
        ));
    for category in Category::ALL {
        let category_label = t(&format!(
            "settings.notifications.category.{}",
            category.key()
        ));
        table = table.child(chrome::checkbox_table_row(
            category_label,
            Destination::ALL.map(|destination| {
                let shared = shared.clone();
                let system = destination == Destination::System;
                chrome::checkbox_cell(
                    format!("{category_label} · {}", label(destination)),
                    prefs.notification_route(category, destination),
                    !prefs.notification_ready() || system && !supported,
                    move |s: &mut S| {
                        let mut prefs = shared.borrow_mut();
                        if !prefs.notification_ready() {
                            return;
                        }
                        let enabled = !prefs.notification_route(category, destination);
                        prefs.set_notification_route(category, destination, enabled);
                        drop(prefs);
                        if enabled && system && permission == Permission::Ask {
                            request(s);
                        }
                    },
                )
                .key(format!("{}-{}", category.key(), destination.key()))
            }),
        ));
    }

    let title = t("settings.notifications.allowVisible.title");
    let focused = prefs.notifications_focused();
    let owner = shared.clone();
    let retry = shared.clone();
    col()
        .full_width()
        .children(prefs.notifications_error().map(|error| {
            layout::action_row()
                .child(chrome::palette::save_error(t(error)))
                .child(chrome::secondary_action(
                    t("sessionList.loadError.retry"),
                    !prefs.can_retry(),
                    move |_: &mut S| {
                        retry.borrow_mut().retry_notifications();
                    },
                ))
        }))
        .child(chrome::card(table))
        .child(chrome::card(
            col()
                .full_width()
                .separate(Space::Sm)
                .child(heading(t("settings.notifications.system.title")))
                .children((permission == Permission::Ask).then(|| {
                    layout::action_row().child(chrome::secondary_action(
                        t("settings.notifications.requestPermission.action"),
                        false,
                        request,
                    ))
                }))
                .child(chrome::setting_row(
                    title,
                    chrome::checkbox_cell(
                        title.into(),
                        focused,
                        !supported || !prefs.notification_ready(),
                        move |_: &mut S| {
                            let mut prefs = owner.borrow_mut();
                            let enabled = !prefs.notifications_focused();
                            prefs.set_notifications_focused(enabled);
                        },
                    )
                    .key("notifications-allow-focused"),
                ))
                .children(match permission {
                    Permission::Unsupported => Some(
                        text(t("settings.notifications.unsupportedNote"))
                            .text_role(TextRole::Small)
                            .role("status")
                            .wrap(),
                    ),
                    Permission::Denied => Some(chrome::palette::save_error(t(
                        "settings.notifications.messages.permissionRequestDenied",
                    ))),
                    _ => None,
                }),
        ))
}

#[cfg(test)]
#[test]
fn a_system_check_requests_permission_in_its_click_but_a_history_check_does_not() {
    struct State {
        prefs: Rc<RefCell<Preferences>>,
        prompts: usize,
        permission: Permission,
    }
    let shared = Rc::new(RefCell::new(Preferences::default()));
    {
        let mut prefs = shared.borrow_mut();
        prefs.fixture();
        prefs.backend =
            Some(crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap());
    }
    for (permission, blocked) in [
        (Permission::Unsupported, true),
        (Permission::Ask, false),
        (Permission::Denied, false),
        (Permission::Granted, false),
    ] {
        let state = State {
            prefs: shared.clone(),
            prompts: 0,
            permission,
        };
        let mut runtime = rune::Runtime::new(
            state,
            |s, _| {
                view(
                    &s.prefs,
                    s.permission,
                    None,
                    |_: &mut State, _| {},
                    |s: &mut State| s.prompts += 1,
                )
            },
            (720.0, 700.0),
            rune::Env::new(false, 1.0),
        );
        runtime.frame(0.0);
        let tree = runtime.accessibility_json().to_string();
        assert_eq!(tree.matches("\"role\":\"check-box\"").count(), 28);
        assert_eq!(tree.matches("\"role\":\"column-header\"").count(), 4);
        assert_eq!(tree.matches("\"role\":\"row-header\"").count(), 9);
        assert_eq!(tree.matches("\"role\":\"cell\"").count(), 27);
        assert_eq!(tree.contains("\"disabled\""), blocked);
        if permission != Permission::Ask {
            continue;
        }
        runtime.update(|_, tx| tx.focus("needsInput-screen", true));
        runtime.frame(0.02);
        for expected in [
            "needsInput-history",
            "needsInput-system",
            "sessionDone-screen",
        ] {
            let event = rune::KeyEvent {
                key: rune::Key::Tab,
                mods: rune::Mods::default(),
            };
            runtime.key(event.clone());
            runtime.key_up(event);
            runtime.frame(0.02);
            runtime.update(|_, tx| assert_eq!(tx.focused(), Some(expected)));
        }
        let click = |runtime: &mut rune::Runtime<State>, key| {
            let (x, y) = runtime.find(key).unwrap();
            runtime.pointer_down(x, y);
            runtime.pointer_up(x, y);
            runtime.frame(0.02);
        };
        click(&mut runtime, "copy-history");
        assert_eq!(runtime.state.prompts, 0);
        click(&mut runtime, "copy-system");
        assert_eq!(runtime.state.prompts, 1);
    }
}

#[cfg(test)]
#[test]
fn notification_settings_renders_status_and_denied_alert_in_both_themes() {
    struct Harness {
        dark: bool,
        prefs: Rc<RefCell<Preferences>>,
        permission: Permission,
    }
    for dark in [false, true] {
        let shared = Rc::new(RefCell::new(Preferences::default()));
        {
            let mut prefs = shared.borrow_mut();
            prefs.fixture();
            prefs.fixture_locale("en");
        }
        for (permission, expected_role) in [
            (Permission::Unsupported, "\"role\":\"status\""),
            (Permission::Denied, "\"role\":\"alert\""),
        ] {
            let mut rt = rune::Runtime::new(
                Harness {
                    dark,
                    prefs: shared.clone(),
                    permission,
                },
                |s, cx| {
                    rune_theme_codenomad::settings::render(cx, s.dark, None, |_| {
                        crate::strings::with_locale("en", || {
                            view(
                                &s.prefs,
                                s.permission,
                                None,
                                |_: &mut Harness, _| {},
                                |_: &mut Harness| {},
                            )
                        })
                    })
                },
                (720.0, 700.0),
                rune::Env::new(dark, 1.0),
            );
            rt.frame(0.02);
            let tree = rt.accessibility_json().to_string();
            assert!(
                tree.contains(expected_role),
                "dark={dark}: missing {expected_role} in notification settings"
            );
        }
    }
}
