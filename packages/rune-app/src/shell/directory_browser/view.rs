use super::{
    CANCEL_BUTTON, DIALOG_KEY, GO_BUTTON, HOME_BUTTON, LIST_KEY, OPEN_BUTTON, PARENT_BUTTON,
    PATH_FIELD, RETRY_BUTTON, RowSelection, UP_ROW, blocked_by_higher_modal, close,
    confirm_current, folder_row_key, handle_key, is_open, navigate, retry, submit_path_input,
};
use crate::{
    State,
    components::button_tx,
    screen,
    strings::{locale, t, with_locale},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, field_kit, kit,
    layout::{self, Layout},
    shell::command_palette as list_theme,
};

pub(super) const PATH_AUTOFILL: rune::Autofill = rune::Autofill::Off;

pub(crate) fn append_overlay(s: &State, layer: &mut Vec<El>) {
    if !is_open(s) || blocked_by_higher_modal(s) {
        return;
    }
    let browser = &s.shell.directory_browser;
    let scope = browser
        .scope
        .clone()
        .unwrap_or_else(|| s.input_scope.clone());
    let render_locale = locale();
    let loading = browser.is_loading();
    let title = t("directoryBrowser.goTo");

    let active_descendant = browser.selected.as_ref().map(|sel| match sel {
        RowSelection::Parent => UP_ROW.to_owned(),
        RowSelection::Folder(index) => folder_row_key(*index),
    });

    let path_field = layout::hinted_field(
        &browser.path_input,
        t("directoryBrowser.currentFolder.inputPlaceholder"),
    )
    .label(t("directoryBrowser.currentFolder.inputAriaLabel"))
    .autofill(PATH_AUTOFILL)
    .active_descendant(active_descendant)
    .on_edit({
        let scope = scope.clone();
        move |s: &mut State| {
            if s.current_scope(&scope) {
                &mut s.shell.directory_browser.path_input
            } else {
                &mut s.rejected_edit
            }
        }
    })
    .on_change(screen::action_tx(&scope, |s, _| {
        s.shell.directory_browser.selected = None;
        s.shell.directory_browser.ignore_pointer_hover = true;
    }))
    .on_submit({
        let scope = scope.clone();
        move |s: &mut State, tx| {
            if s.current_scope(&scope) {
                with_locale(render_locale, || submit_path_input(s, tx));
            }
        }
    })
    .on_key({
        let scope = scope.clone();
        move |s: &mut State, event, tx| {
            s.current_scope(&scope) && with_locale(render_locale, || handle_key(s, event, tx))
        }
    })
    .build(&field_kit(layout::dark()))
    .key(PATH_FIELD)
    .literal_direction();

    let parent_target = browser.parent_path.clone();
    let home_target = browser.home_path.clone();
    let home_disabled = loading
        || home_target.is_none()
        || home_target.as_deref() == Some(browser.current_path.as_str());

    let mut nav_actions = layout::action_row().separate(Space::Sm).child(button_tx(
        PARENT_BUTTON,
        t("directoryBrowser.goToParent"),
        loading || parent_target.is_none(),
        screen::action_tx(&scope, move |s, tx| {
            if let Some(parent) = parent_target.clone() {
                navigate(s, Some(parent), tx);
            }
        }),
    ));
    if let Some(home) = home_target {
        nav_actions = nav_actions.child(button_tx(
            HOME_BUTTON,
            t("directoryBrowser.goToHome"),
            home_disabled,
            screen::action_tx(&scope, move |s, tx| {
                navigate(s, Some(home.clone()), tx);
            }),
        ));
    }
    nav_actions = nav_actions.child(button_tx(
        GO_BUTTON,
        t("directoryBrowser.goToTypedPath"),
        loading || browser.path_input.text.trim().is_empty(),
        screen::action_tx(&scope, move |s, tx| {
            with_locale(render_locale, || submit_path_input(s, tx));
        }),
    ));

    let mut rows: Vec<El> = Vec::new();
    if let Some(error) = &browser.error {
        rows.push(
            col()
                .full_width()
                .pad(Space::Sm)
                .separate(Space::Sm)
                .child(text(error.as_str()).wrap().role("alert"))
                .child(layout::action_row().child(button_tx(
                    RETRY_BUTTON,
                    t("sessionList.loadError.retry"),
                    loading,
                    screen::action_tx(&scope, move |s, tx| {
                        with_locale(render_locale, || retry(s, tx));
                    }),
                ))),
        );
    } else if loading && browser.folders.is_empty() && browser.parent_path.is_none() {
        rows.push(list_theme::empty_state(t(
            "directoryBrowser.loadingFolders",
        )));
    } else {
        if let Some(parent) = browser.parent_path.clone() {
            let hover_scope = scope.clone();
            let press_scope = scope.clone();
            let move_scope = scope.clone();
            let mut up_row = list_theme::command_row(
                UP_ROW.to_owned(),
                "..",
                Some(t("directoryBrowser.upOneLevel")),
                None,
                browser.selected == Some(RowSelection::Parent),
                loading,
                move |s: &mut State, hovered, _| {
                    if hovered
                        && s.current_scope(&hover_scope)
                        && !s.shell.directory_browser.ignore_pointer_hover
                    {
                        s.shell.directory_browser.selected = Some(RowSelection::Parent);
                    }
                },
                move |s: &mut State, tx| {
                    if s.current_scope(&press_scope) {
                        with_locale(render_locale, || navigate(s, Some(parent.clone()), tx));
                    }
                },
            );
            if !loading {
                up_row = up_row.on_pointer_move(move |s: &mut State, p| {
                    if !s.current_scope(&move_scope) {
                        return;
                    }
                    let pos = (p.x, p.y);
                    if s.shell.directory_browser.last_pointer_pos != Some(pos) {
                        s.shell.directory_browser.last_pointer_pos = Some(pos);
                        s.shell.directory_browser.ignore_pointer_hover = false;
                        s.shell.directory_browser.selected = Some(RowSelection::Parent);
                    }
                });
            }
            rows.push(up_row);
        }
        if browser.folders.is_empty() {
            rows.push(list_theme::empty_state(t("directoryBrowser.noFolders")));
        } else {
            for (index, folder) in browser.folders.iter().enumerate() {
                let path = folder.path.clone();
                let hover_scope = scope.clone();
                let press_scope = scope.clone();
                let move_scope = scope.clone();
                let mut row_el = list_theme::command_row(
                    folder_row_key(index),
                    &folder.name,
                    None,
                    None,
                    browser.selected == Some(RowSelection::Folder(index)),
                    loading,
                    move |s: &mut State, hovered, _| {
                        if hovered
                            && s.current_scope(&hover_scope)
                            && !s.shell.directory_browser.ignore_pointer_hover
                        {
                            s.shell.directory_browser.selected = Some(RowSelection::Folder(index));
                        }
                    },
                    move |s: &mut State, tx| {
                        if s.current_scope(&press_scope) {
                            with_locale(render_locale, || navigate(s, Some(path.clone()), tx));
                        }
                    },
                )
                .literal_direction();
                if !loading {
                    row_el = row_el.on_pointer_move(move |s: &mut State, p| {
                        if !s.current_scope(&move_scope) {
                            return;
                        }
                        let pos = (p.x, p.y);
                        if s.shell.directory_browser.last_pointer_pos != Some(pos) {
                            s.shell.directory_browser.last_pointer_pos = Some(pos);
                            s.shell.directory_browser.ignore_pointer_hover = false;
                            s.shell.directory_browser.selected = Some(RowSelection::Folder(index));
                        }
                    });
                }
                rows.push(row_el);
            }
        }
    }

    let list = list_theme::list(title, browser.viewport.1, rows).key(LIST_KEY);
    let can_confirm = !loading && browser.effective_target_path().is_some();
    let footer = layout::action_row()
        .separate(Space::Sm)
        .child(button_tx(
            CANCEL_BUTTON,
            t("directoryBrowser.close"),
            false,
            screen::action_tx(&scope, close),
        ))
        .child(button_tx(
            OPEN_BUTTON,
            t("directoryBrowser.openCurrent"),
            !can_confirm,
            screen::action_tx(&scope, move |s, tx| {
                with_locale(render_locale, || confirm_current(s, tx));
            }),
        ));

    let key_scope = scope.clone();
    let body = col()
        .full_width()
        .pad(Space::Md)
        .separate(Space::Sm)
        .on_key(move |s: &mut State, event, tx| {
            s.current_scope(&key_scope) && with_locale(render_locale, || handle_key(s, event, tx))
        })
        .child(path_field)
        .child(nav_actions)
        .child(list)
        .child(footer);

    let close_scope = scope.clone();
    layout::dialog(DIALOG_KEY, title, t("directoryBrowser.close"))
        .open(true)
        .fit()
        .width(560.0)
        .click_outside(true)
        .child(body)
        .on_close(move |s: &mut State| {
            if s.current_scope(&close_scope) {
                s.shell.directory_browser.dismiss_from_dialog();
                (s.wake)();
            }
        })
        .build(&kit(layout::dark()), layer);
}
