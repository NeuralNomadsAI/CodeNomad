use crate::{State, launcher, strings::t};
use rune::{El, ScrollSpec, col, text};
use rune_theme_codenomad::{
    Space, TextRole, kit,
    layout::{self, Layout, hinted_field, literal_field},
};
pub fn button(key: &str, label: &str, disabled: bool) -> El {
    rune_theme_codenomad::layout::button(label, disabled).key(key.to_string())
}
pub fn view(s: &State) -> El {
    let crate::Screen::Launcher(l) = &s.screen else {
        return rune::el();
    };
    let scope = s.input_scope.clone();
    let waiting = !crate::workspace::input_ready(s);
    let mut body = col().full_width().separate(Space::Md);
    if l.connection.is_none() {
        body = body
            .child(text(t("rune.server")).text_role(TextRole::Title))
            .child(
                literal_field(&l.address)
                    .label(t("rune.server"))
                    .on_edit({
                        let scope = scope.clone();
                        move |s: &mut State| s.editor(&scope, crate::screen::Editor::Address)
                    })
                    .build(kit(layout::dark()))
                    .key("server-address"),
            )
            .child(text(t("authRecovery.password")))
            .child(
                literal_field(&l.password)
                    .label(t("authRecovery.password"))
                    .secure()
                    .on_edit({
                        let scope = scope.clone();
                        move |s: &mut State| s.editor(&scope, crate::screen::Editor::Password)
                    })
                    .on_submit(crate::screen::action_tx(&scope, launcher::connect))
                    .build(kit(layout::dark()))
                    .key("server-password"),
            )
            .child(
                button(
                    "connect",
                    t("folderSelection.servers.dialog.connect"),
                    l.pending,
                )
                .on_press_tx(crate::screen::action_tx(&scope, launcher::connect)),
            );
    } else {
        body = body
            .child(text(t("instanceInfo.labels.folder")).text_role(TextRole::Title))
            .child(
                literal_field(&l.folder)
                    .disabled(waiting)
                    .label(t("instanceInfo.labels.folder"))
                    .on_edit({
                        let scope = scope.clone();
                        move |s: &mut State| s.editor(&scope, crate::screen::Editor::Folder)
                    })
                    .on_submit(crate::screen::action_tx(&scope, launcher::open))
                    .build(kit(layout::dark()))
                    .key("folder-path"),
            )
            .child(
                rune_theme_codenomad::layout::action_row()
                    .separate(Space::Sm)
                    .child(
                        button(
                            "browse",
                            t("folderSelection.browseMenu.title"),
                            l.pending || waiting || !crate::platform::folder_picker_available(),
                        )
                        .on_press_tx(crate::screen::action_tx(&scope, crate::platform::browse)),
                    )
                    .child(
                        button(
                            "open-folder",
                            t("directoryBrowser.openCurrent"),
                            l.pending || waiting || l.folder.text.trim().is_empty(),
                        )
                        .on_press_tx(crate::screen::action_tx(&scope, launcher::open)),
                    ),
            );
        if l.project.is_none() {
            for p in &l.projects {
                let path = p.path.clone();
                body = body.child(
                    button(&format!("project-{}", p.id), &p.path, l.pending || waiting)
                        .literal_direction()
                        .on_press_tx(crate::screen::action_tx(
                            &scope,
                            move |s: &mut State, tx| {
                                launcher::choose_project(s, &path, tx);
                            },
                        )),
                );
            }
        } else {
            body = body
                .child(
                    rune_theme_codenomad::layout::action_row()
                        .separate(Space::Sm)
                        .child(text(t("sessionList.header.title")).text_role(TextRole::Title))
                        .child(
                            button("refresh-sessions", t("rune.refresh"), l.pending || waiting)
                                .on_press(crate::screen::action(&scope, |s: &mut State| {
                                    launcher::list(s, false)
                                })),
                        ),
                )
                .child(
                    hinted_field(&l.search, t("rune.search"))
                        .label(t("rune.search"))
                        .on_edit({
                            let scope = scope.clone();
                            move |s: &mut State| s.editor(&scope, crate::screen::Editor::Search)
                        })
                        .build(kit(layout::dark()))
                        .key("session-search"),
                );
            let filter = l.search.text.to_lowercase();
            let mut items = col().full_width().separate(Space::Xs);
            for session in l
                .sessions
                .iter()
                .filter(|s| s.title.to_lowercase().contains(&filter))
            {
                let id = session.id.clone();
                let title = session.title.clone();
                items = items.child(
                    button(
                        &format!("session-{id}"),
                        if title.is_empty() {
                            t("sessionList.session.untitled")
                        } else {
                            &title
                        },
                        l.pending || waiting,
                    )
                    .full_width()
                    .on_press(crate::screen::action(&scope, move |s: &mut State| {
                        launcher::choose(s, id.clone(), title.clone())
                    })),
                );
            }
            if l.sessions.is_empty() {
                items = items.child(text(t("rune.empty_sessions")));
            }
            if l.next.is_some() {
                items = items.child(
                    button(
                        "more-sessions",
                        t("rune.more"),
                        l.pending || waiting || l.sessions.len() >= 2000,
                    )
                    .on_press(crate::screen::action(&scope, |s: &mut State| {
                        launcher::list(s, true)
                    })),
                );
            }
            body = body
                .child(col().key("session-list").full_width().child(items))
                .child(text(t("sessionList.actions.newSession.title")))
                .child(
                    hinted_field(&l.title, t("rune.session_title"))
                        .label(t("rune.session_title"))
                        .on_edit({
                            let scope = scope.clone();
                            move |s: &mut State| s.editor(&scope, crate::screen::Editor::Title)
                        })
                        .on_submit(crate::screen::action_tx(&scope, launcher::create))
                        .build(kit(layout::dark()))
                        .key("session-title"),
                )
                .child(
                    button(
                        "create-session",
                        t("rune.create"),
                        l.pending
                            || waiting
                            || l.creation_uncertain
                            || l.title.text.trim().is_empty(),
                    )
                    .on_press_tx(crate::screen::action_tx(&scope, launcher::create)),
                );
        }
    }
    if l.pending {
        body = body.child(text(t("rune.loading")));
    }
    if let Some(error) = l.error {
        body = body.child(text(t(error)));
    }
    col()
        .full_width()
        .full_height()
        .reading_surface()
        .pad(Space::Xl)
        .separate(Space::Xl)
        .child(text(t("window.title.main")).text_role(TextRole::Title))
        .child(
            col()
                .full_width()
                .remaining()
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(body),
        )
}
