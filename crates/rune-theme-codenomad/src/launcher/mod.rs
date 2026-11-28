//! Theme primitives for the CodeNomad New tab / Home launcher view.
mod icons;
pub use icons::{BRAND_LOGO, DISCORD, FOLDER, GITHUB, HEART, LAPTOP, TRASH};

use crate::{
    Length, Space, TextRole, kit,
    layout::{self, Layout, dark},
    tokens,
};
use rune::{El, Icon, ScrollSpec, Tx, col, icon, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant};
use std::rc::Rc;

/// Mirrors `@media (max-width: 639px)` in `styles/components/folder-home.css`.
pub const MOBILE_BREAKPOINT: f32 = 640.0;
const SHELL_MAX_WIDTH: f32 = 960.0;
const LOGO_SIZE: f32 = 64.0;
const PANEL_MIN_HEIGHT: f32 = 256.0;

pub fn is_stacked(viewport_width: f32) -> bool {
    viewport_width > 0.0 && viewport_width < MOBILE_BREAKPOINT
}

pub fn menu_icon(glyph: &'static Icon) -> El {
    let t = tokens(dark());
    let size = t.length(Length::Icon).px();
    icon(glyph, size).color(t.color("text-secondary"))
}

pub fn menu_viewport_width(width: f32) -> f32 {
    if width > 0.0 { width } else { 1024.0 }
}

pub fn hinted_literal_field(edit: &rune::TextEdit, hint: &str) -> rune_kit::TextInput {
    layout::literal_field(edit).placeholder(hint)
}

pub fn recent_header_right(retry: Option<El>, source_label: &str) -> El {
    let source = source_indicator(source_label);
    match retry {
        Some(retry) => row()
            .center_y()
            .separate(Space::Sm)
            .child(retry)
            .child(source),
        None => source,
    }
}

pub fn shell(stacked: bool, actions: Option<El>, hero: El, main: El, status: Option<El>) -> El {
    let t = tokens(dark());
    let pad_x = if stacked {
        t.space(Space::Md).px()
    } else {
        t.space(Space::Xl).px()
    };
    let pad_y = if stacked {
        t.space(Space::Md).px()
    } else {
        t.space(Space::Lg).px()
    };
    let inner = col()
        .key("launcher-home-shell")
        .full_width()
        .max_w(SHELL_MAX_WIDTH)
        .min_h(0.0)
        .separate(Space::Lg)
        .children(actions)
        .child(hero)
        .child(if stacked { main } else { main.remaining() })
        .children(status);
    let container = row()
        .full_width()
        .min_h(0.0)
        .justify_center()
        .px(pad_x)
        .py(pad_y)
        .child(inner);
    let scroll_body = col()
        .full_width()
        .remaining()
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(if stacked {
            container
        } else {
            container.full_height()
        });
    col()
        .key("launcher-home-root")
        .full_width()
        .full_height()
        .min_h(0.0)
        .fill(t.color("surface-shade-light"))
        .child(scroll_body)
}

pub fn top_actions(left: Option<El>, right: Option<El>) -> El {
    let mut bar = row().full_width().center_y().separate(Space::Sm);
    if let Some(left) = left {
        bar = bar.child(left);
    }
    bar = bar.child(rune::el().grow(1.0));
    if let Some(right) = right {
        bar = bar.child(right);
    }
    bar
}

pub fn top_action_button<S: 'static>(
    key: &str,
    glyph: &'static Icon,
    label: &str,
    help: String,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let action = Rc::new(press);
    let on_press = action.clone();
    let btn = Button::new(label)
        .icon(glyph)
        .disabled(disabled)
        .help(help)
        .on_press_tx(move |s, tx| on_press(s, tx))
        .build(&kit(dark()))
        .key(key.to_owned());
    if disabled {
        btn
    } else {
        btn.on_key(layout::enter_action(action))
    }
}

pub fn hero(logo_alt: &str, title: &str, links: Vec<El>) -> El {
    let t = tokens(dark());
    let logo = icon(&BRAND_LOGO, LOGO_SIZE)
        .color(t.color("text-primary"))
        .role("img")
        .label(logo_alt);
    let mut link_bar = row().center_y().separate(Space::Sm);
    for link in links {
        link_bar = link_bar.child(link);
    }
    col()
        .full_width()
        .items_center()
        .separate(Space::Sm)
        .child(logo)
        .child(
            text(title)
                .text_role(TextRole::Title)
                .color(t.color("text-primary"))
                .role("heading"),
        )
        .child(link_bar)
}

