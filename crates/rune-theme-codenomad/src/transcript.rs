//! Transcript visual chrome primitives aligned with the shared CodeNomad theme.
use crate::{
    Space, TextRole,
    file_row_actions::icons as file_icons,
    git_panel, kit,
    layout::{self, Layout, dark},
    shell::icons as shell_icons,
    timeline::icons as timeline_icons,
    tokens,
};
use rune::{El, Icon, TextStyle, Tx, col, icon, row, text};
use rune_kit::{ControlSize, IconButton, IconButtonVariant, State};
use std::rc::Rc;

const CHEVRON_SIZE: f32 = 12.0;
const STATUS_ICON_SIZE: f32 = 12.0;
const SPEAKER_ICON_SIZE: f32 = 14.0;
const SCROLL_BUTTON_SIZE: f32 = 28.0;
const SCROLL_BUTTON_RADIUS: f32 = 14.0;
const SCROLL_ICON_SIZE: f32 = 14.0;
const HEADER_BAR_MIN_HEIGHT: f32 = 26.0;

// Lucide glyphs matching Solid's tool-call.tsx and message-section.tsx.
static CHECK: Icon = Icon {
    name: "lucide-check",
    view: 24.0,
    body: r#"<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static X_CIRCLE: Icon = Icon {
    name: "lucide-circle-x",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></g>"#,
};
static LOADER: Icon = Icon {
    name: "lucide-loader-circle",
    view: 24.0,
    body: r#"<path d="M21 12a9 9 0 1 1-6.219-8.56" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>"#,
};
static ARROW_RIGHT_SQUARE: Icon = Icon {
    name: "lucide-square-arrow-right",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 12h8"/><path d="m12 16 4-4-4-4"/></g>"#,
};
static ARROW_DOWN: Icon = Icon {
    name: "lucide-arrow-down",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></g>"#,
};
static LAYERS: Icon = Icon {
    name: "lucide-layers",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></g>"#,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Completed,
    Running,
    Error,
    Pending,
    Unknown,
}

fn focus_outline() -> (f32, f32) {
    let t = tokens(dark());
    (
        t.metric("windowIconFocus", "outlineWidth").px(),
        t.metric("windowIconFocus", "outlineOffset").px(),
    )
}

fn header_mono() -> TextStyle {
    let t = tokens(dark());
    let size = t.number("font-size-xs").px().max(13.0);
    let weight = t.number("font-weight-regular").px();
    let lh = (size * t.number("line-height-tight").px()).ceil();
    TextStyle::new(size, weight).lh(lh).mono()
}

fn header_label_font() -> TextStyle {
    let t = tokens(dark());
    let size = t.number("font-size-xs").px();
    let weight = t.number("font-weight-semibold").px();
    let lh = (size * t.number("line-height-tight").px()).ceil();
    TextStyle::new(size, weight).lh(lh)
}

fn chevron(expanded: bool) -> El {
    let t = tokens(dark());
    let (glyph, directional) = if expanded {
        (&git_panel::CHEVRON_DOWN, false)
    } else {
        (&git_panel::CHEVRON_RIGHT, true)
    };
    let mut arrow = icon(glyph, CHEVRON_SIZE)
        .color(t.color("text-secondary"))
        .a11y_hidden();
    if directional {
        arrow = arrow.mirror_in_rtl();
    }
    arrow
}

pub fn icon_action<S: 'static>(
    glyph: &'static Icon,
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let action = Rc::new(press);
    let on_press = action.clone();
    let button = IconButton::new(glyph)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .label(label)
        .help(label)
        .disabled(disabled)
        .state(if disabled {
            State::Disabled
        } else {
            State::Rest
        })
        .on_press_tx(move |s, tx| on_press(s, tx))
        .build(&kit(dark()));
    if disabled {
        button
    } else {
        button.on_key(layout::enter_action(action))
    }
}

pub fn icon_toggle<S: 'static>(
    glyph: &'static Icon,
    label: &str,
    active: bool,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let dark = dark();
    let k = &*kit(dark);
    let mut selected;
    let k = if active && !disabled {
        selected = k.clone();
        let tint = tokens(dark).color("icon-toggle-active-bg");
        selected.c.hover = tint;
        selected.c.pressed = tint;
        selected.c.icon_muted = tokens(dark).color("text-primary");
        &selected
    } else {
        k
    };
    let action = Rc::new(press);
    let on_press = action.clone();
    let button = IconButton::new(glyph)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .label(label)
        .help(label)
        .disabled(disabled)
        .state(if disabled {
            State::Disabled
        } else if active {
            State::Pressed
        } else {
            State::Rest
        })
        .on_press_tx(move |s, tx| on_press(s, tx))
        .build(k)
        .checked(active);
    if disabled {
        button
    } else {
        button.on_key(layout::enter_action(action))
    }
}

