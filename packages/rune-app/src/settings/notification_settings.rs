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
    request: fn(&mut S),
) -> El {
    let prefs = shared.borrow();
    let label = |destination: Destination| {
        t(&format!(
            "settings.notifications.routing.{}",
            destination.key()
        ))
    };
    let supported = permission != Permission::Unsupported;
    let heading = |label: &str| text(label).text_role(TextRole::Title).role("heading");
    let mut table = col()
        .role("table")
        .label(t("settings.notifications.routing.caption"))
        .full_width()
        .separate(Space::Sm)
        .child(chrome::checkbox_table_row(
            t("settings.notifications.routing.category"),
            true,
            Destination::ALL
                .map(|destination| text(label(destination)).wrap().role("columnheader")),
        ));
    for category in Category::ALL {
        let category_label = t(&format!(
            "settings.notifications.category.{}",
            category.key()
        ));
        table = table.child(chrome::checkbox_table_row(
            category_label,
            false,
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
    col()
        .full_width()
        .child(chrome::card(table))
        .child(chrome::card(
            col()
                .full_width()
                .separate(Space::Sm)
                .child(heading(t("settings.notifications.system.title")))
                .children((permission == Permission::Ask).then(|| {
                    layout::button(
                        t("settings.notifications.requestPermission.action"),
                        false,
                        request,
                    )
                }))
                .child(chrome::setting_row(
                    title,
                    chrome::setting_switch(
                        title,
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
                    Permission::Unsupported => {
                        Some(text(t("settings.notifications.unsupportedNote")).wrap())
                    }
                    Permission::Denied => Some(
                        text(t("settings.notifications.messages.permissionRequestDenied"))
                            .wrap()
                            .role("alert"),
                    ),
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
            |s, _| view(&s.prefs, s.permission, |s: &mut State| s.prompts += 1),
            (720.0, 700.0),
            rune::Env::new(false, 1.0),
        );
        runtime.frame(0.0);
        let tree = runtime.accessibility_json().to_string();
        assert_eq!(tree.matches("\"role\":\"check-box\"").count(), 27);
        assert_eq!(tree.contains("\"disabled\""), blocked);
        if permission != Permission::Ask {
            continue;
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
