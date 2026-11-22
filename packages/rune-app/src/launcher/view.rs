use crate::{State, components::button_tx, launcher, strings::t};
use rune::{El, ScrollSpec, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout, literal_field},
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