pub fn wrap_button<S: 'static>(
    label: &str,
    active: bool,
    disabled: bool,
    press: impl Fn(&mut S) + 'static,
) -> El {
    icon_toggle(
        &git_panel::WRAP_TEXT,
        label,
        active,
        disabled,
        move |s, _| {
            press(s);
        },
    )
}

pub fn diff_mode_button<S: 'static>(
    label: &str,
    split: bool,
    press: impl Fn(&mut S) + 'static,
) -> El {
    let glyph = if split {
        &git_panel::ROWS
    } else {
        &git_panel::COLUMNS
    };
    icon_toggle(glyph, label, split, false, move |s, _| press(s))
}

pub fn arguments_button<S: 'static>(
    label: &str,
    active: Option<bool>,
    press: impl Fn(&mut S) + 'static,
) -> El {
    match active {
        Some(open) => icon_toggle(&ARROW_RIGHT_SQUARE, label, open, false, move |s, _| {
            press(s);
        }),
        None => icon_action(&ARROW_RIGHT_SQUARE, label, false, move |s, _| press(s)),
    }
}

pub fn goto_session_button<S: 'static>(
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    icon_action(&file_icons::EXTERNAL_LINK, label, disabled, press)
}

pub fn background_button<S: 'static>(label: &str, press: impl Fn(&mut S) + 'static) -> El {
    icon_action(&LAYERS, label, false, move |s, _| press(s))
}

pub fn tool_status(status: ToolStatus, label: &str) -> El {
    let t = tokens(dark());
    let (glyph, color) = match status {
        ToolStatus::Completed => (Some(&CHECK), t.color("status-success")),
        ToolStatus::Running => (Some(&LOADER), t.color("status-warning")),
        ToolStatus::Error => (Some(&X_CIRCLE), t.color("status-error")),
        ToolStatus::Pending => (Some(&shell_icons::HOURGLASS), t.color("text-secondary")),
        ToolStatus::Unknown => (None, t.color("text-secondary")),
    };
    let mut style = t.text(TextRole::Small);
    style.weight = t.number("font-weight-medium").px();
    row()
        .items_center()
        .gap(t.space(Space::Xs).px())
        .role("status")
        .children(glyph.map(|g| icon(g, STATUS_ICON_SIZE).color(color).a11y_hidden()))
        .child(text(label).font(style).color(color))
}

pub fn tool_header<S: 'static>(
    toggle_key: String,
    title: &str,
    expanded: bool,
    status: El,
    actions: Vec<El>,
    press: impl Fn(&mut S) + 'static,
) -> El {
    let t = tokens(dark());
    let (outline, _) = focus_outline();
    let action = Rc::new(move |s: &mut S, _: &mut Tx| press(s));
    let on_press = action.clone();
    let toggle = row()
        .key(toggle_key)
        .grow(1.0)
        .min_w(0.0)
        .min_h(HEADER_BAR_MIN_HEIGHT)
        .items_center()
        .gap(t.space(Space::Xs).px())
        .px(t.space(Space::Sm).px())
        .py(t.space(Space::Xs).px())
        .role("button")
        .expanded(expanded)
        .focusable(true)
        .hover(t.color("message-part-hover"))
        .focus_ring(outline, -outline, t.color("focus-ring-color"))
        .on_press_tx(move |s, tx| on_press(s, tx))
        .on_key(layout::enter_action(action))
        .child(chevron(expanded))
        .child(
            text(title)
                .font(header_mono())
                .color(t.color("text-primary"))
                .truncate()
                .grow(1.0)
                .shrink()
                .min_w(0.0),
        )
        .child(status);
    row()
        .w_full()
        .items_center()
        .gap(t.space(Space::Xxs).px())
        .pr(t.space(Space::Xs).px())
        .hover(t.color("message-part-hover"))
        .child(toggle)
        .children(actions)
}

