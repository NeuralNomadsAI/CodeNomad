use super::{
    CLOSE_KEY, FIELD, blocked_by_higher_modal, close, commands::Category, execute_by_id,
    handle_key, is_open, item_key, resolved_selection, toggle, visible_commands,
};
use crate::{
    State,
    components::window_close_button::close_button,
    screen, settings,
    strings::{locale, t, with_locale},
};
use rune::El;
use rune_theme_codenomad::{catalogue, field_kit, layout, shell::command_palette as theme};

pub(crate) fn trigger(s: &State, touch: bool) -> El {
    let label = t("instanceShell.commandPalette.openAriaLabel");
    let help = settings::with_shortcut_label(s, label, "open-command-palette");
    theme::trigger(
        label,
        help,
        is_open(s),
        touch,
        screen::action_tx(&s.input_scope, toggle),
    )
}

pub(crate) fn overlay(s: &State) -> Option<El> {
    if !is_open(s) || blocked_by_higher_modal(s) {
        return None;
    }
    let palette = &s.command_palette;
    let scope = palette
        .scope
        .clone()
        .unwrap_or_else(|| s.input_scope.clone());
    let render_locale = locale();
    let title = t("commandPalette.title");
    let items = visible_commands(s);
    let selected = resolved_selection(&items, palette.selected_id);
    let active_descendant = selected.map(|index| item_key(items[index].id));
    let search_field = layout::hinted_field(&palette.query, t("commandPalette.searchPlaceholder"))
        .label(t("commandPalette.searchPlaceholder"))
        .active_descendant(active_descendant)
        .on_edit({
            let scope = scope.clone();
            move |s: &mut State| {
                if s.current_scope(&scope) {
                    &mut s.command_palette.query
                } else {
                    &mut s.rejected_edit
                }
            }
        })
        .on_change(screen::action_tx(&scope, |s, tx| {
            s.command_palette.selected_id = None;
            tx.scroll_to_instant(theme::LIST, 0.0, 0.0);
        }))
        .on_key({
            let scope = scope.clone();
            move |s: &mut State, event, tx| {
                s.current_scope(&scope) && with_locale(render_locale, || handle_key(s, event, tx))
            }
        })
        .build(&field_kit(layout::dark()))
        .key(FIELD);
    let close_control = close_button(
        &palette.close_control,
        CLOSE_KEY,
        layout::dark(),
        None,
        |s: &mut State| &mut s.command_palette.close_control,
        screen::action_tx(&scope, close),
    );
    let mut rows = Vec::new();
    if items.is_empty() {
        let query = palette.query.text.trim();
        let message = catalogue::format(render_locale, "commandPalette.empty", &[("query", query)]);
        rows.push(theme::empty_state(&message));
    } else {
        let mut active_category: Option<Category> = None;
        for (index, item) in items.iter().enumerate() {
            if active_category != Some(item.category) {
                active_category = Some(item.category);
                rows.push(theme::category_heading(item.category.label()));
            }
            let id = item.id;
            let shortcut = item.shortcut(s);
            let hover_scope = scope.clone();
            let press_scope = scope.clone();
            rows.push(theme::command_row(
                item_key(id),
                item.label.as_ref(),
                item.description.as_deref(),
                shortcut.as_deref(),
                selected == Some(index),
                item.disabled,
                move |s: &mut State, hovered, _| {
                    if hovered && s.current_scope(&hover_scope) {
                        s.command_palette.selected_id = Some(id);
                    }
                },
                move |s: &mut State, tx| {
                    if s.current_scope(&press_scope) {
                        with_locale(render_locale, || {
                            execute_by_id(s, id, tx);
                        });
                    }
                },
            ));
        }
    }
    let list = theme::list(title, palette.viewport.1, rows);
    let key_scope = scope.clone();
    Some(theme::modal(
        title,
        search_field,
        close_control,
        list,
        palette.viewport,
        move |s: &mut State, event, tx| {
            s.current_scope(&key_scope) && with_locale(render_locale, || handle_key(s, event, tx))
        },
        screen::action_tx(&scope, close),
    ))
}
