use crate::{
    Length, Space, TextRole, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{El, KeyEvent, ScrollSpec, Tx, col, icon, row, text};
use std::rc::Rc;

pub const TRIGGER: &str = "command-palette-toggle";

pub fn trigger<S: 'static>(
    label: &'static str,
    help: String,
    open: bool,
    touch: bool,
    invoke: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let invoke = Rc::new(invoke);
    let press = invoke.clone();
    super::control(&super::icons::COMMAND, label, touch)
        .label(label)
        .help(help)
        .expanded(open)
        .on_press_tx(move |s, tx| press(s, tx))
        .build(&kit(layout::dark()))
        .on_key(layout::enter_action(invoke))
        .key(TRIGGER)
}

pub fn modal<S: 'static>(
    title: &str,
    search_field: El,
    close_control: El,
    list: El,
    viewport: (f32, f32),
    on_key: impl Fn(&mut S, &KeyEvent, &mut Tx) -> bool + 'static,
    close: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let inset = t.space(Space::Md).px();
    let vw = if viewport.0 > 0.0 { viewport.0 } else { 1400.0 };
    let vh = if viewport.1 > 0.0 { viewport.1 } else { 900.0 };
    let width = (vw - inset * 2.0).clamp(0.0, 600.0);
    let left = ((vw - width) / 2.0).max(inset);
    let top = (vh * 0.12).clamp(inset, 96.0);
    let toolbar = row()
        .full_width()
        .center_y()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-base"))
        .child(
            icon(&super::icons::SEARCH, t.length(Length::Icon).px())
                .color(t.color("text-muted"))
                .a11y_hidden(),
        )
        .child(search_field.remaining())
        .child(close_control);
    col()
        .key("command-palette")
        .role("dialog")
        .label(title)
        .w(width)
        .fill(t.color("surface-overlay"))
        .border(1.0, t.color("border-base"))
        .child(toolbar)
        .child(list)
        .pin(Some(left), Some(top), None, None)
        .on_key(on_key)
        .modal_tx(true, close)
        .raise()
}

pub fn list(title: &str, viewport_height: f32, rows: impl IntoIterator<Item = El>) -> El {
    let t = tokens(layout::dark());
    let inset = t.space(Space::Md).px();
    let vh = if viewport_height > 0.0 {
        viewport_height
    } else {
        900.0
    };
    let top = (vh * 0.12).clamp(inset, 96.0);
    let available = (vh - top - 88.0).max(0.0);
    let max_height = available.min((vh * 0.6).min(420.0));
    col()
        .key("command-palette-list")
        .role("listbox")
        .label(title)
        .full_width()
        .max_h(max_height)
        .pad(Space::Xs)
        .separate(Space::Xs)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .children(rows)
}

pub fn category_heading(label: &str) -> El {
    let t = tokens(layout::dark());
    row()
        .full_width()
        .px(t.space(Space::Sm).px())
        .pt(t.space(Space::Sm).px())
        .pb(t.space(Space::Xs).px())
        .child(
            text(label)
                .text_role(TextRole::Small)
                .color(t.color("text-muted"))
                .role("heading"),
        )
}

#[allow(clippy::too_many_arguments)]
pub fn command_row<S: 'static>(
    key: String,
    label: &str,
    description: Option<&str>,
    shortcut: Option<&str>,
    selected: bool,
    disabled: bool,
    on_hover: impl Fn(&mut S, bool, &mut Tx) + 'static,
    on_press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let accessible = match (description, shortcut) {
        (Some(desc), Some(binding)) if !desc.is_empty() && !binding.is_empty() => {
            format!("{label} · {desc} ({binding})")
        }
        (Some(desc), _) if !desc.is_empty() => format!("{label} · {desc}"),
        (_, Some(binding)) if !binding.is_empty() => format!("{label} ({binding})"),
        _ => label.to_owned(),
    };
    let mut details = col().grow(1.0).min_w(0.0).child(
        text(label)
            .text_role(TextRole::Label)
            .color(t.color(if disabled {
                "text-muted"
            } else {
                "text-primary"
            }))
            .truncate()
            .a11y_hidden(),
    );
    if let Some(desc) = description.filter(|desc| !desc.is_empty()) {
        details = details.child(
            text(desc)
                .text_role(TextRole::Small)
                .color(t.color("text-muted"))
                .truncate()
                .a11y_hidden(),
        );
    }
    let badge = shortcut.filter(|s| !s.is_empty()).map(|binding| {
        text(binding)
            .text_role(TextRole::Small)
            .color(t.color("text-muted"))
            .fill(t.color("surface-inset"))
            .radius(t.length(Length::ChipRadius).px())
            .px(t.space(Space::Sm).px())
            .py(t.space(Space::Xs).px() * 0.5)
            .border(1.0, t.color("border-base"))
            .border_layout()
            .a11y_hidden()
    });
    let mut item = row()
        .key(key)
        .role("option")
        .label(accessible)
        .full_width()
        .center_y()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .focus_selected(selected)
        .reveal_selected(selected)
        .fill(if selected {
            t.color("menu-item-selected-bg")
        } else {
            rune::Color::TRANSPARENT
        })
        .child(details)
        .children(badge);
    if disabled {
        item = item.opacity(0.5).disabled(true);
    } else {
        item = item
            .hover(t.color("menu-item-hover-bg"))
            .on_hover_change(on_hover)
            .on_press_tx(on_press);
    }
    item
}

pub fn empty_state(message: &str) -> El {
    let t = tokens(layout::dark());
    row().full_width().pad(Space::Md).center().child(
        text(message)
            .text_role(TextRole::Small)
            .color(t.color("text-muted"))
            .role("status"),
    )
}