pub fn tool_card(header: El, body: Option<El>, diagnostics: Option<El>) -> El {
    let t = tokens(dark());
    let card = col()
        .w_full()
        .fill(t.color("message-assistant-bg"))
        .border(1.0, t.color("border-muted"))
        .border_layout()
        .child(header);
    let card = if let Some(body) = body {
        card.child(
            col()
                .w_full()
                .px(t.space(Space::Sm).px())
                .pb(t.space(Space::Sm).px())
                .child(
                    col()
                        .w_full()
                        .fill(t.color("surface-inset"))
                        .border(1.0, t.color("border-base"))
                        .border_layout()
                        .pad(Space::Sm)
                        .separate(Space::Sm)
                        .child(body),
                ),
        )
    } else {
        card
    };
    card.children(diagnostics)
}

pub fn io_section_header<S: 'static>(
    toggle_key: String,
    title: &str,
    expanded: bool,
    action_el: Option<El>,
    press: impl Fn(&mut S) + 'static,
) -> El {
    let t = tokens(dark());
    let (outline, _) = focus_outline();
    let action = Rc::new(move |s: &mut S, _: &mut Tx| press(s));
    let on_press = action.clone();
    let toggle = row()
        .key(toggle_key)
        .grow(1.0)
        .min_w(0.0)
        .min_h(HEADER_BAR_MIN_HEIGHT)
        .items_center()
        .gap(t.space(Space::Xs).px())
        .px(t.space(Space::Sm).px())
        .role("button")
        .expanded(expanded)
        .focusable(true)
        .hover(t.color("message-part-hover"))
        .focus_ring(outline, -outline, t.color("focus-ring-color"))
        .on_press_tx(move |s, tx| on_press(s, tx))
        .on_key(layout::enter_action(action))
        .child(chevron(expanded))
        .child(
            text(title)
                .font(header_label_font())
                .color(t.color("text-secondary"))
                .truncate()
                .grow(1.0)
                .shrink()
                .min_w(0.0),
        );
    row()
        .w_full()
        .items_center()
        .fill(t.color("surface-secondary"))
        .border(1.0, t.color("border-base"))
        .border_layout()
        .pr(t.space(Space::Xs).px())
        .child(toggle)
        .children(action_el)
}

pub fn io_section_label(title: &str, error: bool, action_el: Option<El>) -> El {
    let t = tokens(dark());
    row()
        .w_full()
        .min_h(HEADER_BAR_MIN_HEIGHT)
        .items_center()
        .gap(t.space(Space::Xs).px())
        .px(t.space(Space::Sm).px())
        .fill(t.color("surface-secondary"))
        .border(1.0, t.color("border-base"))
        .border_layout()
        .child(
            text(title)
                .font(header_label_font())
                .color(t.color(if error {
                    "status-error"
                } else {
                    "text-secondary"
                }))
                .grow(1.0)
                .truncate(),
        )
        .children(action_el)
}

pub fn nested_tool_header<S: 'static>(
    toggle_key: Option<String>,
    name: &str,
    expanded: bool,
    status: ToolStatus,
    status_label: &str,
    press: impl Fn(&mut S) + 'static,
) -> El {
    let t = tokens(dark());
    let badge = tool_status(status, status_label);
    let Some(key) = toggle_key else {
        return row()
            .w_full()
            .min_h(HEADER_BAR_MIN_HEIGHT)
            .items_center()
            .gap(t.space(Space::Xs).px())
            .px(t.space(Space::Sm).px())
            .child(
                text(name)
                    .font(header_mono())
                    .color(t.color("text-primary"))
                    .truncate()
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0),
            )
            .child(badge);
    };
    let (outline, _) = focus_outline();
    let action = Rc::new(move |s: &mut S, _: &mut Tx| press(s));
    let on_press = action.clone();
    row()
        .key(key)
        .w_full()
        .min_h(HEADER_BAR_MIN_HEIGHT)
        .items_center()
        .gap(t.space(Space::Xs).px())
        .px(t.space(Space::Sm).px())
        .role("button")
        .expanded(expanded)
        .focusable(true)
        .hover(t.color("message-part-hover"))
        .focus_ring(outline, -outline, t.color("focus-ring-color"))
        .on_press_tx(move |s, tx| on_press(s, tx))
        .on_key(layout::enter_action(action))
        .child(chevron(expanded))
        .child(
            text(name)
                .font(header_mono())
                .color(t.color("text-primary"))
                .truncate()
                .grow(1.0)
                .shrink()
                .min_w(0.0),
        )
        .child(badge)
}

