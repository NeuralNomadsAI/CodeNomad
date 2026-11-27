use crate::{State, components::button_tx, launcher, strings::t};
use rune::{El, ScrollSpec, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout, literal_field},
};
#[cfg(test)]
mod tests;
pub fn view(s: &State) -> El {
    let Some(l) = s.screen.launcher() else {
        return rune::el();
    };
    #[cfg(target_arch = "wasm32")]
    if l.connection.is_none() && crate::platform::pairing::required(s) {
        return rune::el();
    }
    let scope = s.input_scope.clone();
    let waiting = !crate::workspace::input_ready(s);
    #[cfg(target_arch = "wasm32")]
    let password = !crate::platform::pairing::available();
    #[cfg(not(target_arch = "wasm32"))]
    let password = true;
    let mut body = col().full_width().separate(Space::Md);
    let busy = l.pending || l.managed_renewal.is_some();
    if l.connection.is_none() || l.authentication_required {
        body = body
            .child(text(t("rune.server")).text_role(TextRole::Title))
            .child(
                literal_field(&l.address)
                    .disabled(l.authentication_required)
                    .label(t("rune.server"))
                    .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Address))
                    .build(&field_kit(layout::dark()))
                    .key("server-address"),
            );
        if password {
            body = body.child(text(t("authRecovery.password"))).child(
                literal_field(&l.password)
                    .label(t("authRecovery.password"))
                    .secure()
                    .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Password))
                    .on_submit(crate::screen::action_tx(&scope, launcher::connect))
                    .build(&field_kit(layout::dark()))
                    .key("server-password"),
            );
        }
        body = body.child(button_tx(
            "connect",
            t("folderSelection.servers.dialog.connect"),
            busy,
            crate::screen::action_tx(&scope, launcher::connect),
        ));
    } else {
        let mut browse = button_tx(
            "browse",
            t("folderSelection.browseMenu.title"),
            l.pending || waiting || !crate::platform::folder_picker_available(),
            crate::screen::action_tx(&scope, crate::platform::browse),
        );
        if crate::platform::folder_picker_available() {
            browse = browse.help(crate::settings::with_shortcut_label(
                s,
                t("folderSelection.browseMenu.thisComputer"),
                "browse-folder",
            ));
        }
        let mut actions = rune_theme_codenomad::layout::action_row()
            .separate(Space::Sm)
            .child(browse)
            .child(button_tx(
                "open-folder",
                t("directoryBrowser.openCurrent"),
                l.pending || waiting || l.folder.text.trim().is_empty(),
                crate::screen::action_tx(&scope, launcher::open),
            ));
        if crate::shell::temporary::host_supports_temporary(s) {
            let temporary = button_tx(
                "new-temporary-tab",
                t("folderSelection.temporary.button"),
                !crate::shell::temporary::can_create(s),
                crate::screen::action_tx(&scope, |s, tx| {
                    crate::shell::temporary::create(s, tx);
                }),
            )
            .help(crate::settings::with_shortcut_label(
                s,
                t("folderSelection.temporary.button"),
                "new-temporary-instance",
            ));
            actions = actions.child(temporary);
        }
        body = body
            .child(text(t("instanceInfo.labels.folder")).text_role(TextRole::Title))
            .child(
                literal_field(&l.folder)
                    .disabled(waiting)
                    .label(t("instanceInfo.labels.folder"))
                    .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Folder))
                    .on_submit(crate::screen::action_tx(&scope, launcher::open))
                    .build(&field_kit(layout::dark()))
                    .key("folder-path"),
            )
            .child(actions);
        if l.projects_stale {
            body = body.child(button_tx(
                "refresh-projects",
                t("sessionList.loadError.retry"),
                l.pending || l.projects_refresh.is_some() || waiting,
                crate::screen::action_tx(&scope, |s: &mut State, _| {
                    launcher::refresh_projects(s);
                }),
            ));
        }
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
    if busy {
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
