#[cfg(target_os = "windows")]
use crate::workspace;
use crate::{
    State,
    strings::{locale, t},
};
use rune::{AppSpec, Cx, El, Tx, row};
use rune_theme_codenomad::shell;

pub fn available() -> bool {
    cfg!(target_os = "windows")
}

pub fn run(spec: AppSpec<State>, closing: fn(&mut State, &mut Tx)) {
    #[cfg(any(target_os = "windows", target_arch = "wasm32"))]
    let init = spec.init;
    let app = shell::app(
        spec,
        crate::settings::close_request,
        closing,
        available(),
        locale(),
    );
    #[cfg(target_os = "windows")]
    let app = {
        let delivery = crate::shell::notifications::native_delivery();
        let handle = app.handle();
        app.init(move || {
            let mut s = init();
            s.notifications.native = delivery;
            s
        })
        .on_ready(move |window| {
            let window = window.clone();
            handle.update(move |s, _| {
                s.notifications.window = Some(window.clone());
                crate::platform::launch::attach(s, window);
            });
        })
    };
    #[cfg(target_arch = "wasm32")]
    let app = {
        let handle = app.handle();
        app.init(move || {
            let mut s = init();
            s.notifications.background = Some(handle);
            s
        })
    };
    app.run();
}

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let locale = locale();
    let rtl = rune_theme_codenomad::catalogue::direction(locale) == "rtl";
    #[cfg(target_os = "windows")]
    if !cfg!(test) && shell::live_caption() && sync_locale(s, locale) {
        // The Win32 frame refreshes the caption geometry at the next platform paint.
        s.native_locale_repaint.set(true);
        (s.wake)();
    }
    let skip_tab = s.shell.has_floating();
    #[cfg(not(target_os = "windows"))]
    let _ = skip_tab;
    shell::titlebar(cx, t("window.title.main"), rtl, menus(locale, skip_tab))
}

pub fn poll(s: &State) -> bool {
    #[cfg(target_os = "windows")]
    return s.native_locale_repaint.replace(false);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = s;
        false
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn sync_locale(s: &State, locale: &'static str) -> bool {
    if s.native_locale.replace(Some(locale)) == Some(locale) {
        return false;
    }
    shell::native_locale(locale);
    true
}

#[cfg(target_os = "windows")]
fn menus(locale: &'static str, skip_tab: bool) -> El {
    let menu_look = rune_theme_codenomad::layout::popup_menu_look();
    row()
        .role("navigation")
        .label(t("window.menu.ariaLabel"))
        .children(
            [
                ("window.menu.file", Menu::File),
                ("window.menu.view", Menu::View),
                ("window.menu.window", Menu::Window),
            ]
            .map(|(key, menu)| {
                let menu_look = menu_look.clone();
                shell::titlebar_menu(t(key), move |s: &mut State, tx| {
                    crate::shell::Panels::dismiss_outside(s, tx);
                    let items = match menu {
                        Menu::File => vec![
                            (
                                "new",
                                "commands.newInstance.label",
                                workspace::can_new(s),
                                false,
                            ),
                            ("close", "window.menu.native.closeWindow", true, false),
                        ],
                        Menu::View => {
                            let project = s.screen.launcher().is_some_and(|l| l.project.is_some());
                            vec![
                                ("left", "window.menu.leftPanel", project, s.shell.visible(0)),
                                (
                                    "right",
                                    "window.menu.rightPanel",
                                    project,
                                    s.shell.visible(1),
                                ),
                                ("fullscreen", "window.menu.native.fullScreen", true, false),
                            ]
                        }
                        Menu::Window => vec![
                            ("minimize", "window.menu.native.minimize", true, false),
                            ("maximize", "window.menu.native.maximize", true, false),
                        ],
                    };
                    let items = items.into_iter().map(|(id, label, enabled, checked)| {
                        let label = crate::strings::with_locale(locale, || t(label));
                        (id, label, enabled, checked)
                    });
                    let scope = s.input_scope.clone();
                    shell::open_titlebar_menu(
                        tx,
                        key,
                        menu_look.clone(),
                        items,
                        move |s: &mut State, choice, tx| match choice {
                            Some("close") => {
                                if matches!(
                                    crate::settings::close_request(s, tx),
                                    shell::CloseResponse::Close
                                ) {
                                    tx.close_window();
                                }
                            }
                            Some("fullscreen") => tx.toggle_full_screen(),
                            Some("minimize") => tx.minimize(),
                            Some("maximize") => tx.toggle_maximized(),
                            Some("new") if s.current_scope(&scope) => workspace::new_tab(s, tx),
                            Some("left" | "right") if s.current_scope(&scope) => {
                                crate::shell::toggle_panel(
                                    s,
                                    usize::from(choice == Some("right")),
                                    tx,
                                );
                            }
                            _ => {}
                        },
                    );
                })
                .key(key)
                .tab_index(if skip_tab { -1 } else { 0 })
            }),
        )
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
enum Menu {
    File,
    View,
    Window,
}

#[cfg(not(target_os = "windows"))]
fn menus(_: &'static str, _: bool) -> El {
    row()
}