pub fn group_header<S: 'static>(
    toggle_key: String,
    label: &str,
    detail: Option<El>,
    meta: Vec<String>,
    expanded: bool,
    disabled: bool,
    press: impl Fn(&mut S) + 'static,
) -> El {
    let t = tokens(dark());
    let (outline, _) = focus_outline();
    let action = Rc::new(move |s: &mut S, _: &mut Tx| press(s));
    let on_press = action.clone();
    let mut trigger = row()
        .key(toggle_key)
        .w_full()
        .min_h(HEADER_BAR_MIN_HEIGHT)
        .items_center()
        .gap(t.space(Space::Xs).px())
        .py(t.space(Space::Xs).px())
        .pr(t.space(Space::Sm).px())
        .role("button")
        .expanded(expanded)
        .disabled(disabled)
        .focusable(!disabled)
        .hover(t.color("message-part-hover"))
        .focus_ring(outline, -outline, t.color("focus-ring-color"))
        .child(chevron(expanded))
        .child(
            text(label)
                .font(header_label_font())
                .color(t.color("text-secondary")),
        )
        .children(detail);
    for item in meta {
        trigger = trigger.child(
            text(format!("· {item}"))
                .text_role(TextRole::Small)
                .color(t.color("text-muted")),
        );
    }
    if disabled {
        trigger
    } else {
        trigger
            .on_press_tx(move |s, tx| on_press(s, tx))
            .on_key(layout::enter_action(action))
    }
}

pub fn code_block_frame(language: Option<&str>, actions: Vec<El>, body: El) -> El {
    let t = tokens(dark());
    let label = language
        .filter(|lang| !lang.trim().is_empty())
        .map(str::to_ascii_uppercase);
    let header = row()
        .w_full()
        .min_h(HEADER_BAR_MIN_HEIGHT)
        .items_center()
        .gap(t.space(Space::Xs).px())
        .pl(t.space(Space::Sm).px())
        .pr(t.space(Space::Xs).px())
        .fill(t.color("surface-secondary"))
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-base"))
        .border_layout()
        .child(
            text(label.unwrap_or_default())
                .font(header_label_font())
                .color(t.color("text-primary"))
                .truncate()
                .grow(1.0)
                .shrink()
                .min_w(0.0),
        )
        .children(actions);
    col()
        .w_full()
        .border(1.0, t.color("border-base"))
        .border_layout()
        .child(header)
        .child(body)
}

pub fn diff_frame(aria_label: &str, title: Option<&str>, actions: Vec<El>, body: El) -> El {
    let t = tokens(dark());
    let header = row()
        .w_full()
        .min_h(HEADER_BAR_MIN_HEIGHT)
        .items_center()
        .gap(t.space(Space::Xs).px())
        .pl(t.space(Space::Sm).px())
        .pr(t.space(Space::Xs).px())
        .role("group")
        .label(aria_label)
        .fill(t.color("surface-secondary"))
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-base"))
        .border_layout()
        .child(
            text(title.unwrap_or_default())
                .font(header_label_font())
                .color(t.color("text-primary"))
                .truncate()
                .grow(1.0)
                .shrink()
                .min_w(0.0),
        )
        .children(actions);
    col()
        .w_full()
        .border(1.0, t.color("border-base"))
        .border_layout()
        .child(header)
        .child(body)
}

pub fn message_header(
    is_user: bool,
    speaker: &str,
    timestamp: Option<&str>,
    actions: Vec<El>,
) -> El {
    let t = tokens(dark());
    let (glyph, accent) = if is_user {
        (&timeline_icons::USER, t.color("message-user-border"))
    } else {
        (&timeline_icons::BOT, t.color("message-assistant-border"))
    };
    let mut speaker_style = t.text(TextRole::Small);
    speaker_style.weight = t.number("font-weight-semibold").px();
    let left = row()
        .grow(1.0)
        .min_w(0.0)
        .items_center()
        .gap(t.space(Space::Xs).px())
        .child(icon(glyph, SPEAKER_ICON_SIZE).color(accent).a11y_hidden())
        .child(text(speaker).font(speaker_style).color(accent).truncate())
        .children(timestamp.map(|stamp| {
            text(stamp)
                .text_role(TextRole::Small)
                .color(t.color("text-muted"))
        }));
    row()
        .w_full()
        .items_center()
        .justify_between()
        .gap(t.space(Space::Sm).px())
        .child(left)
        .child(
            row()
                .items_center()
                .gap(t.space(Space::Xxs).px())
                .children(actions),
        )
}

