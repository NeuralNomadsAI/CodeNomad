//! Theme primitives for the CodeNomad New tab / Home launcher view.
pub mod clone_dialog;
mod icons;
pub mod recent_menu;
pub use icons::{
    BRAND_LOGO, BRAND_LOGO_BACKING, DISCORD, FOLDER, GIT_BRANCH, GITHUB, HEART, LAPTOP, STAR, TRASH,
};

use crate::{
    Length, Space, TextRole, kit,
    layout::{self, Layout, dark},
    tokens,
};
use rune::{Color, El, Icon, ScrollSpec, TextStyle, Tx, col, icon, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize};
use std::rc::Rc;

/// Mirrors `@media (max-width: 639px)` in `styles/components/folder-home.css`.
pub const MOBILE_BREAKPOINT: f32 = 640.0;
const SHELL_MAX_WIDTH: f32 = 960.0;
const LOGO_SIZE: f32 = 64.0;
const HERO_TITLE_SIZE: f32 = 28.0;
const PANEL_MIN_HEIGHT: f32 = 256.0;
const STACKED_RECENT_MIN_HEIGHT: f32 = 160.0;
const OPEN_ELSEWHERE_DOT_SIZE: f32 = 6.0;

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

pub fn shell(
    stacked: bool,
    actions: Option<El>,
    hero: El,
    main: El,
    status: Option<El>,
    footer: Option<El>,
) -> El {
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
        .separate(Space::Md)
        .child(hero)
        .child(main.grow(1.0))
        .children(status)
        .children(footer);
    let centered = row().full_width().grow(1.0).justify_center().child(inner);
    let container = col()
        .full_width()
        .grow(1.0)
        .px(pad_x)
        .py(pad_y)
        .separate(Space::Sm)
        .children(actions)
        .child(centered);
    let scroll_body = col()
        .full_width()
        .remaining()
        .min_h(0.0)
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(container);
    col()
        .key("launcher-home-root")
        .full_width()
        .full_height()
        .min_h(0.0)
        .fill(t.color("surface-shade-light"))
        .child(scroll_body)
}

pub fn version_pill(label: &str) -> El {
    let t = tokens(dark());
    row()
        .key("launcher-version-pill")
        .full_width()
        .justify_center()
        .child(
            text(label)
                .text_role(TextRole::Small)
                .color(t.color("text-muted"))
                .truncate(),
        )
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
    help: Option<String>,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let height = t.length(Length::ControlSmall).px();
    let icon_size = t.length(Length::Icon).px();
    let mut label_style = t.text(TextRole::Small);
    label_style.weight = t.number("font-weight-medium").px();
    let ink = if disabled {
        t.color("text-muted")
    } else {
        t.color("text-secondary")
    };
    let mut btn = row()
        .h(height)
        .center()
        .px(t.space(Space::Sm).px())
        .separate(Space::Xs)
        .fill(t.color("surface-control"))
        .border(1.0, t.color("border-base"))
        .role("button")
        .label(label)
        .key(key.to_owned())
        .child(icon(glyph, icon_size).color(ink).a11y_hidden())
        .child(text(label).font(label_style).color(ink).a11y_hidden());
    if let Some(help) = help {
        btn = btn.help(help);
    }
    if disabled {
        btn.disabled(true)
    } else {
        let action = Rc::new(press);
        let on_press = action.clone();
        btn.hover(t.color("surface-hover"))
            .on_press_tx(move |s, tx| on_press(s, tx))
            .on_key(layout::enter_action(action))
    }
}

pub fn hero(logo_alt: &str, title: &str, links: Vec<El>) -> El {
    let is_dark = dark();
    let t = tokens(is_dark);
    // Match `CodeNomad-Logo-OnDark.svg` (#fff mark on #000 hex backing) and `OnLight` inverse.
    let (backing_color, mark_color) = if is_dark {
        (Color::BLACK, Color::WHITE)
    } else {
        (Color::WHITE, Color::BLACK)
    };
    let logo = rune::el()
        .key("launcher-hero-logo")
        .w(LOGO_SIZE)
        .h(LOGO_SIZE)
        .role("img")
        .label(logo_alt)
        .child(
            icon(&BRAND_LOGO_BACKING, LOGO_SIZE)
                .key("launcher-hero-logo-backing")
                .absolute(0.0, 0.0)
                .color(backing_color)
                .a11y_hidden(),
        )
        .child(
            icon(&BRAND_LOGO, LOGO_SIZE)
                .key("launcher-hero-logo-mark")
                .absolute(0.0, 0.0)
                .color(mark_color)
                .a11y_hidden(),
        );
    let title_style = TextStyle::new(HERO_TITLE_SIZE, t.number("font-weight-semibold").px())
        .lh(HERO_TITLE_SIZE * t.number("line-height-tight").px());
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
                .key("launcher-hero-title")
                .font(title_style)
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
    let t = tokens(dark());
    let height = t.length(Length::Control).px();
    let icon_size = t.length(Length::Icon).px();
    let action = Rc::new(press);
    let on_press = action.clone();
    let mut btn = row()
        .h(height)
        .min_w(height)
        .center()
        .separate(Space::Xs)
        .fill(t.color("surface-control"))
        .border(1.0, t.color("border-base"))
        .hover(t.color("surface-hover"))
        .role("button")
        .help(a11y_label)
        .on_press_tx(move |s, tx| on_press(s, tx))
        .on_key(layout::enter_action(action))
        .key(key.to_owned())
        .child(
            icon(glyph, icon_size)
                .color(t.color("text-primary"))
                .a11y_hidden(),
        );
    match label_text {
        Some(caption) => {
            btn = btn.px(t.space(Space::Sm).px()).child(
                text(caption)
                    .text_role(TextRole::Label)
                    .color(t.color("text-primary")),
            );
            if caption != a11y_label {
                btn = btn.description(a11y_label);
            }
            btn
        }
        None => btn.label(a11y_label),
    }
}

