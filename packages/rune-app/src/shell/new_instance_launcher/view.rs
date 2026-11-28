use super::{
    BROWSE_BUTTON, DIALOG_KEY, LIST_KEY, SEARCH_FIELD, TEMPORARY_BUTTON, blocked_by_higher_modal,
    filtered_entries, handle_key, is_open, item_key, open_browse, open_temporary,
    resolved_selection, select_entry,
};
use crate::{
    State,
    components::button_tx,
    screen,
    shell::{directory_browser, temporary},
    strings::{locale, t, with_locale},
};
use rune::{El, col};
use rune_theme_codenomad::{
    Space, field_kit, kit,
    layout::{self, Layout},
    shell::command_palette as list_theme,
};

pub(super) const QUERY_INPUT_MODE: rune::InputMode = rune::InputMode::Search;
pub(super) const QUERY_AUTOFILL: rune::Autofill = rune::Autofill::Off;

pub(crate) fn append_overlay(s: &State, layer: &mut Vec<El>) {
    if !is_open(s) || blocked_by_higher_modal(s) {
        return;
    }
    let menu = &s.shell.new_instance_launcher;
    let scope = menu.scope.clone().unwrap_or_else(|| s.input_scope.clone());
    let render_locale = locale();
    let title = t("newInstanceLauncher.recentTitle");
    let (entries, has_any) = filtered_entries(s);
    let selected = resolved_selection(&entries, menu.selected_path.as_deref());
    let active_descendant = selected.map(item_key);

    let search_field =
        layout::hinted_field(&menu.query, t("newInstanceLauncher.searchPlaceholder"))
            .label(t("newInstanceLauncher.searchLabel"))
            .input_mode(QUERY_INPUT_MODE)
            .autofill(QUERY_AUTOFILL)
            .active_descendant(active_descendant)
            .on_edit({
                let scope = scope.clone();
                move |s: &mut State| {
                    if s.current_scope(&scope) {
                        &mut s.shell.new_instance_launcher.query
                    } else {
                        &mut s.rejected_edit
                    }
                }
            })
            .on_change(screen::action_tx(&scope, |s, tx| {
                s.shell.new_instance_launcher.selected_path = None;
                s.shell.new_instance_launcher.ignore_pointer_hover = true;
                tx.scroll_to_instant(LIST_KEY, 0.0, 0.0);
            }))
            .on_key({
                let scope = scope.clone();
                move |s: &mut State, event, tx| {
                    s.current_scope(&scope)
                        && with_locale(render_locale, || handle_key(s, event, tx))
                }
            })
            .build(&field_kit(layout::dark()))
            .key(SEARCH_FIELD);

    let mut rows = Vec::new();
    if entries.is_empty() {
        let message = if has_any {
            t("newInstanceLauncher.noMatch")
        } else {
            t("newInstanceLauncher.empty")
        };
        rows.push(list_theme::empty_state(message));
    } else {
        for (index, entry) in entries.iter().enumerate() {
            let badge = entry
                .open_tab_index
                .map(|_| t("folderSelection.recent.openBadge"));
            let path = entry.path.clone();
            let hover_path = path.clone();
            let move_path = path.clone();
            let hover_scope = scope.clone();
            let press_scope = scope.clone();
            let move_scope = scope.clone();
            let row_el = list_theme::command_row(
                item_key(index),
                &entry.label,
                Some(&entry.path),
                badge,
                selected == Some(index),
                false,
                move |s: &mut State, hovered, _| {
                    if hovered
                        && s.current_scope(&hover_scope)
                        && !s.shell.new_instance_launcher.ignore_pointer_hover
                    {
                        s.shell.new_instance_launcher.selected_path = Some(hover_path.clone());
                    }
                },
                move |s: &mut State, tx| {
                    if s.current_scope(&press_scope) {
                        with_locale(render_locale, || select_entry(s, &path, tx));
                    }
                },
            )
            .on_pointer_move(move |s: &mut State, p| {
                if !s.current_scope(&move_scope) {
                    return;
                }
                let pos = (p.x, p.y);
                if s.shell.new_instance_launcher.last_pointer_pos != Some(pos) {
                    s.shell.new_instance_launcher.last_pointer_pos = Some(pos);
                    s.shell.new_instance_launcher.ignore_pointer_hover = false;
                    s.shell.new_instance_launcher.selected_path = Some(move_path.clone());
                }
            });
            rows.push(row_el);
        }
    }

    let list = list_theme::list(title, menu.viewport.1, rows).key(LIST_KEY);
    let mut actions = layout::action_row().separate(Space::Sm).child(button_tx(
        BROWSE_BUTTON,
        t("folderSelection.browseMenu.title"),
        !directory_browser::can_open(s),
        screen::action_tx(&scope, move |s, tx| {
            with_locale(render_locale, || open_browse(s, tx));
        }),
    ));
    if temporary::host_supports_temporary(s) {
        actions = actions.child(button_tx(
            TEMPORARY_BUTTON,
            t("folderSelection.temporary.button"),
            !temporary::can_create(s),
            screen::action_tx(&scope, move |s, tx| {
                with_locale(render_locale, || open_temporary(s, tx));
            }),
        ));
    }

    let key_scope = scope.clone();
    let body = col()
        .full_width()
        .pad(Space::Md)
        .separate(Space::Sm)
        .on_key(move |s: &mut State, event, tx| {
            s.current_scope(&key_scope) && with_locale(render_locale, || handle_key(s, event, tx))
        })
        .child(search_field)
        .child(list)
        .child(actions);

    let close_scope = scope.clone();
    layout::dialog(DIALOG_KEY, title, t("directoryBrowser.close"))
        .open(true)
        .fit()
        .width(480.0)
        .click_outside(true)
        .child(body)
        .on_close(move |s: &mut State| {
            if s.current_scope(&close_scope) {
                s.shell.new_instance_launcher.dismiss_from_dialog();
                (s.wake)();
            }
        })
        .build(&kit(layout::dark()), layer);
}