pub fn link_button<S: 'static>(
    key: &str,
    glyph: &'static Icon,
    label_text: Option<&str>,
    a11y_label: &str,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let action = Rc::new(press);
    let on_press = action.clone();
    match label_text {
        Some(caption) => Button::new(caption)
            .icon(glyph)
            .control_size(ControlSize::Small)
            .help(a11y_label)
            .on_press_tx(move |s, tx| on_press(s, tx))
            .build(&kit(dark()))
            .label(a11y_label)
            .on_key(layout::enter_action(action))
            .key(key.to_owned()),
        None => IconButton::new(glyph)
            .variant(IconButtonVariant::Neutral)
            .control_size(ControlSize::Small)
            .label(a11y_label)
            .help(a11y_label)
            .on_press_tx(move |s, tx| on_press(s, tx))
            .build(&kit(dark()))
            .on_key(layout::enter_action(action))
            .key(key.to_owned()),
    }
}

pub fn columns(stacked: bool, left: El, right: El) -> El {
    if stacked {
        col()
            .key("launcher-home-columns-stacked")
            .full_width()
            .separate(Space::Md)
            .child(left)
            .child(right)
    } else {
        row()
            .key("launcher-home-columns-desktop")
            .full_width()
            .min_h(PANEL_MIN_HEIGHT)
            .separate(Space::Md)
            .child(
                col()
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0)
                    .full_height()
                    .child(left.full_height()),
            )
            .child(
                col()
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0)
                    .full_height()
                    .child(right.full_height()),
            )
    }
}

pub fn single_column(card: El) -> El {
    col()
        .full_width()
        .items_center()
        .child(card.full_width().max_w(480.0))
}

#[allow(clippy::too_many_arguments)]
pub fn card(
    key: &str,
    aria_label: &str,
    title: &str,
    count: Option<String>,
    header_right: Option<El>,
    body: El,
    footer: Option<El>,
    stacked: bool,
) -> El {
    let t = tokens(dark());
    let pad_x = t.space(Space::Md).px();
    let pad_y = t.space(Space::Sm).px();
    let mut title_block = row().center_y().separate(Space::Sm).min_w(0.0).child(
        text(title)
            .text_role(TextRole::Label)
            .color(t.color("text-primary"))
            .role("heading")
            .truncate(),
    );
    if let Some(count) = count {
        title_block = title_block.child(
            text(count)
                .text_role(TextRole::Small)
                .color(t.color("text-muted"))
                .truncate(),
        );
    }
    let mut header = row()
        .full_width()
        .center_y()
        .justify_between()
        .px(pad_x)
        .py(pad_y)
        .separate(Space::Sm)
        .fill(t.color("surface-secondary"))
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-base"))
        .child(title_block);
    if let Some(right) = header_right {
        header = header.child(right);
    }
    let body_wrap = if stacked {
        col().full_width().min_h(0.0).child(body)
    } else {
        col()
            .full_width()
            .remaining()
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(body)
    };
    let mut panel = col()
        .key(key.to_owned())
        .full_width()
        .min_w(0.0)
        .min_h(0.0)
        .fill(t.color("surface-canvas"))
        .border(1.0, t.color("border-base"))
        .role("region")
        .label(aria_label)
        .child(header)
        .child(body_wrap);
    if let Some(footer) = footer {
        panel = panel.child(
            col()
                .full_width()
                .px(pad_x)
                .py(pad_y)
                .fill(t.color("surface-secondary"))
                .border_sides([1.0, 0.0, 0.0, 0.0], t.color("border-base"))
                .child(footer),
        );
    }
    panel
}

pub fn source_indicator(label: &str) -> El {
    let t = tokens(dark());
    let size = t.length(Length::Icon).px();
    icon(&LAPTOP, size)
        .color(t.color("text-muted"))
        .role("img")
        .label(label)
        .help(label)
}

pub fn browse_row<S: 'static>(
    key: &str,
    glyph: &'static Icon,
    label: &str,
    meta: Option<&str>,
    help: Option<String>,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let icon_size = t.length(Length::Icon).px();
    let pad_x = t.space(Space::Md).px();
    let pad_y = t.space(Space::Sm).px();
    let mut content = row()
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .min_w(0.0)
        .child(icon(glyph, icon_size).color(t.color("text-muted")))
        .child(
            text(label)
                .text_role(TextRole::Body)
                .color(if disabled {
                    t.color("text-muted")
                } else {
                    t.color("text-primary")
                })
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );
    if let Some(meta) = meta {
        content = content.child(
            text(meta)
                .text_role(TextRole::Small)
                .color(t.color("text-muted"))
                .truncate(),
        );
    }
    let mut item = content
        .px(pad_x)
        .py(pad_y)
        .role("button")
        .label(label)
        .disabled(disabled)
        .key(key.to_owned());
    if let Some(help) = help {
        item = item.help(help);
    }
    if !disabled {
        let action = Rc::new(press);
        let on_press = action.clone();
        item = item
            .hover(t.color("menu-item-hover-bg"))
            .on_press_tx(move |s, tx| on_press(s, tx))
            .on_key(layout::enter_action(action));
    }
    item
}