pub fn columns(stacked: bool, left: El, right: El) -> El {
    if stacked {
        col()
            .key("launcher-home-columns-stacked")
            .full_width()
            .separate(Space::Md)
            .child(left)
            .child(right.remaining().min_h(STACKED_RECENT_MIN_HEIGHT))
    } else {
        row()
            .key("launcher-home-columns-desktop")
            .full_width()
            .min_h(PANEL_MIN_HEIGHT)
            .separate(Space::Md)
            .child(col().grow(1.0).shrink().min_w(0.0).child(left.remaining()))
            .child(col().grow(1.0).shrink().min_w(0.0).child(right.remaining()))
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
    scrollable: bool,
) -> El {
    let t = tokens(dark());
    let pad_x = t.space(Space::Md).px();
    let pad_y = t.space(Space::Sm).px();
    let title_size = t.number("font-size-base").px();
    let title_style = TextStyle::new(title_size, t.number("font-weight-semibold").px())
        .lh(title_size * t.number("line-height-tight").px());
    let mut title_block = col().shrink().min_w(0.0).separate(Space::Xxs).child(
        text(title)
            .key(format!("{key}-title"))
            .font(title_style)
            .color(t.color("text-primary"))
            .role("heading")
            .truncate(),
    );
    if let Some(count) = count {
        title_block = title_block.child(
            text(count)
                .key(format!("{key}-count"))
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
    let body_wrap = if scrollable {
        col()
            .full_width()
            .remaining()
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(body)
    } else {
        col().full_width().min_h(0.0).child(body)
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
    source_prefix: Option<&str>,
    display_path: &str,
    relative_time: Option<&str>,
    open_badge: Option<El>,
    open_elsewhere: Option<&str>,
    menu_trigger: El,
    a11y_label: &str,
    disabled: bool,
    on_open: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let icon_size = t.length(Length::Icon).px();
    let pad_x = t.space(Space::Md).px();
    let pad_y = t.space(Space::Sm).px();
    let mut name_style = t.text(TextRole::Label);
    name_style.weight = t.number("font-weight-semibold").px();
    let small_size = t.number("font-size-xs").px();
    let mono_small = TextStyle::new(small_size, t.number("font-weight-regular").px())
        .lh(small_size * t.number("line-height-normal").px())
        .mono();

    let title_line = row()
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .min_w(0.0)
        .child(
            icon(glyph, icon_size)
                .color(t.color("text-muted"))
                .a11y_hidden(),
        )
        .child(
            text(display_name)
                .key(format!("{primary_key}-name"))
                .font(name_style)
                .color(if disabled {
                    t.color("text-muted")
                } else {
                    t.color("text-primary")
                })
                .truncate()
                .grow(1.0)
                .shrink()
                .min_w(0.0),
        );

    let mut meta_content = row()
        .grow(1.0)
        .shrink()
        .center_y()
        .separate(Space::Xs)
        .min_w(0.0)
        .key(format!("{primary_key}-meta"));
    if let Some(prefix) = source_prefix {
        meta_content = meta_content.child(
            text(prefix)
                .text_role(TextRole::Small)
                .color(t.color("text-muted"))
                .truncate(),
        );
    }
    meta_content = meta_content.child(
        text(display_path)
            .key(format!("{primary_key}-path"))
            .font(mono_small)
            .color(t.color("text-muted"))
            .literal_direction()
            .truncate()
            .grow(1.0)
            .shrink()
            .min_w(0.0),
    );
    if let Some(rel) = relative_time {
        meta_content = meta_content.child(
            text(rel)
                .text_role(TextRole::Small)
                .color(t.color("text-muted")),
        );
    }

    // Align line 2 under the project name in both LTR and RTL using the same icon width + gap.
    let path_line = row()
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .min_w(0.0)
        .child(rune::el().w(icon_size).h(1.0).a11y_hidden())
        .child(meta_content);

    let mut primary = col()
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .separate(Space::Xs)
        .py(pad_y)
        .role("button")
        .label(a11y_label)
        .help(open_elsewhere.unwrap_or(a11y_label))
        .disabled(disabled)
        .key(primary_key.to_owned())
        .child(title_line)
        .child(path_line);
    if let Some(elsewhere) = open_elsewhere {
        primary = primary.description(elsewhere);
    }
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
    if open_elsewhere.is_some() {
        line = line.child(
            rune::el()
                .key(format!("{primary_key}-open-elsewhere"))
                .size(OPEN_ELSEWHERE_DOT_SIZE, OPEN_ELSEWHERE_DOT_SIZE)
                .radius(OPEN_ELSEWHERE_DOT_SIZE * 0.5)
                .fill(t.color("status-ready-fg"))
                .a11y_hidden(),
        );
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
