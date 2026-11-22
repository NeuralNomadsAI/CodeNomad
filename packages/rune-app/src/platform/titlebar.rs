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
    shell::run(spec, closing, available(), locale());
}

pub fn view(cx: &mut Cx<State>) -> El {
    let rtl = rune_theme_codenomad::catalogue::direction(locale()) == "rtl";
    shell::titlebar(cx, t("window.title.main"), rtl, menus())
}

#[cfg(target_os = "windows")]
fn menus() -> El {
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
                shell::titlebar_menu(t(key), move |s: &mut State, tx| {
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
                    let items = items
                        .into_iter()
                        .map(|(id, label, enabled, checked)| (id, t(label), enabled, checked));
                    let scope = s.input_scope.clone();
                    shell::open_titlebar_menu(tx, key, items, move |s: &mut State, choice, tx| {
                        match choice {
                            Some("close") => tx.close_window(),
                            Some("fullscreen") => tx.toggle_full_screen(),
                            Some("minimize") => tx.minimize(),
                            Some("maximize") => tx.toggle_maximized(),
                            Some("new") if s.current_scope(&scope) => workspace::new_tab(s, tx),
                            Some("left" | "right") if s.current_scope(&scope) => {
                                s.shell.toggle(usize::from(choice == Some("right")), tx);
                            }
                            _ => {}
                        }
                    });
                })
                .key(key)
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
fn menus() -> El {
    row()
}