pub fn inline_row(field: El, action: El) -> El {
    row()
        .full_width()
        .center_y()
        .separate(Space::Xs)
        .min_w(0.0)
        .child(rune::el().grow(1.0).shrink().min_w(0.0).child(field))
        .child(action)
}

pub fn open_badge_button<S: 'static>(
    key: &str,
    badge_text: &str,
    a11y_label: &str,
    help: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let mut badge = row()
        .center_y()
        .px(t.space(Space::Sm).px())
        .py(t.space(Space::Xs).px())
        .radius(t.length(Length::ChipRadius).px())
        .fill(t.color("surface-control"))
        .border(1.0, t.color("border-base"))
        .role("button")
        .label(a11y_label)
        .help(help)
        .disabled(disabled)
        .key(key.to_owned())
        .child(
            text(badge_text.to_uppercase())
                .text_role(TextRole::Small)
                .color(if disabled {
                    t.color("text-muted")
                } else {
                    t.color("text-primary")
                }),
        );
    if !disabled {
        let action = Rc::new(press);
        let on_press = action.clone();
        badge = badge
            .hover(t.color("surface-hover"))
            .on_press_tx(move |s, tx| on_press(s, tx))
            .on_key(layout::enter_action(action));
    }
    badge
}

#[allow(clippy::too_many_arguments)]
pub fn recent_row<S: 'static>(
    primary_key: &str,
    glyph: &'static Icon,
    display_name: &str,
    display_path: &str,
    relative_time: Option<&str>,
    open_badge: Option<El>,
    menu_trigger: El,
    a11y_label: &str,
    disabled: bool,
    on_open: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let icon_size = t.length(Length::Icon).px();
    let pad_x = t.space(Space::Md).px();
    let pad_y = t.space(Space::Sm).px();

    let title_line = row()
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .min_w(0.0)
        .child(icon(glyph, icon_size).color(t.color("text-muted")))
        .child(
            text(display_name)
                .text_role(TextRole::Label)
                .color(if disabled {
                    t.color("text-muted")
                } else {
                    t.color("text-primary")
                })
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );

    let mut path_line = row()
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .min_w(0.0)
        .child(
            text(display_path)
                .text_role(TextRole::Small)
                .color(t.color("text-muted"))
                .literal_direction()
                .truncate()
                .grow(1.0)
                .min_w(0.0),
        );
    if let Some(rel) = relative_time {
        path_line = path_line.child(
            text(rel)
                .text_role(TextRole::Small)
                .color(t.color("text-muted")),
        );
    }

    let mut primary = col()
        .grow(1.0)
        .min_w(0.0)
        .separate(Space::Xs)
        .py(pad_y)
        .role("button")
        .label(a11y_label)
        .help(a11y_label)
        .disabled(disabled)
        .key(primary_key.to_owned())
        .child(title_line)
        .child(path_line);
    if !disabled {
        let action = Rc::new(on_open);
        let on_press = action.clone();
        primary = primary
            .on_press_tx(move |s, tx| on_press(s, tx))
            .on_key(layout::enter_action(action));
    }

    let mut line = row()
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .px(pad_x)
        .min_w(0.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-base"))
        .role("listitem")
        .child(primary);
    if !disabled {
        line = line.hover(t.color("menu-item-hover-bg"));
    }
    if let Some(badge) = open_badge {
        line = line.child(badge);
    }
    line.child(menu_trigger)
}

pub fn empty_state(message: &str) -> El {
    let t = tokens(dark());
    col().full_width().pad(Space::Lg).items_center().child(
        text(message)
            .text_role(TextRole::Small)
            .color(t.color("text-muted"))
            .role("status")
            .wrap(),
    )
}

pub fn section_padding(content: El) -> El {
    col()
        .full_width()
        .pad(Space::Md)
        .separate(Space::Sm)
        .child(content)
}

pub fn error_text(message: &str) -> El {
    let t = tokens(dark());
    text(message)
        .text_role(TextRole::Small)
        .color(t.color("status-error"))
        .role("alert")
        .wrap()
}

pub fn status_text(message: &str) -> El {
    let t = tokens(dark());
    text(message)
        .text_role(TextRole::Small)
        .color(t.color("text-muted"))
        .role("status")
        .wrap()
}

pub fn subtle_button<S: 'static>(
    key: &str,
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let action = Rc::new(press);
    let on_press = action.clone();
    let btn = Button::new(label)
        .variant(ButtonVariant::Ghost)
        .control_size(ControlSize::Small)
        .disabled(disabled)
        .on_press_tx(move |s, tx| on_press(s, tx))
        .build(&kit(dark()))
        .key(key.to_owned());
    if disabled {
        btn
    } else {
        btn.on_key(layout::enter_action(action))
    }
}
