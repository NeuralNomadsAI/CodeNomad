//! Session sidebar header and row primitives aligned with Solid `session-list.tsx`.
use crate::{
    Length, Space, TextRole, attachment,
    layout::{self, enter_action},
    shell::icons,
    tokens,
};
use rune::{Color, Direction, El, Icon, TextStyle, Tx, row, text};
use std::rc::Rc;

const DESKTOP_ROW_MIN_HEIGHT: f32 = 36.0;
const INLINE_ACTION_TARGET: f32 = 22.0;
const INLINE_ACTION_GLYPH: f32 = 12.0;
const COMPACT_OVERFLOW_TARGET: f32 = 28.0;
const MENU_ITEM_GLYPH: f32 = 14.0;

/// Muted uppercase small-caps section heading matching `.session-sidebar-title`.
pub fn title(label: &str) -> El {
    let t = tokens(layout::dark());
    let base = t.text(TextRole::Small);
    let font = TextStyle::new(base.size, 600.0).lh(base.line_height);
    text(label.to_uppercase())
        .font(font)
        .color(t.color("text-muted").alpha(0.6))
        .truncate()
        .min_w(0.0)
        .shrink()
        .role("heading")
        .label(label)
}

/// Icon rendered inside `action_menu::Item` entries for session row actions.
pub fn menu_icon(icon: &'static Icon) -> El {
    let t = tokens(layout::dark());
    rune::icon(icon, MENU_ITEM_GLYPH)
        .color(t.color("text-secondary"))
        .a11y_hidden()
}

/// Inline action button shown on docked desktop rows (active / hovered).
pub fn row_action<S: 'static>(
    key: &str,
    icon: &'static Icon,
    label: &str,
    disabled: bool,
    activate: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let activate = Rc::new(activate);
    let press = activate.clone();
    let mut btn = row()
        .key(key)
        .role("button")
        .focusable(true)
        .disabled(disabled)
        .label(label)
        .help(label)
        .size(INLINE_ACTION_TARGET, INLINE_ACTION_TARGET)
        .center()
        .fill(Color::TRANSPARENT)
        .hover(if disabled {
            Color::TRANSPARENT
        } else {
            t.color("surface-hover")
        })
        .opacity(if disabled { 0.3 } else { 0.65 })
        .focus_ring(
            t.metric("windowIconFocus", "outlineWidth").px(),
            -1.0,
            t.color("accent-primary"),
        )
        .child(
            rune::icon(icon, INLINE_ACTION_GLYPH)
                .color(t.color("text-primary"))
                .a11y_hidden(),
        );
    if !disabled {
        btn = btn
            .on_press_tx(move |s, tx| press(s, tx))
            .on_key(enter_action(activate));
    }
    btn
}

/// Visible `…` trigger for the session row overflow action menu on phone / touch drawers.
pub fn overflow_trigger(label: &str, touch: bool) -> El {
    let t = tokens(layout::dark());
    let side = if touch {
        t.length(Length::TouchTarget).px()
    } else {
        COMPACT_OVERFLOW_TARGET
    };
    let glyph = t.length(Length::Icon).px();
    row()
        .role("button")
        .focusable(true)
        .label(label)
        .help(label)
        .size(side, side)
        .center()
        .fill(Color::TRANSPARENT)
        .hover(t.color("surface-hover"))
        .focus_ring(
            t.metric("windowIconFocus", "outlineWidth").px(),
            -1.0,
            t.color("accent-primary"),
        )
        .child(
            rune::icon(&icons::MORE_HORIZONTAL, glyph)
                .color(t.color("text-muted"))
                .a11y_hidden(),
        )
}

#[allow(clippy::too_many_arguments)]
pub fn session_row<S: 'static>(
    row_key: &str,
    title: &str,
    selected: bool,
    reveal_actions: bool,
    disabled: bool,
    is_last: bool,
    is_subsession: bool,
    touch: bool,
    status_badge: Option<(&str, String)>,
    inline_actions: Vec<El>,
    overflow_trigger: Option<El>,
    select: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let border_w = t.metric("tabActive", "borderBottomWidth").px();
    let min_h = if touch {
        t.length(Length::TouchTarget).px()
    } else {
        DESKTOP_ROW_MIN_HEIGHT
    };
    let glyph = if is_subsession {
        &icons::BOT
    } else {
        &icons::USER
    };
    let icon_color = t.color(if is_subsession {
        "message-assistant-border"
    } else {
        "message-user-border"
    });
    let active_bg = t.color(if is_subsession {
        "session-assistant-active-bg"
    } else {
        "session-user-active-bg"
    });
    let ink = t.color(if selected {
        "text-primary"
    } else {
        "text-secondary"
    });
    let mut icon_el = rune::icon(glyph, t.length(Length::Icon).px())
        .color(icon_color)
        .a11y_hidden();
    if !selected {
        icon_el = icon_el.group_opacity(0.5, 1.0);
    }

    let select = Rc::new(select);
    let press = select.clone();
    let mut select_btn = row()
        .key(row_key)
        .role("button")
        .focusable(true)
        .focus_selected(selected)
        .disabled(disabled)
        .label(title)
        .help(title)
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .min_h(min_h - t.space(Space::Xs).px() * 2.0)
        .items_center()
        .gap(t.space(Space::Sm).px())
        .focus_ring(
            t.metric("windowIconFocus", "outlineWidth").px(),
            -1.0,
            t.color("accent-primary"),
        )
        .child(icon_el)
        .child(
            text(title)
                .font(t.text(TextRole::Small))
                .color(ink)
                .truncate()
                .min_w(0.0)
                .grow(1.0)
                .shrink()
                .dir(Direction::Auto),
        );
    let status_el = if let Some((status, badge_key)) = status_badge {
        select_btn = select_btn.description(status);
        Some(attachment::status_badge(status).key(badge_key))
    } else {
        None
    };
    if !disabled {
        select_btn = select_btn
            .on_press_tx(move |s, tx| press(s, tx))
            .on_key(enter_action(select));
    }

    let mut inner = row()
        .w_full()
        .min_w(0.0)
        .min_h(min_h)
        .px(t.space(Space::Sm).px())
        .py(t.space(Space::Xs).px())
        .gap(t.space(Space::Xs).px())
        .items_center()
        .hover_group()
        .fill(if selected {
            active_bg
        } else {
            Color::TRANSPARENT
        })
        .hover(if selected {
            active_bg
        } else {
            t.color("surface-hover-overlay")
        })
        .child(select_btn)
        .children(status_el);

    if selected {
        inner = inner
            .border(border_w, t.color("list-item-highlight-border"))
            .border_layout();
    }

    if let Some(trigger) = overflow_trigger {
        inner = inner.child(trigger);
    } else if !inline_actions.is_empty() {
        let mut actions = row()
            .items_center()
            .gap(t.space(Space::Xxs).px())
            .children(inline_actions);
        actions = actions.group_opacity(if reveal_actions { 1.0 } else { 0.0 }, 1.0);
        inner = inner.child(actions);
    }

    let mut wrapper = row().role("listitem").w_full().min_w(0.0).child(inner);
    if !is_last {
        wrapper = wrapper
            .border_sides([0.0, 0.0, border_w, 0.0], t.color("border-base"))
            .border_layout();
    }
    wrapper
}
