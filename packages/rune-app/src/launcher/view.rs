use crate::{
    State,
    components::{button, button_tx},
    launcher,
    strings::t,
};
use rune::{El, ScrollSpec, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout, hinted_field, literal_field},
};
#[cfg(test)]
mod tests;
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
                    .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Address))
                    .build(field_kit(layout::dark()))
                    .key("server-address"),
            )
            .child(text(t("authRecovery.password")))
            .child(
                literal_field(&l.password)
                    .label(t("authRecovery.password"))
                    .secure()
                    .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Password))
                    .on_submit(crate::screen::action_tx(&scope, launcher::connect))
                    .build(field_kit(layout::dark()))
                    .key("server-password"),
            )
            .child(button_tx(
                "connect",
                t("folderSelection.servers.dialog.connect"),
                l.pending,
                crate::screen::action_tx(&scope, launcher::connect),
            ));
    } else {
        body = body
            .child(text(t("instanceInfo.labels.folder")).text_role(TextRole::Title))
            .child(
                literal_field(&l.folder)
                    .disabled(waiting)
                    .label(t("instanceInfo.labels.folder"))
                    .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Folder))
                    .on_submit(crate::screen::action_tx(&scope, launcher::open))
                    .build(field_kit(layout::dark()))
                    .key("folder-path"),
            )
            .child(
                rune_theme_codenomad::layout::action_row()
                    .separate(Space::Sm)
                    .child(button_tx(
                        "browse",
                        t("folderSelection.browseMenu.title"),
                        l.pending || waiting || !crate::platform::folder_picker_available(),
                        crate::screen::action_tx(&scope, crate::platform::browse),
                    ))
                    .child(button_tx(
                        "open-folder",
                        t("directoryBrowser.openCurrent"),
                        l.pending || waiting || l.folder.text.trim().is_empty(),
                        crate::screen::action_tx(&scope, launcher::open),
                    )),
            );
        if l.project.is_none() {
            for p in &l.projects {
                let path = p.path.clone();
                body = body.child(
                    button_tx(
                        &format!("project-{}", p.id),
                        &p.path,
                        l.pending || waiting,
                        crate::screen::action_tx(&scope, move |s: &mut State, tx| {
                            launcher::choose_project(s, &path, tx);
                        }),
                    )
                    .literal_direction(),
                );
            }
        } else {
            body = body
                .child(
                    rune_theme_codenomad::layout::action_row()
                        .separate(Space::Sm)
                        .child(text(t("sessionList.header.title")).text_role(TextRole::Title))
                        .child(button(
                            "refresh-sessions",
                            t("rune.refresh"),
                            l.pending || waiting,
                            crate::screen::action(&scope, |s: &mut State| launcher::list(s, false)),
                        )),
                )
                .child(
                    col()
                        .role("group")
                        .label(t("sessionList.filter.ariaLabel"))
                        .full_width()
                        .child(
                            hinted_field(&l.search, t("sessionList.filter.placeholder"))
                                .label(t("sessionList.filter.ariaLabel"))
                                .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Search))
                                .build(field_kit(layout::dark()))
                                .key("session-search"),
                        ),
                );
            let searching = !l.search.text.trim().is_empty();
            let sessions = if searching {
                &l.search_results.rows
            } else {
                &l.sessions
            };
            let mut items = col().full_width().separate(Space::Xs);
            for session in sessions {
                let id = session.id.clone();
                let title = session.title.clone();
                let directory = session.directory.clone();
                items = items.child(
                    button(
                        &format!("session-{id}"),
                        if session.title.is_empty() {
                            t("sessionList.session.untitled")
                        } else {
                            &session.title
                        },
                        l.pending || waiting,
                        crate::screen::action(&scope, move |s: &mut State| {
                            launcher::choose_at(
                                s,
                                id.clone(),
                                title.clone(),
                                Some(directory.clone()),
                            )
                        }),
                    )
                    .full_width(),
                );
            }
            if sessions.is_empty()
                && (!searching || l.search_results.pending() || l.search_results.failed)
            {
                items = items.child(text(t(if searching && l.search_results.pending() {
                    "rune.loading"
                } else if searching && l.search_results.failed {
                    "rune.list_error"
                } else {
                    "rune.empty_sessions"
                })));
            }
            if !searching && l.next.is_some() {
                items = items.child(button(
                    "more-sessions",
                    t("rune.more"),
                    l.pending || waiting || l.sessions.len() >= 2000,
                    crate::screen::action(&scope, |s: &mut State| launcher::list(s, true)),
                ));
            }
            body = body
                .child(col().key("session-list").full_width().child(items))
                .child(text(t("sessionList.actions.newSession.title")))
                .child(
                    hinted_field(&l.title, t("rune.session_title"))
                        .label(t("rune.session_title"))
                        .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Title))
                        .on_submit(crate::screen::action_tx(&scope, launcher::create))
                        .build(field_kit(layout::dark()))
                        .key("session-title"),
                )
                .child(button_tx(
                    "create-session",
                    t("rune.create"),
                    l.pending || waiting || l.creation_uncertain || l.title.text.trim().is_empty(),
                    crate::screen::action_tx(&scope, launcher::create),
                ));
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
