use crate::{State, launcher, strings::t, surfaces};
use rune::{El, ScrollSpec, Tx, col, row, text, text_input, tok::type_};
pub fn button(key: &str, label: &str, disabled: bool) -> El {
    text(label)
        .key(key.to_string())
        .role("button")
        .focusable(true)
        .disabled(disabled)
        .padding(10.0)
        .fill(surfaces::get().control)
}
pub fn view(s: &State) -> El {
    let l = s.launcher.as_ref().expect("launcher");
    let colors = surfaces::get();
    let mut body = col().w_full().gap(14.0);
    if l.connection.is_none() {
        body = body
            .child(text(t("server")).font(type_::TITLE))
            .child(
                text_input(&l.address, type_::BODY)
                    .key("server-address")
                    .label(t("server"))
                    .single_line()
                    .w_full()
                    .padding(10.0)
                    .fill(colors.field)
                    .on_edit(|s: &mut State| &mut s.launcher.as_mut().unwrap().address),
            )
            .child(text(t("password")))
            .child(
                text_input(&l.password, type_::BODY)
                    .key("server-password")
                    .label(t("password"))
                    .single_line()
                    .secure()
                    .w_full()
                    .padding(10.0)
                    .fill(colors.field)
                    .on_edit(|s: &mut State| &mut s.launcher.as_mut().unwrap().password)
                    .on_submit(launcher::connect),
            )
            .child(button("connect", t("connect"), l.pending).on_press_tx(launcher::connect));
    } else {
        body = body
            .child(text(t("folder")).font(type_::TITLE))
            .child(
                text_input(&l.folder, type_::BODY)
                    .key("folder-path")
                    .label(t("folder"))
                    .single_line()
                    .w_full()
                    .padding(10.0)
                    .fill(colors.field)
                    .on_edit(|s: &mut State| &mut s.launcher.as_mut().unwrap().folder)
                    .on_submit(launcher::open),
            )
            .child(
                row()
                    .gap(10.0)
                    .child(button("browse", t("browse"), l.pending).on_press_tx(
                        |_: &mut State, tx: &mut Tx| {
                            tx.open_folder(
                                rune::file_dialog::FileDialogOptions {
                                    title: t("folder").into(),
                                    ..Default::default()
                                },
                                |s: &mut State, result, tx| match result {
                                    Ok(Some(path)) => {
                                        s.launcher.as_mut().unwrap().folder =
                                            rune::edit::TextEdit::new(path.to_string_lossy());
                                        launcher::open(s, tx);
                                    }
                                    Ok(None) => {}
                                    Err(_) => {
                                        s.launcher.as_mut().unwrap().error = Some("open_error")
                                    }
                                },
                            );
                        },
                    ))
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
                    button(&format!("project-{}", p.id), &p.path, l.pending).on_press_tx(
                        move |s: &mut State, tx| {
                            s.launcher.as_mut().unwrap().folder = rune::edit::TextEdit::new(&path);
                            launcher::open(s, tx);
                        },
                    ),
                );
            }
        } else {
            body = body
                .child(
                    row()
                        .gap(10.0)
                        .child(text(t("sessions")).font(type_::TITLE))
                        .child(
                            button("refresh-sessions", t("refresh"), l.pending)
                                .on_press(|s: &mut State| launcher::list(s, false)),
                        ),
                )
                .child(
                    text_input(&l.search, type_::BODY)
                        .key("session-search")
                        .label(t("search"))
                        .single_line()
                        .w_full()
                        .padding(10.0)
                        .fill(colors.field)
                        .placeholder(t("search"), colors.text.alpha(0.5))
                        .on_edit(|s: &mut State| &mut s.launcher.as_mut().unwrap().search),
                );
            let filter = l.search.text.to_lowercase();
            let mut items = col().w_full().gap(6.0);
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
                    .w_full()
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
                .child(
                    col()
                        .key("session-list")
                        .w_full()
                        .h(220.0)
                        .scroll(ScrollSpec {
                            stick_bottom: false,
                        })
                        .child(items),
                )
                .child(text(t("new_session")))
                .child(
                    text_input(&l.title, type_::BODY)
                        .key("session-title")
                        .label(t("session_title"))
                        .single_line()
                        .w_full()
                        .padding(10.0)
                        .fill(colors.field)
                        .placeholder(t("session_title"), colors.text.alpha(0.5))
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
        .w_full()
        .h_full()
        .fill(colors.canvas)
        .color(colors.text)
        .padding(24.0)
        .gap(22.0)
        .child(text(t("title")).font(type_::TITLE))
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(body),
        )
}
