use crate::{State, launcher, strings::t};
use rune::{El, ScrollSpec, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{Layout, input},
};
pub fn button(key: &str, label: &str, disabled: bool) -> El {
    rune_theme_codenomad::layout::button(label, disabled).key(key.to_string())
}
pub fn view(s: &State) -> El {
    let l = s.launcher.as_ref().expect("launcher");
    let mut body = col().full_width().separate(Space::Md);
    if l.connection.is_none() {
        body = body
            .child(text(t("server")).text_role(TextRole::Title))
            .child(
                input(&l.address)
                    .literal_direction()
                    .key("server-address")
                    .label(t("server"))
                    .single_line()
                    .full_width()
                    .pad(Space::Sm)
                    .field_surface()
                    .on_edit(|s: &mut State| &mut s.launcher.as_mut().unwrap().address),
            )
            .child(text(t("password")))
            .child(
                input(&l.password)
                    .literal_direction()
                    .key("server-password")
                    .label(t("password"))
                    .single_line()
                    .secure()
                    .full_width()
                    .pad(Space::Sm)
                    .field_surface()
                    .on_edit(|s: &mut State| &mut s.launcher.as_mut().unwrap().password)
                    .on_submit(launcher::connect),
            )
            .child(button("connect", t("connect"), l.pending).on_press_tx(launcher::connect));
    } else {
        body = body
            .child(text(t("folder")).text_role(TextRole::Title))
            .child(
                input(&l.folder)
                    .literal_direction()
                    .key("folder-path")
                    .label(t("folder"))
                    .single_line()
                    .full_width()
                    .pad(Space::Sm)
                    .field_surface()
                    .on_edit(|s: &mut State| &mut s.launcher.as_mut().unwrap().folder)
                    .on_submit(launcher::open),
            )
            .child(
                rune_theme_codenomad::layout::action_row()
                    .separate(Space::Sm)
                    .child(
                        button(
                            "browse",
                            t("browse"),
                            l.pending || !crate::platform::folder_picker_available(),
                        )
                        .on_press_tx(crate::platform::browse),
                    )
                    .child(
                        button(
                            "open-folder",
                            t("open"),
                            l.pending || l.folder.text.trim().is_empty(),
                        )
                        .on_press_tx(launcher::open),
                    ),
            );
        if l.project.is_none() {
            for p in &l.projects {
                let path = p.path.clone();
                body = body.child(
                    button(&format!("project-{}", p.id), &p.path, l.pending)
                        .literal_direction()
                        .on_press_tx(move |s: &mut State, tx| {
                            launcher::choose_project(s, &path, tx);
                        }),
                );
            }
        } else {
            body = body
                .child(
                    rune_theme_codenomad::layout::action_row()
                        .separate(Space::Sm)
                        .child(text(t("sessions")).text_role(TextRole::Title))
                        .child(
                            button("refresh-sessions", t("refresh"), l.pending)
                                .on_press(|s: &mut State| launcher::list(s, false)),
                        ),
                )
                .child(
                    input(&l.search)
                        .key("session-search")
                        .label(t("search"))
                        .single_line()
                        .full_width()
                        .pad(Space::Sm)
                        .field_surface()
                        .hint(t("search"))
                        .on_edit(|s: &mut State| &mut s.launcher.as_mut().unwrap().search),
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
                            t("untitled")
                        } else {
                            &title
                        },
                        l.pending,
                    )
                    .full_width()
                    .on_press(move |s: &mut State| launcher::choose(s, id.clone(), title.clone())),
                );
            }
            if l.sessions.is_empty() {
                items = items.child(text(t("empty_sessions")));
            }
            if l.next.is_some() {
                items = items.child(
                    button(
                        "more-sessions",
                        t("more"),
                        l.pending || l.sessions.len() >= 2000,
                    )
                    .on_press(|s: &mut State| launcher::list(s, true)),
                );
            }
            body = body
                .child(col().key("session-list").full_width().child(items))
                .child(text(t("new_session")))
                .child(
                    input(&l.title)
                        .key("session-title")
                        .label(t("session_title"))
                        .single_line()
                        .full_width()
                        .pad(Space::Sm)
                        .field_surface()
                        .hint(t("session_title"))
                        .on_edit(|s: &mut State| &mut s.launcher.as_mut().unwrap().title)
                        .on_submit(launcher::create),
                )
                .child(
                    button(
                        "create-session",
                        t("create"),
                        l.pending || l.creation_uncertain || l.title.text.trim().is_empty(),
                    )
                    .on_press_tx(launcher::create),
                );
        }
    }
    if l.pending {
        body = body.child(text(t("loading")));
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
        .child(text(t("title")).text_role(TextRole::Title))
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