pub fn message_card(key: String, is_user: bool, header: El) -> El {
    let t = tokens(dark());
    col()
        .key(key)
        .w_full()
        .fill(t.color(if is_user {
            "message-user-bg"
        } else {
            "message-assistant-bg"
        }))
        .px(t.space(Space::Md).px())
        .py(t.space(Space::Sm).px())
        .gap(t.space(Space::Xs).px())
        .child(header)
}

pub fn scroll_button<S: 'static>(
    key: &'static str,
    label: &str,
    up: bool,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let (outline, offset) = focus_outline();
    let glyph = if up { &shell_icons::UP } else { &ARROW_DOWN };
    let action = Rc::new(press);
    let on_press = action.clone();
    let button = row()
        .key(key)
        .size(SCROLL_BUTTON_SIZE, SCROLL_BUTTON_SIZE)
        .center()
        .radius(SCROLL_BUTTON_RADIUS)
        .fill(t.color("surface-overlay"))
        .border(1.0, t.color("border-base"))
        .hover(t.color("surface-hover"))
        .focus_ring(outline, offset, t.color("focus-ring-color"))
        .role("button")
        .label(label)
        .help(label)
        .disabled(disabled)
        .focusable(!disabled)
        .child(
            icon(glyph, SCROLL_ICON_SIZE)
                .color(t.color(if disabled {
                    "text-muted"
                } else {
                    "accent-primary"
                }))
                .a11y_hidden(),
        );
    if disabled {
        button
    } else {
        button
            .on_press_tx(move |s, tx| on_press(s, tx))
            .on_key(layout::enter_action(action))
    }
}

pub fn scroll_controls(locale: &str, oldest: Option<El>, latest: Option<El>) -> Option<El> {
    if oldest.is_none() && latest.is_none() {
        return None;
    }
    let t = tokens(dark());
    let inset = t.space(Space::Lg).px();
    let rtl = crate::catalogue::direction(locale) == "rtl";
    let (left, right) = if rtl {
        (Some(inset), None)
    } else {
        (None, Some(inset))
    };
    Some(
        row()
            .key("transcript-scroll-controls")
            .items_center()
            .gap(t.space(Space::Xs).px())
            .children(oldest)
            .children(latest)
            .pin(left, None, right, Some(inset))
            .raise(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};

    #[test]
    fn tool_header_and_scroll_controls_pin_bottom_inline_end() {
        fn build(locale: &'static str) -> Runtime<&'static str> {
            Runtime::new(
                locale,
                |locale, _| {
                    let controls = scroll_controls(
                        locale,
                        Some(scroll_button(
                            "oldest",
                            "First",
                            true,
                            false,
                            |_: &mut &'static str, _| {},
                        )),
                        Some(scroll_button(
                            "latest",
                            "Latest",
                            false,
                            false,
                            |_: &mut &'static str, _| {},
                        )),
                    );
                    let card = tool_card(
                        tool_header(
                            "toggle-tool-1".into(),
                            "Read src/lib.rs",
                            true,
                            tool_status(ToolStatus::Completed, "Completed"),
                            vec![
                                arguments_button(
                                    "Show arguments",
                                    Some(false),
                                    |_: &mut &'static str| {},
                                )
                                .key("toggle-tool-1-tool_input"),
                            ],
                            |_: &mut &'static str| {},
                        ),
                        Some(code_block_frame(
                            Some("RUST"),
                            vec![
                                wrap_button("Wrap", false, false, |_: &mut &'static str| {})
                                    .key("wrap-1"),
                            ],
                            text("fn main() {}"),
                        )),
                        None,
                    );
                    crate::timeline::transcript_lane_with_controls(
                        col().w_full().grow(1.0).child(card),
                        controls,
                    )
                    .w(600.0)
                    .h(400.0)
                },
                (600.0, 400.0),
                Env::new(true, 1.0),
            )
        }

        let mut ltr = build("en");
        ltr.frame(0.016);
        let (x_ltr, y_ltr) = ltr.find("transcript-scroll-controls").unwrap();
        assert!(x_ltr > 450.0, "LTR controls on right (x={x_ltr})");
        assert!(y_ltr > 300.0, "LTR controls near bottom (y={y_ltr})");
        assert!(ltr.find("toggle-tool-1-tool_input").is_some());

        let mut rtl = build("he");
        rtl.frame(0.016);
        let (x_rtl, y_rtl) = rtl.find("transcript-scroll-controls").unwrap();
        assert!(x_rtl < 100.0, "RTL controls on left (x={x_rtl})");
        assert!(y_rtl > 300.0, "RTL controls near bottom (y={y_rtl})");
    }
}
