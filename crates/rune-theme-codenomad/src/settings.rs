//! Preferences geometry follows settings-screen.css and the native Preferences bounds.
pub mod palette;
pub mod stats;
use crate::{
    Space, TextRole,
    layout::{self, Layout},
    tokens,
};
use rune::{AppSpec, Cx, El, ScrollSpec, col, el, row, text};
use rune_kit::{Checkbox, SegmentedControl, Select, SelectAppearance, Sidebar, SidebarRow};

pub const WINDOW_SIZE: (f32, f32) = (1100.0, 760.0);
pub const WINDOW_MIN: (f32, f32) = (760.0, 560.0);
pub const NARROW_BREAKPOINT: f32 = 600.0;

pub fn is_narrow(viewport_width: f32) -> bool {
    viewport_width > 0.0 && viewport_width < NARROW_BREAKPOINT
}

pub fn spec<S: 'static>(
    title: &'static str,
    init: fn() -> S,
    view: fn(&S, &mut Cx<S>) -> El,
) -> AppSpec<S> {
    AppSpec {
        min_size: Some(WINDOW_MIN),
        families: layout::font_families(),
        ..AppSpec::new(title, WINDOW_SIZE, init, view)
    }
}

pub fn save_warning_spec<S: 'static>(
    title: &'static str,
    init: fn() -> S,
    view: fn(&S, &mut Cx<S>) -> El,
) -> AppSpec<S> {
    AppSpec {
        families: layout::font_families(),
        ..AppSpec::new(title, (460.0, 150.0), init, view)
    }
}

pub fn authentication_dialog<S: 'static>(
    title: &str,
    fields: [El; 2],
    error: Option<El>,
    actions: [El; 2],
) -> El {
    let dark = layout::dark();
    let tokens = tokens(dark);
    let body = col()
        .full_width()
        .pad(Space::Md)
        .separate(Space::Sm)
        .children(fields)
        .children(error)
        .child(layout::action_row().children(actions));
    el().key("direct-recovery-layer")
        .absolute(0.0, 0.0)
        .full_width()
        .full_height()
        .center()
        .fill(crate::kit(dark).c.scrim)
        .child(
            col()
                .key("direct-recovery-dialog")
                .role("dialog")
                .label(title)
                .full_width()
                .max_w(460.0)
                .fill(tokens.color("surface-overlay"))
                .child(heading(title))
                .child(body)
                .modal(false, |_: &mut S| {})
                .modal_click_outside(false),
        )
}

pub fn modal_dialog<S: 'static>(
    key: &str,
    title: &str,
    close_button: El,
    body: El,
    focus_return: Option<&str>,
    dismiss: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let dark = layout::dark();
    let theme = tokens(dark);
    let header = row()
        .full_width()
        .center_y()
        .h(theme.length(crate::Length::Chrome).px())
        .fill(theme.color("surface-chrome"))
        .px(theme.space(Space::Md).px())
        .border_sides([0.0, 0.0, 1.0, 0.0], theme.color("border-divider"))
        .child(
            text(title)
                .role("heading")
                .text_role(TextRole::Title)
                .grow(1.0)
                .shrink()
                .truncate(),
        )
        .child(close_button);
    let mut dialog = col()
        .key(key)
        .role("dialog")
        .label(title)
        .full_width()
        .max_w(520.0)
        .fill(theme.color("surface-overlay"))
        .border(1.0, theme.color("border-base"))
        .child(header)
        .child(
            col()
                .full_width()
                .max_h(560.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .pad(Space::Md)
                .separate(Space::Sm)
                .child(body),
        )
        .modal_tx(true, dismiss)
        .modal_click_outside(false);
    if let Some(target) = focus_return {
        dialog = dialog.focus_return(target);
    }
    el().key(format!("{key}-layer"))
        .absolute(0.0, 0.0)
        .full_width()
        .full_height()
        .center()
        .fill(crate::kit(dark).c.scrim)
        .child(dialog)
}

pub fn embedded_section<S: 'static>(
    title: &str,
    body: El,
    close_button: El,
    close: impl Fn(&mut S) + 'static,
) -> El {
    let tokens = tokens(layout::dark());
    col()
        .key("embedded-preferences")
        .absolute(0.0, 0.0)
        .full_width()
        .full_height()
        .fill(tokens.color("surface-overlay"))
        .role("dialog")
        .label(title)
        .child(
            row()
                .full_width()
                .center_y()
                .pad(Space::Sm)
                .child(
                    text(title)
                        .text_role(TextRole::Title)
                        .role("heading")
                        .grow(1.0),
                )
                .child(close_button),
        )
        .child(
            col()
                .key("embedded-preferences-content")
                .full_width()
                .remaining()
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .pad(Space::Md)
                .child(body),
        )
        .modal(true, close)
        .modal_click_outside(false)
}

pub fn output_window<S: 'static>(
    key: &'static str,
    title: &str,
    subtitle: Option<&str>,
    return_focus: &'static str,
    actions: El,
    body: El,
    close: impl Fn(&mut S) + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let mut header = col().grow(1.0).shrink().child(
        text(title)
            .text_role(TextRole::Title)
            .role("heading")
            .truncate(),
    );
    if let Some(subtitle) = subtitle {
        header = header.child(
            text(subtitle)
                .text_role(TextRole::Small)
                .literal_direction()
                .truncate(),
        );
    }
    el().key(key)
        .absolute(0.0, 0.0)
        .full_width()
        .full_height()
        .pad(Space::Lg)
        .center()
        .fill(crate::kit(dark).c.scrim)
        .child(
            col()
                .role("dialog")
                .label(title)
                .focus_return(return_focus)
                .full_width()
                .full_height()
                .max_w(860.0)
                .fill(t.color("surface-overlay"))
                .border(1.0, t.color("border-base"))
                .child(
                    row()
                        .full_width()
                        .center_y()
                        .separate(Space::Sm)
                        .px(t.space(Space::Md).px())
                        .py(t.space(Space::Sm).px())
                        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-divider"))
                        .child(header)
                        .child(actions),
                )
                .child(
                    col()
                        .full_width()
                        .remaining()
                        .scroll(ScrollSpec {
                            stick_bottom: false,
                        })
                        .pad(Space::Md)
                        .separate(Space::Sm)
                        .child(body),
                )
                .modal(true, close)
                .modal_click_outside(false),
        )
}

pub fn log_block(content: &str) -> El {
    let t = tokens(layout::dark());
    col()
        .full_width()
        .pad(Space::Sm)
        .fill(t.color("surface-inset"))
        .border(1.0, t.color("border-divider"))
        .child(
            text(content)
                .text_role(TextRole::Mono)
                .literal_direction()
                .wrap()
                .selectable(true),
        )
}

#[cfg(target_os = "windows")]
pub fn placed_window<S: 'static>(
    spec: rune::WindowSpec<S>,
    position: (i32, i32),
    dimensions: (u32, u32),
    maximized: bool,
) -> rune::WindowSpec<S> {
    spec.options(rune::WindowOptions {
        position: Some(position),
        physical_size: Some(dimensions),
        ..Default::default()
    })
    .map_app(|app| app.maximized(maximized))
}

pub fn nav<S: 'static>(
    title: &str,
    label: &str,
    sections: impl IntoIterator<Item = (&'static str, &'static str, bool)>,
    select: impl Fn(&mut S, &'static str) + Clone + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = &*crate::kit(dark);
    let header = row()
        .full_width()
        .center_y()
        .h(t.length(crate::Length::Chrome).px())
        .fill(t.color("surface-chrome"))
        .px(t.space(Space::Md).px())
        .separate(Space::Sm)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-divider"))
        .child(
            el().size(26.0, 26.0)
                .center()
                .fill(t.color("surface-control"))
                .a11y_hidden()
                .child(
                    rune::icon(&crate::shell::icons::SETTINGS, 16.0)
                        .color(t.color("text-secondary")),
                ),
        )
        .child(text(title).role("heading").text_role(TextRole::Title));
    let mut sidebar = Sidebar::new()
        .inset(t.space(Space::Sm).px())
        .header(header)
        .label(label);
    for (key, label, selected) in sections {
        let select = select.clone();
        sidebar = sidebar.child(
            SidebarRow::new(label)
                .icon(section_icon(key))
                .height(35.0)
                .selected(selected)
                .on_select(move |s, _| select(s, key))
                .build(kit)
                .key(key),
        );
    }
    sidebar.build(kit)
}

fn blend(fg: rune::Color, bg: rune::Color, weight: f32) -> rune::Color {
    let inv = 1.0 - weight;
    rune::Color {
        r: fg.r * weight + bg.r * inv,
        g: fg.g * weight + bg.g * inv,
        b: fg.b * weight + bg.b * inv,
        a: fg.a * weight + bg.a * inv,
    }
}

fn header_icon_button<S: 'static>(
    glyph: &'static rune::Icon,
    label: &str,
    help: &str,
    touch: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let action = std::rc::Rc::new(press);
    let click = action.clone();
    let mut button = rune_kit::IconButton::new(glyph)
        .variant(rune_kit::IconButtonVariant::GhostMuted)
        .control_size(if touch {
            rune_kit::ControlSize::Regular
        } else {
            rune_kit::ControlSize::Small
        })
        .label(label)
        .help(help)
        .on_press_tx(move |s, tx| click(s, tx))
        .build(&crate::kit(layout::dark()))
        .on_key(layout::enter_action(action));
    if touch {
        button = button.min_w(44.0).min_h(44.0);
    }
    button
}

/// D12 compact mobile header bar (< 600 pt): `[gear] [section picker with icons] [×]`.
#[allow(clippy::too_many_arguments)]
pub fn compact_bar<S: 'static>(
    nav_label: &str,
    current_key: &'static str,
    current_label: &str,
    open: bool,
    sections: impl IntoIterator<Item = (&'static str, &'static str, bool)>,
    close_label: &str,
    touch: bool,
    layers: &mut Vec<El>,
    on_toggle: impl Fn(&mut S, &mut rune::Tx) + Clone + 'static,
    on_close_picker: impl Fn(&mut S, &mut rune::Tx) + Clone + 'static,
    on_select: impl Fn(&mut S, &'static str, &mut rune::Tx) + Clone + 'static,
    on_close_window: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = &*crate::kit(dark);
    let accent = t.color("accent-primary");
    let bar_h = if touch { 56.0 } else { 52.0 };
    let control_h = if touch { 44.0 } else { 40.0 };
    let badge_fill = blend(
        accent,
        t.color("surface-inset"),
        if dark { 0.04 } else { 0.12 },
    );
    let gear_badge = el()
        .key("settings-compact-icon")
        .size(control_h, control_h)
        .center()
        .fill(badge_fill)
        .border(1.0, t.color("border-base"))
        .a11y_hidden()
        .child(rune::icon(&crate::shell::icons::SETTINGS, 18.0).color(accent));

    let toggle_click = on_toggle.clone();
    let toggle_key = on_toggle;
    let trigger_inner = row()
        .key("settings-section-picker-trigger")
        .role("combobox")
        .label(nav_label)
        .a11y_value(current_label)
        .expanded(open)
        .focusable(true)
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .h(control_h)
        .px(t.space(Space::Sm).px())
        .separate(Space::Sm)
        .center_y()
        .fill(t.color("surface-control"))
        .hover(t.color("surface-hover"))
        .border(1.0, t.color("border-base"))
        .child(
            rune::icon(section_icon(current_key), 16.0)
                .color(accent)
                .a11y_hidden(),
        )
        .child(
            text(current_label)
                .text_role(TextRole::Body)
                .color(t.color("text-primary"))
                .grow(1.0)
                .shrink()
                .truncate()
                .a11y_hidden(),
        )
        .child(
            rune::icon(
                if open {
                    &icons::CHEVRON_UP
                } else {
                    &crate::git_panel::CHEVRON_DOWN
                },
                12.0,
            )
            .color(t.color("text-muted"))
            .a11y_hidden(),
        )
        .on_press_tx(move |s, tx| toggle_click(s, tx))
        .on_key(move |s, event, tx| {
            if event.mods != rune::Mods::default() {
                return false;
            }
            match event.key {
                rune::Key::Enter | rune::Key::Down | rune::Key::Up => {
                    if !tx.key_repeat() {
                        toggle_key(s, tx);
                    }
                    true
                }
                rune::Key::Text(ref ch) if ch == " " => {
                    if !tx.key_repeat() {
                        toggle_key(s, tx);
                    }
                    true
                }
                _ => false,
            }
        });
    let trigger = trigger_inner.focus_ring(2.0, 2.0, kit.c.border_focus);

    if open {
        let items: Vec<_> = sections.into_iter().collect();
        let keys: Vec<&'static str> = items.iter().map(|(k, _, _)| *k).collect();
        let row_h = if touch { 44.0 } else { 36.0 };
        let mut list = col()
            .key("settings-section-picker-list")
            .role("listbox")
            .label(nav_label)
            .focus_group()
            .full_width()
            .min_w(0.0)
            .pad(Space::Xs)
            .separate(Space::Xxs);
        for (key, label, selected) in items {
            let select = on_select.clone();
            let select_key = on_select.clone();
            let fill = if selected {
                t.color("menu-item-selected-bg")
            } else {
                rune::Color::TRANSPARENT
            };
            let item = row()
                .key(key)
                .role("option")
                .label(label)
                .focus_selected(selected)
                .focusable(true)
                .full_width()
                .min_w(0.0)
                .h(row_h)
                .px(t.space(Space::Sm).px())
                .separate(Space::Sm)
                .center_y()
                .fill(fill)
                .hover(t.color("menu-item-hover-bg"))
                .child(
                    rune::icon(section_icon(key), 16.0)
                        .color(accent)
                        .a11y_hidden(),
                )
                .child(
                    text(label)
                        .text_role(TextRole::Body)
                        .color(t.color("text-primary"))
                        .grow(1.0)
                        .shrink()
                        .truncate()
                        .a11y_hidden(),
                )
                .on_press_tx(move |s, tx| select(s, key, tx))
                .on_key(move |s, event, tx| {
                    if event.mods != rune::Mods::default() {
                        return false;
                    }
                    match event.key {
                        rune::Key::Enter => {
                            if !tx.key_repeat() {
                                select_key(s, key, tx);
                            }
                            true
                        }
                        rune::Key::Text(ref ch) if ch == " " => {
                            if !tx.key_repeat() {
                                select_key(s, key, tx);
                            }
                            true
                        }
                        _ => false,
                    }
                });
            list = list.child(item.focus_ring(1.0, 0.0, kit.c.border_focus));
        }
        let close_keys = on_close_picker.clone();
        let close_modal = on_close_picker;
        let popover = col()
            .key("settings-section-picker-popover")
            .w(280.0)
            .max_h(440.0)
            .fill(t.color("surface-overlay"))
            .border(1.0, t.color("border-base"))
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .child(list)
            .focus_return("settings-section-picker-trigger")
            .modal_tx(true, move |s, tx| close_modal(s, tx))
            .modal_click_outside(true)
            .on_key(move |s, event, tx| {
                if event.mods != rune::Mods::default() {
                    return false;
                }
                if event.key == rune::Key::Escape {
                    close_keys(s, tx);
                    tx.focus("settings-section-picker-trigger", true);
                    return true;
                }
                if keys.is_empty() {
                    return false;
                }
                let current = tx
                    .focused()
                    .and_then(|focused| keys.iter().position(|k| *k == focused));
                let next = match event.key {
                    rune::Key::Down => Some(current.map_or(0, |i| (i + 1) % keys.len())),
                    rune::Key::Up => {
                        Some(current.map_or(keys.len() - 1, |i| (i + keys.len() - 1) % keys.len()))
                    }
                    rune::Key::Home => Some(0),
                    rune::Key::End => Some(keys.len() - 1),
                    _ => None,
                };
                if let Some(index) = next {
                    tx.focus(keys[index], true);
                    return true;
                }
                false
            });
        layers.push(rune_kit::popover::anchored(
            kit,
            popover,
            "settings-section-picker-trigger",
            rune_kit::Placement::BottomStart,
            4.0,
        ));
    }

    row()
        .key("settings-compact-bar")
        .full_width()
        .min_w(0.0)
        .center_y()
        .h(bar_h)
        .fill(t.color("surface-chrome"))
        .px(t.space(Space::Sm).px())
        .separate(Space::Sm)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-base"))
        .child(gear_badge)
        .child(trigger)
        .child(
            header_icon_button(
                &crate::window_control::CLOSE,
                close_label,
                close_label,
                touch,
                on_close_window,
            )
            .key("settings-close"),
        )
}

pub fn narrow_frame(content: El, overlays: Vec<El>) -> El {
    let t = tokens(layout::dark());
    el().full_width()
        .full_height()
        .min_w(0.0)
        .fill(t.color("surface-secondary"))
        .child(content)
        .children(overlays)
}

pub fn embedded_narrow_frame<S: 'static>(
    title: &str,
    content: El,
    overlays: Vec<El>,
    on_escape: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    narrow_frame(content, overlays)
        .key("embedded-preferences")
        .absolute(0.0, 0.0)
        .role("dialog")
        .label(title)
        .modal_tx(true, on_escape)
        .modal_click_outside(false)
}

pub fn narrow_pane(section: &str, header: El, children: impl IntoIterator<Item = El>) -> El {
    let t = tokens(layout::dark());
    col()
        .full_width()
        .full_height()
        .min_w(0.0)
        .child(header)
        .child(
            col()
                .key(section)
                .full_width()
                .min_w(0.0)
                .remaining()
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .px(t.space(Space::Md).px())
                .py(t.space(Space::Md).px())
                .children(children),
        )
}

const PRESET_NARROW_BREAKPOINT: f32 = 672.0;

pub fn preset_columns(viewport_width: f32) -> usize {
    if viewport_width > 0.0 && viewport_width < PRESET_NARROW_BREAKPOINT {
        2
    } else {
        4
    }
}

#[allow(clippy::too_many_arguments)]
pub fn preset_buttons<S: 'static>(
    label: &str,
    options: &[&str],
    selected: Option<usize>,
    active_tag: &str,
    disabled_tag: &str,
    disabled: bool,
    columns: usize,
    choose: impl Fn(&mut S, usize) + Clone + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = &*crate::kit(dark);
    let accent = t.color("accent-primary");
    let border_base = t.color("border-base");
    let control_bg = t.color("surface-control");
    let selected_fill = blend(accent, control_bg, if dark { 0.035 } else { 0.10 });
    let selected_border = blend(accent, border_base, 0.48);
    col()
        .key("transcript-presets")
        .role("group")
        .label(label)
        .full_width()
        .equal_columns(columns.max(1))
        .separate(Space::Sm)
        .children(options.iter().enumerate().map(|(index, &option)| {
            let active = selected == Some(index);
            let choose = choose.clone();
            let action = std::rc::Rc::new(move |s: &mut S, _: &mut rune::Tx| choose(s, index));
            let press = action.clone();
            let fill = if active { selected_fill } else { control_bg };
            let border_color = if active { selected_border } else { border_base };
            let mut card = row()
                .key(format!("transcript-preset-{index}"))
                .role("button")
                .label(option)
                .checked(active)
                .disabled(disabled)
                .focusable(!disabled)
                .full_width()
                .min_w(0.0)
                .min_h(64.0)
                .fill(fill)
                .border(1.0, border_color)
                .children(active.then(|| el().w(2.0).full_height().fill(accent).a11y_hidden()))
                .child(
                    col()
                        .grow(1.0)
                        .shrink()
                        .min_w(0.0)
                        .pad(Space::Sm)
                        .items_start()
                        .justify_start()
                        .child(
                            text(option)
                                .text_role(TextRole::Button)
                                .color(t.color("text-primary"))
                                .wrap()
                                .a11y_hidden(),
                        ),
                );
            if !disabled {
                card = card
                    .hover(t.color("surface-hover"))
                    .on_press_tx(move |s, tx| press(s, tx))
                    .on_key(layout::enter_action(action));
            }
            let button = card.focus_ring(2.0, 2.0, kit.c.border_focus);
            #[cfg(target_arch = "wasm32")]
            let button = match (active, disabled) {
                (true, true) => button.description(format!("{active_tag}, {disabled_tag}")),
                (true, false) => button.description(active_tag),
                (false, true) => button.description(disabled_tag),
                (false, false) => button,
            };
            #[cfg(not(target_arch = "wasm32"))]
            let _ = (active_tag, disabled_tag);
            button
        }))
}

pub fn segments<S: 'static>(
    label: &str,
    options: &[&str],
    selected: Option<usize>,
    disabled: bool,
    choose: impl Fn(&mut S, usize) + Clone + 'static,
) -> El {
    let mut control = SegmentedControl::new(options, selected)
        .label(label)
        .fit()
        .on_pick(move |s, index, _| choose(s, index));
    if disabled {
        for index in 0..options.len() {
            control = control.segment_state(index, rune_kit::State::Disabled);
        }
    }
    control.build(&crate::kit(layout::dark()))
}

const PICKER_WIDTH: f32 = 220.0;
const WIDE_PICKER_WIDTH: f32 = 300.0;
const LANGUAGE_PICKER_WIDTH: f32 = 180.0;
const COMPACT_PICKER_WIDTH: f32 = 136.0;
const PALETTE_PICKER_WIDTH: f32 = 160.0;

fn table_width(compact: bool) -> f32 {
    if compact { COMPACT_PICKER_WIDTH } else { 200.0 }
}

/// Segments whose selection commits a change. Navigation only moves focus.
pub fn committing_segments<S: 'static>(
    label: &str,
    options: &[&str],
    selected: Option<usize>,
    locale: &str,
    choose: impl Fn(&mut S, usize) + Clone + 'static,
) -> El {
    let count = options.len();
    let rtl = crate::catalogue::direction(locale) == "rtl";
    segments(label, options, selected, false, choose.clone()).on_key(move |s, event, tx| {
        if event.mods != rune::Mods::default() {
            return false;
        }
        let Some(index) = tx
            .focused()
            .and_then(|key| key.strip_prefix("segment"))
            .and_then(|index| index.parse::<usize>().ok())
            .filter(|index| *index < count)
        else {
            return false;
        };
        let next = match event.key {
            rune::Key::Left if !rtl => (index + count - 1) % count,
            rune::Key::Right if rtl => (index + count - 1) % count,
            rune::Key::Right | rune::Key::Left | rune::Key::Down => (index + 1) % count,
            rune::Key::Up => (index + count - 1) % count,
            rune::Key::Home => 0,
            rune::Key::End => count - 1,
            rune::Key::Enter => {
                if !tx.key_repeat() {
                    choose(s, index);
                }
                return true;
            }
            _ => return false,
        };
        tx.focus(format!("segment{next}"), true);
        true
    })
}

pub fn picker(key: &str, label: &str, options: &[&str]) -> Select {
    Select::new(key, options)
        .label(label)
        .width(PICKER_WIDTH)
        .appearance(SelectAppearance::Field)
}

pub fn wide_picker(key: &str, label: &str, options: &[&str]) -> Select {
    Select::new(key, options)
        .label(label)
        .width(WIDE_PICKER_WIDTH)
        .appearance(SelectAppearance::Field)
}

pub fn language_picker(key: &str, label: &str, options: &[&str]) -> Select {
    Select::new(key, options)
        .label(label)
        .width(LANGUAGE_PICKER_WIDTH)
        .appearance(SelectAppearance::Field)
}

pub fn palette_picker(key: &str, label: &str, options: &[&str]) -> Select {
    Select::new(key, options)
        .label(label)
        .width(PALETTE_PICKER_WIDTH)
        .appearance(SelectAppearance::Field)
}

pub fn stepping_picker(key: &str, label: &str, options: &[&str]) -> Select {
    picker(key, label, options).step_closed(true)
}

pub fn wide_stepping_picker(key: &str, label: &str, options: &[&str]) -> Select {
    wide_picker(key, label, options).step_closed(true)
}

pub fn table_picker(key: &str, label: &str, options: &[&str], compact: bool) -> Select {
    Select::new(key, options)
        .label(label)
        .width(table_width(compact))
        .appearance(SelectAppearance::Field)
}

pub fn build_picker(control: Select, layers: &mut Vec<El>) -> El {
    let dark = layout::dark();
    let mut kit = crate::kit(dark).clone();
    kit.c.bg_base = tokens(dark).color("surface-control");
    kit.c.layer_01 = tokens(dark).color("surface-overlay");
    control.build(&kit, layers)
}

pub fn transcript_popup<S: 'static>(
    trigger: &str,
    label: &str,
    content: El,
    viewport: &layout::DrawnRect,
    dismiss: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let dark = layout::dark();
    let theme = tokens(dark);
    let body = col()
        .key("transcript-filters")
        .role("dialog")
        .label(label)
        .focus_return(trigger)
        .modal_tx(true, dismiss)
        // transcript-filters.css: width 18rem, an independently scrolling list.
        .w(288.0)
        .fill(theme.color("surface-overlay"))
        .border(1.0, theme.color("border-base"))
        .child(heading(label))
        .child(
            col()
                .max_h(400.0)
                .drawn_rect_into(viewport)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(content),
        );
    rune_kit::popover::anchored(
        &crate::kit(dark),
        body,
        trigger,
        rune_kit::Placement::BottomEnd,
        6.0,
    )
}

pub fn transcript_preset_picker(key: &str, label: &str, options: &[&str]) -> Select {
    picker(key, label, options).width(272.0)
}

pub enum FilterDrag {
    Start([f32; 2]),
    Move([f32; 2]),
    Release([f32; 2]),
    Cancel,
}

pub fn filter_drag<S: 'static>(
    button: El,
    change: impl Fn(&mut S, FilterDrag, &mut rune::Tx) + 'static,
) -> El {
    button.on_drag(move |s, drag, tx| {
        let point = drag.window_point();
        change(
            s,
            match drag.phase {
                rune::Phase::Down => FilterDrag::Start(point),
                rune::Phase::Move => FilterDrag::Move(point),
                rune::Phase::Up if drag.cancelled() => FilterDrag::Cancel,
                rune::Phase::Up => FilterDrag::Release(point),
            },
            tx,
        );
    })
}

pub fn transcript_filter_row<S: 'static>(
    label: &str,
    visibility: (&str, bool, impl Fn(&mut S, &mut rune::Tx) + 'static),
    expansion: (&str, bool, impl Fn(&mut S, &mut rune::Tx) + 'static),
    disabled: bool,
    disabled_tag: &str,
    decorate: impl Fn(El, bool) -> El,
) -> El {
    use crate::git_panel::{CHEVRON_DOWN, CHEVRON_RIGHT, EYE};
    fn filter_button<S: 'static>(
        glyph: &'static rune::Icon,
        label: &str,
        disabled: bool,
        disabled_tag: &str,
        active: bool,
        press: impl Fn(&mut S, &mut rune::Tx) + 'static,
    ) -> El {
        let press = std::rc::Rc::new(press);
        let by_pointer = press.clone();
        let button =
            crate::git_panel::icon_button(glyph, label, disabled, Some(active), move |s, tx| {
                by_pointer(s, tx)
            });
        #[cfg(target_arch = "wasm32")]
        let button = if disabled {
            button.description(disabled_tag)
        } else {
            button
        };
        #[cfg(not(target_arch = "wasm32"))]
        let _ = disabled_tag;
        if disabled {
            button
        } else {
            button.on_key(move |s, key, tx| {
                if key.key != rune::Key::Enter {
                    return false;
                }
                press(s, tx);
                true
            })
        }
    }
    let (visibility_name, visible, set_visibility) = visibility;
    let (expansion_name, expanded, set_expansion) = expansion;
    row()
        .role("group")
        .label(label)
        .full_width()
        .center_y()
        .pad(Space::Xs)
        .child(
            text(label)
                .text_role(TextRole::Label)
                .grow(1.0)
                .shrink()
                .truncate(),
        )
        .child(decorate(
            filter_button(
                &EYE,
                visibility_name,
                disabled,
                disabled_tag,
                visible,
                set_visibility,
            )
            .key("visibility"),
            false,
        ))
        .child(decorate(
            filter_button(
                if expanded {
                    &CHEVRON_DOWN
                } else {
                    &CHEVRON_RIGHT
                },
                expansion_name,
                disabled || !visible,
                disabled_tag,
                expanded,
                set_expansion,
            )
            .key("expansion"),
            true,
        ))
}

pub fn render<S, T>(
    cx: &mut Cx<S>,
    dark: bool,
    palette: Option<crate::palettes::ResolvedPalette>,
    build: impl FnOnce(&mut Cx<S>) -> T,
) -> T {
    crate::palettes::with_resolved(palette, || layout::render_with_dark(cx, dark, build))
}

pub fn frame(sidebar: El, body: El, overlays: Vec<El>) -> El {
    let t = tokens(layout::dark());
    el().full_width()
        .full_height()
        .fill(t.color("surface-secondary"))
        .child(
            row()
                .full_width()
                .full_height()
                .child(
                    col()
                        .w(260.0)
                        .full_height()
                        .border_sides([0.0, 1.0, 0.0, 0.0], t.color("border-divider"))
                        .child(sidebar),
                )
                .child(body),
        )
        .children(overlays)
}

pub fn heading(title: &str) -> El {
    let t = tokens(layout::dark());
    row()
        .full_width()
        .center_y()
        .h(t.length(crate::Length::Chrome).px())
        .fill(t.color("surface-chrome"))
        .px(t.space(Space::Md).px())
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-divider"))
        .child(text(title).role("heading").text_role(TextRole::Title))
}

pub fn pane(section: &str, title: &str, children: impl IntoIterator<Item = El>) -> El {
    let t = tokens(layout::dark());
    col()
        .grow(1.0)
        .shrink()
        .full_height()
        .child(heading(title))
        .child(
            col()
                .key(section)
                .full_width()
                .remaining()
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .px(t.space(Space::Lg).px())
                .py(t.space(Space::Md).px())
                .children(children),
        )
}

pub fn card(child: El) -> El {
    let t = tokens(layout::dark());
    col()
        .full_width()
        .py(14.0)
        .separate(Space::Sm)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-divider"))
        .motion(rune::Spring::NONE)
        .child(child)
}

pub fn card_header(title: &str, status: Option<&str>) -> El {
    let mut header = row()
        .full_width()
        .min_w(0.0)
        .flex_wrap()
        .center_y()
        .justify_between()
        .separate(Space::Sm)
        .child(
            text(title)
                .role("heading")
                .text_role(TextRole::Button)
                .shrink()
                .wrap(),
        );
    if let Some(status) = status {
        header = header.child(
            text(status)
                .text_role(TextRole::Small)
                .role("status")
                .wrap(),
        );
    }
    header
}

pub fn input_action_row(input: El, action: El) -> El {
    layout::action_row().child(input.grow(1.0)).child(action)
}

pub fn card_header_control(title: &str, control: El) -> El {
    row()
        .full_width()
        .min_w(0.0)
        .center_y()
        .justify_between()
        .flex_wrap()
        .separate(Space::Md)
        .child(
            text(title)
                .text_role(TextRole::Title)
                .role("heading")
                .shrink()
                .wrap(),
        )
        .child(control)
}

pub fn trailing_action_row() -> El {
    layout::action_row()
        .justify_end()
        .motion(rune::Spring::NONE)
}

pub fn binary_list(items: impl IntoIterator<Item = El>) -> El {
    let t = tokens(layout::dark());
    let mut list = col()
        .full_width()
        .min_w(0.0)
        .border(1.0, t.color("border-base"));
    for (index, item) in items.into_iter().enumerate() {
        list = list.child(if index == 0 {
            item
        } else {
            el().full_width()
                .min_w(0.0)
                .border_sides([1.0, 0.0, 0.0, 0.0], t.color("border-row"))
                .child(item)
        });
    }
    list
}

#[allow(clippy::too_many_arguments)]
pub fn binary_row_item<S: 'static>(
    label: &str,
    path: Option<&str>,
    caption: Option<&str>,
    selected: bool,
    disabled: bool,
    key: String,
    select: impl Fn(&mut S) + 'static,
    remove: Option<(String, &str, impl Fn(&mut S) + 'static)>,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = &*crate::kit(dark);
    let select_rc = std::rc::Rc::new(move |s: &mut S, _: &mut rune::Tx| select(s));
    let click = select_rc.clone();
    let mut details = col()
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .separate(Space::Xxs)
        .child(
            row()
                .full_width()
                .min_w(0.0)
                .center_y()
                .separate(Space::Sm)
                .child(
                    rune::icon(&icons::CHECK, 14.0)
                        .color(t.color("text-primary"))
                        .opacity(if selected { 1.0 } else { 0.0 })
                        .a11y_hidden(),
                )
                .child(
                    text(label)
                        .text_role(TextRole::Body)
                        .color(t.color("text-primary"))
                        .grow(1.0)
                        .shrink()
                        .truncate()
                        .a11y_hidden(),
                ),
        );
    if let Some(path) = path {
        details = details.child(
            el().pl(22.0).child(
                text(path)
                    .text_role(TextRole::Mono)
                    .color(t.color("text-muted"))
                    .literal_direction()
                    .truncate(),
            ),
        );
    }
    if let Some(caption) = caption {
        details = details.child(
            el().pl(22.0).child(
                text(caption)
                    .text_role(TextRole::Small)
                    .color(t.color("text-muted"))
                    .role("status"),
            ),
        );
    }
    let mut content_btn = row().key(key).role("button").label(label);
    if let Some(path) = path.filter(|p| *p != label) {
        content_btn = content_btn.description(path);
    }
    content_btn = content_btn
        .checked(selected)
        .disabled(disabled)
        .focusable(!disabled)
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .px(t.space(Space::Sm).px())
        .py(t.space(Space::Sm).px())
        .child(details);
    if !disabled {
        content_btn = content_btn
            .hover(t.color("surface-hover-overlay"))
            .on_press_tx(move |s, tx| click(s, tx))
            .on_key(layout::enter_action(select_rc));
    }
    let content_btn = content_btn.focus_ring(1.0, 0.0, kit.c.border_focus);
    let fill = if selected {
        t.color("selection-neutral-strong-bg")
    } else {
        rune::Color::TRANSPARENT
    };
    let mut line = row()
        .full_width()
        .min_w(0.0)
        .center_y()
        .fill(fill)
        .child(content_btn);
    if let Some((remove_key, remove_label, on_remove)) = remove {
        let on_remove_rc = std::rc::Rc::new(move |s: &mut S, _: &mut rune::Tx| on_remove(s));
        let click_rm = on_remove_rc.clone();
        let rm_btn = rune_kit::IconButton::new(&icons::TRASH_2)
            .variant(rune_kit::IconButtonVariant::GhostMuted)
            .control_size(rune_kit::ControlSize::Small)
            .label(remove_label)
            .help(remove_label)
            .disabled(disabled)
            .on_press_tx(move |s, tx| click_rm(s, tx))
            .build(kit)
            .key(remove_key);
        let rm_btn = if disabled {
            rm_btn
        } else {
            rm_btn.on_key(layout::enter_action(on_remove_rc))
        };
        line = line.child(el().pr(t.space(Space::Xs).px()).child(rm_btn));
    }
    line
}

pub fn divided_rows(rows: impl IntoIterator<Item = El>) -> El {
    let t = tokens(layout::dark());
    let mut stack = col().full_width().min_w(0.0);
    for (index, item) in rows.into_iter().enumerate() {
        stack = stack.child(if index == 0 {
            item
        } else {
            el().full_width()
                .min_w(0.0)
                .border_sides([1.0, 0.0, 0.0, 0.0], t.color("border-row"))
                .child(item)
        });
    }
    stack
}

pub fn setting_row(label: &str, control: El) -> El {
    setting_row_with_info(label, None, control)
}

pub fn language_row(label: &str, picker: El) -> El {
    let t = tokens(layout::dark());
    let control = row()
        .center_y()
        .separate(Space::Xs)
        .child(
            rune::icon(&icons::LANGUAGES, 16.0)
                .color(t.color("text-muted"))
                .a11y_hidden(),
        )
        .child(picker);
    setting_row(label, control)
}

pub fn field_row(label: &str, info: Option<El>, field: El) -> El {
    row()
        .full_width()
        .min_w(0.0)
        .min_h(35.0)
        .py(2.0)
        .flex_wrap()
        .center_y()
        .justify_between()
        .separate(Space::Md)
        .child(
            row()
                .center_y()
                .shrink()
                .min_w(0.0)
                .separate(Space::Xs)
                .child(text(label).text_role(TextRole::Body).shrink().wrap())
                .children(info),
        )
        .child(
            el().min_w(160.0)
                .max_w(360.0)
                .grow(1.0)
                .shrink()
                .child(field),
        )
}

pub fn info_row(label: &str, value: &str, muted: bool) -> El {
    let t = tokens(layout::dark());
    row()
        .full_width()
        .min_w(0.0)
        .min_h(35.0)
        .py(3.0)
        .center_y()
        .justify_between()
        .separate(Space::Md)
        .child(
            text(label)
                .text_role(TextRole::Label)
                .color(t.color("text-secondary"))
                .shrink()
                .wrap(),
        )
        .child(
            text(value)
                .text_role(TextRole::Mono)
                .color(t.color(if muted { "text-muted" } else { "text-primary" }))
                .literal_direction()
                .shrink()
                .wrap(),
        )
}

pub fn empty_box(message: &str) -> El {
    let t = tokens(layout::dark());
    el().full_width()
        .min_w(0.0)
        .pad(Space::Md)
        .fill(t.color("surface-inset"))
        .border(1.0, t.color("border-base"))
        .child(
            text(message)
                .text_role(TextRole::Small)
                .color(t.color("text-muted"))
                .wrap()
                .role("status"),
        )
}

pub fn server_scope_badge(label: &str) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let accent = t.color("accent-primary");
    el().px(8.0)
        .py(3.0)
        .fill(blend(
            accent,
            t.color("surface-inset"),
            if dark { 0.04 } else { 0.12 },
        ))
        .child(text(label).text_role(TextRole::Small).color(accent))
}

pub fn refresh_icon_button<S: 'static>(
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S) + 'static,
) -> El {
    crate::git_panel::icon_button(
        &crate::git_panel::REFRESH_CW,
        label,
        disabled,
        None,
        move |s, _| press(s),
    )
}

pub fn remote_header(title: &str, subtitle: &str, scope_badge: El, refresh: El) -> El {
    let t = tokens(layout::dark());
    row()
        .full_width()
        .min_w(0.0)
        .flex_wrap()
        .justify_between()
        .separate(Space::Sm)
        .child(
            row()
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .separate(Space::Sm)
                .child(
                    el().pt(2.0)
                        .a11y_hidden()
                        .child(rune::icon(&icons::MONITOR_UP, 16.0).color(t.color("text-muted"))),
                )
                .child(
                    col()
                        .grow(1.0)
                        .shrink()
                        .min_w(0.0)
                        .separate(Space::Xxs)
                        .child(
                            text(title)
                                .text_role(TextRole::Title)
                                .role("heading")
                                .wrap(),
                        )
                        .child(
                            text(subtitle)
                                .text_role(TextRole::Small)
                                .color(t.color("text-muted"))
                                .wrap(),
                        ),
                ),
        )
        .child(
            row()
                .center_y()
                .separate(Space::Sm)
                .child(scope_badge)
                .child(refresh),
        )
}

pub fn remote_status_card(
    tone: &str,
    state_label: &str,
    info: Option<El>,
    subtitle: &str,
    subtitle_mono: bool,
) -> El {
    let t = tokens(layout::dark());
    let dot_color = match tone {
        "connected" => t.color("status-success"),
        "connecting" => t.color("status-warning"),
        "error" => t.color("status-error"),
        _ => t.color("text-muted"),
    };
    row()
        .key("remote-control-status-card")
        .full_width()
        .min_w(0.0)
        .fill(t.color("surface-inset"))
        .border(1.0, t.color("border-base"))
        .pad(Space::Sm)
        .separate(Space::Sm)
        .child(
            el().pt(5.0)
                .a11y_hidden()
                .child(el().size(8.0, 8.0).fill(dot_color)),
        )
        .child(
            col()
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .separate(Space::Xxs)
                .child(
                    row()
                        .center_y()
                        .separate(Space::Xs)
                        .child(
                            text(state_label)
                                .text_role(TextRole::Button)
                                .role("status")
                                .wrap(),
                        )
                        .children(info),
                )
                .child(
                    text(subtitle)
                        .text_role(if subtitle_mono {
                            TextRole::Mono
                        } else {
                            TextRole::Small
                        })
                        .color(t.color("text-muted"))
                        .wrap()
                        .literal_direction(),
                ),
        )
}

pub fn heading_with_icon(icon_key: &str, title: &str) -> El {
    let t = tokens(layout::dark());
    let glyph = match icon_key {
        "shield-check" => &icons::SHIELD_CHECK,
        "monitor-up" => &icons::MONITOR_UP,
        _ => &icons::INFO,
    };
    row()
        .full_width()
        .min_w(0.0)
        .center_y()
        .separate(Space::Sm)
        .child(
            rune::icon(glyph, 16.0)
                .color(t.color("text-muted"))
                .a11y_hidden(),
        )
        .child(
            text(title)
                .text_role(TextRole::Title)
                .role("heading")
                .wrap(),
        )
}

pub fn text_link_button<S: 'static>(
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = &*crate::kit(dark);
    let action = std::rc::Rc::new(press);
    let click = action.clone();
    let mut btn = el()
        .role("button")
        .label(label)
        .disabled(disabled)
        .focusable(!disabled)
        .px(2.0)
        .py(4.0)
        .child(
            text(label)
                .text_role(TextRole::Body)
                .color(if disabled {
                    t.color("text-muted")
                } else {
                    t.color("accent-primary")
                })
                .a11y_hidden(),
        );
    if !disabled {
        btn = btn
            .hover(t.color("surface-hover-overlay"))
            .on_press_tx(move |s, tx| click(s, tx))
            .on_key(layout::enter_action(action));
    }
    btn.focus_ring(2.0, 2.0, kit.c.border_focus)
}

#[allow(clippy::too_many_arguments)]
pub fn shortcut_row<S: 'static>(
    row_key: String,
    label: &str,
    binding: &str,
    empty_label: &str,
    clear_label: &str,
    clear_disabled: bool,
    on_clear: impl Fn(&mut S) + 'static,
    actions: Vec<El>,
    extra: Vec<El>,
    description: Option<String>,
    help: Option<&str>,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = &*crate::kit(dark);
    let clear_rc = std::rc::Rc::new(move |s: &mut S, _: &mut rune::Tx| on_clear(s));
    let clear_click = clear_rc.clone();
    let clear_btn = rune_kit::IconButton::new(&crate::window_control::CLOSE)
        .variant(rune_kit::IconButtonVariant::GhostMuted)
        .control_size(rune_kit::ControlSize::Small)
        .label(clear_label)
        .help(clear_label)
        .disabled(clear_disabled)
        .on_press_tx(move |s, tx| clear_click(s, tx))
        .build(kit);
    let clear_btn = if clear_disabled {
        clear_btn
    } else {
        clear_btn.on_key(layout::enter_action(clear_rc))
    };
    let binding_text = if binding.is_empty() {
        text(empty_label)
            .text_role(TextRole::Small)
            .color(t.color("text-muted"))
            .truncate()
    } else {
        text(binding)
            .text_role(TextRole::Mono)
            .color(t.color("text-primary"))
            .literal_direction()
            .truncate()
    };
    let shortcut_box = row()
        .w(184.0)
        .min_w(128.0)
        .min_h(30.0)
        .center_y()
        .fill(t.color("surface-field"))
        .border(1.0, t.color("border-base"))
        .pl(t.space(Space::Sm).px())
        .pr(2.0)
        .separate(Space::Xs)
        .child(el().grow(1.0).shrink().min_w(0.0).child(binding_text))
        .child(clear_btn);
    let left = col()
        .grow(1.0)
        .shrink()
        .min_w(140.0)
        .separate(Space::Xxs)
        .child(text(label).text_role(TextRole::Body).wrap())
        .children(extra);
    let mut group = row()
        .key(row_key)
        .role("group")
        .label(label)
        .full_width()
        .min_w(0.0)
        .min_h(38.0)
        .py(6.0)
        .flex_wrap()
        .center_y()
        .separate(Space::Sm)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-row"))
        .child(left)
        .child(shortcut_box)
        .children(
            (!actions.is_empty()).then(|| row().center_y().separate(Space::Xs).children(actions)),
        );
    if let Some(description) = description {
        group = group.description(description);
    }
    if let Some(help) = help {
        group = group.help(help);
    }
    group
}

pub fn setting_table_frame(label: &str, header: El, rows: impl IntoIterator<Item = El>) -> El {
    let t = tokens(layout::dark());
    col()
        .role("table")
        .label(label)
        .full_width()
        .min_w(0.0)
        .border(1.0, t.color("border-base"))
        .child(header)
        .children(rows)
}

pub fn setting_table_header(item: &str, state: &str, compact: bool) -> El {
    let t = tokens(layout::dark());
    let header_bg = blend(t.color("surface-inset"), t.color("surface-secondary"), 0.25);
    row()
        .role("row")
        .full_width()
        .min_w(0.0)
        .center_y()
        .separate(Space::Md)
        .px(14.0)
        .py(10.0)
        .fill(header_bg)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-base"))
        .child(
            col()
                .role("columnheader")
                .label(item)
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .child(
                    text(item.to_uppercase())
                        .text_role(TextRole::Small)
                        .color(t.color("text-muted"))
                        .a11y_hidden(),
                ),
        )
        .child(
            col()
                .role("columnheader")
                .label(state)
                .w(table_width(compact))
                .child(
                    text(state.to_uppercase())
                        .text_role(TextRole::Small)
                        .color(t.color("text-muted"))
                        .a11y_hidden(),
                ),
        )
}

pub fn setting_table_row_with_icon(
    icon_key: &str,
    label: &str,
    control: El,
    compact: bool,
    first: bool,
) -> El {
    let t = tokens(layout::dark());
    let mut r = row()
        .role("row")
        .full_width()
        .min_w(0.0)
        .min_h(52.0)
        .center_y()
        .separate(Space::Md)
        .px(14.0)
        .py(8.0);
    if !first {
        r = r.border_sides([1.0, 0.0, 0.0, 0.0], t.color("border-row"));
    }
    r.child(
        row()
            .role("rowheader")
            .label(label)
            .grow(1.0)
            .shrink()
            .min_w(0.0)
            .center_y()
            .separate(Space::Sm)
            .child(
                rune::icon(content_icon(icon_key), 16.0)
                    .color(t.color("text-secondary"))
                    .a11y_hidden(),
            )
            .child(
                text(label)
                    .text_role(TextRole::Mono)
                    .color(t.color("text-primary"))
                    .shrink()
                    .wrap()
                    .a11y_hidden(),
            ),
    )
    .child(el().role("cell").w(table_width(compact)).child(control))
}

fn table_header(label: &str, role: &'static str) -> El {
    col()
        .role(role)
        .label(label)
        .child(text(label).wrap().a11y_hidden())
}

pub fn checkbox_table_header_with_info(sr_label: &str, columns: [(&str, El); 3]) -> El {
    let t = tokens(layout::dark());
    let mut header = row()
        .role("row")
        .full_width()
        .min_w(0.0)
        .min_h(34.0)
        .center_y()
        .separate(Space::Sm)
        .pb(t.space(Space::Xs).px())
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-divider"))
        .child(
            col()
                .role("columnheader")
                .label(sr_label)
                .grow(1.0)
                .min_w(0.0),
        );
    for (title, info) in columns {
        header = header.child(
            row()
                .role("columnheader")
                .label(title)
                .w(108.0)
                .center()
                .separate(Space::Xxs)
                .child(
                    text(title)
                        .text_role(TextRole::Label)
                        .color(t.color("text-secondary"))
                        .a11y_hidden(),
                )
                .child(info),
        );
    }
    header
}

pub fn checkbox_table_row(label: &str, cells: [El; 3]) -> El {
    let t = tokens(layout::dark());
    row()
        .role("row")
        .full_width()
        .min_w(0.0)
        .min_h(36.0)
        .py(4.0)
        .center_y()
        .separate(Space::Sm)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-row"))
        .child(table_header(label, "rowheader").grow(1.0).min_w(0.0))
        .children(cells.map(|cell| col().role("cell").w(108.0).center().child(cell)))
}

pub fn checkbox_cell<S: 'static>(
    label: String,
    checked: bool,
    disabled: bool,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    Checkbox::new(checked)
        .label(label)
        .hide_label()
        .disabled(disabled)
        .on_toggle(toggle)
        .build(&crate::kit(layout::dark()))
}

pub fn checkbox_leading<S: 'static>(
    label: &str,
    checked: bool,
    disabled: bool,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    Checkbox::new(checked)
        .label(label)
        .disabled(disabled)
        .on_toggle(toggle)
        .build(&crate::kit(layout::dark()))
        .full_width()
        .min_w(0.0)
        .motion(rune::Spring::NONE)
}

pub fn setting_row_with_info(label: &str, info: Option<El>, control: El) -> El {
    row()
        .full_width()
        .min_w(0.0)
        .min_h(35.0)
        .py(3.0)
        .center_y()
        .justify_between()
        .separate(Space::Md)
        .child(
            row()
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .center_y()
                .separate(Space::Xs)
                .child(text(label).text_role(TextRole::Body).shrink().wrap())
                .children(info),
        )
        .child(control)
}

fn discreet_info_button<S: 'static>(
    label: &str,
    help: &str,
    open: Option<bool>,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = &*crate::kit(dark);
    let action = std::rc::Rc::new(press);
    let click = action.clone();
    let mut btn = el()
        .role("button")
        .label(label)
        .description(help)
        .help(help)
        .focusable(true)
        .size(20.0, 20.0)
        .center()
        .hover(t.color("surface-hover-overlay"))
        .child(
            text("ⓘ")
                .text_role(TextRole::Small)
                .color(t.color("text-muted"))
                .a11y_hidden(),
        )
        .on_press_tx(move |s, tx| click(s, tx))
        .on_key(layout::enter_action(action));
    if let Some(open) = open {
        btn = btn.help_open(open);
    }
    btn.focus_ring(2.0, 1.0, kit.c.border_focus)
}

pub fn info_link<S: 'static>(help: &str, open: impl Fn(&mut S, &mut rune::Tx) + 'static) -> El {
    discreet_info_button(help, help, None, open)
}

pub fn info_tip<S: 'static>(
    label: &str,
    help: &str,
    open: bool,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    discreet_info_button(label, help, Some(open), move |s, _| toggle(s))
}

pub fn setting_switch<S: 'static>(
    label: &str,
    checked: bool,
    disabled: bool,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    rune_kit::Switch::new(checked)
        .label(label)
        .hide_label()
        .disabled(disabled)
        .on_toggle(toggle)
        .build(&crate::kit(layout::dark()))
}

pub fn primary_action<S: 'static>(
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S) + 'static,
) -> El {
    primary_action_tx(label, disabled, move |s, _| press(s))
}

pub fn primary_action_tx<S: 'static>(
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    rune_kit::Button::new(label)
        .variant(rune_kit::ButtonVariant::Submit)
        .disabled(disabled)
        .on_press_tx(press)
        .build(&crate::kit(layout::dark()))
        .motion(rune::Spring::NONE)
}

/// T1-bis secondary action button for settings rows: regular weight (400), compact label size,
/// and muted ink on the bordered control surface, keeping weight 500 for primary actions.
pub fn secondary_action<S: 'static>(
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S) + 'static,
) -> El {
    secondary_action_tx(label, disabled, move |s, _| press(s))
}

pub fn secondary_action_tx<S: 'static>(
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = &*crate::kit(dark);
    let action = std::rc::Rc::new(press);
    let click = action.clone();
    let style = rune::TextStyle::new(
        t.number("font-size-xs").px(),
        t.number("font-weight-regular").px(),
    )
    .lh(t.metric("secondary", "lineHeight").px());
    let ink = if disabled {
        t.color("text-muted")
    } else {
        t.color("text-secondary")
    };
    let mut btn = el()
        .role("button")
        .label(label)
        .disabled(disabled)
        .focusable(!disabled)
        .min_h(t.number("control-height").px())
        .px(t.space(Space::Md).px())
        .center()
        .fill(t.color("surface-control"))
        .border(1.0, t.color("border-base"))
        .motion(rune::Spring::NONE)
        .child(text(label).font(style).color(ink).a11y_hidden());
    if disabled {
        btn = btn.opacity(0.55);
    } else {
        btn = btn
            .hover(t.color("surface-hover"))
            .on_press_tx(move |s, tx| click(s, tx))
            .on_key(move |s, event, tx| {
                if event.mods != rune::Mods::default() {
                    return false;
                }
                match event.key {
                    rune::Key::Enter => {
                        if !tx.key_repeat() {
                            action(s, tx);
                        }
                        true
                    }
                    rune::Key::Text(ref ch) if ch == " " => {
                        if !tx.key_repeat() {
                            action(s, tx);
                        }
                        true
                    }
                    _ => false,
                }
            });
    }
    btn.focus_ring(2.0, 2.0, kit.c.border_focus)
}

pub fn color_scheme(
    title: &str,
    mode: &str,
    segments: El,
    contrast: El,
    workbench: El,
    name_editor: Option<El>,
    error: Option<El>,
) -> El {
    let t = tokens(layout::dark());
    let mode_group = row()
        .center_y()
        .flex_wrap()
        .separate(Space::Sm)
        .child(
            text(mode)
                .text_role(TextRole::Label)
                .color(t.color("text-muted")),
        )
        .child(segments);
    col()
        .full_width()
        .separate(Space::Sm)
        .child(text(title).role("heading").text_role(TextRole::Title))
        .child(
            row()
                .full_width()
                .min_w(0.0)
                .flex_wrap()
                .center_y()
                .justify_between()
                .separate(Space::Sm)
                .pb(t.space(Space::Sm).px())
                .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-base"))
                .child(mode_group)
                .child(contrast),
        )
        .child(workbench)
        .children(name_editor)
        .children(error)
}

pub fn startup_state_card(
    title: &str,
    info: El,
    switch: El,
    clear_button: El,
    feedback: Option<(&str, bool)>,
) -> El {
    let t = tokens(layout::dark());
    let notice = feedback.map(|(message, is_error)| {
        let color = if is_error {
            t.color("status-error")
        } else {
            t.color("text-muted")
        };
        text(message)
            .role(if is_error { "alert" } else { "status" })
            .text_role(TextRole::Label)
            .color(color)
            .key("startup-state-feedback")
    });
    col()
        .key("startup-state-settings")
        .full_width()
        .separate(Space::Sm)
        .child(setting_row_with_info(title, Some(info), switch))
        .child(row().full_width().justify_end().child(clear_button))
        .children(notice)
}

pub fn contrast_controls<S: 'static>(
    label: &str,
    help: &str,
    help_open: bool,
    controls: El,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    let t = tokens(layout::dark());
    row()
        .flex_wrap()
        .center_y()
        .separate(Space::Xs)
        .child(
            text(label)
                .text_role(TextRole::Label)
                .color(t.color("text-muted")),
        )
        .child(info_tip(label, help, help_open, toggle).key("contrast-info"))
        .child(controls)
}

pub fn disclosure<S: 'static>(
    label: &str,
    open: bool,
    body: El,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    disclosure_with_meta(label, None, None, None, open, body, toggle)
}

/// D11 leading-triangle disclosure (`▸`/`▾`) with muted summary, optional count, info tip, and
/// trailing badge (e.g. "Server setting").
#[allow(clippy::too_many_arguments)]
pub fn disclosure_with_meta<S: 'static>(
    label: &str,
    count: Option<&str>,
    info: Option<El>,
    trailing: Option<El>,
    open: bool,
    body: El,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = &*crate::kit(dark);
    let toggle = std::rc::Rc::new(toggle);
    let press = toggle.clone();
    let glyph = if open {
        kit.glyph.triangle_down
    } else {
        kit.glyph.triangle_right
    };
    let mut arrow = rune::icon(glyph, 13.0).color(t.color("text-muted"));
    if !open {
        arrow = arrow.mirror_in_rtl();
    }
    let mut trigger_inner = row()
        .center_y()
        .separate(Space::Xs)
        .a11y_hidden()
        .child(el().size(16.0, 16.0).center().child(arrow))
        .child(
            text(label)
                .text_role(TextRole::Label)
                .color(t.color("text-secondary"))
                .shrink()
                .wrap(),
        );
    if let Some(count) = count {
        trigger_inner = trigger_inner.child(
            text(count)
                .text_role(TextRole::Small)
                .color(t.color("text-muted")),
        );
    }
    let trigger = row()
        .key("trigger")
        .role("button")
        .label(label)
        .expanded(open)
        .focusable(true)
        .min_h(28.0)
        .center_y()
        .hover(t.color("surface-hover-overlay"))
        .child(trigger_inner)
        .on_press(move |s| press(s))
        .on_key(move |s, event, tx| {
            if event.mods != rune::Mods::default() {
                return false;
            }
            match event.key {
                rune::Key::Enter => {
                    if !tx.key_repeat() {
                        toggle(s);
                    }
                    true
                }
                rune::Key::Text(ref ch) if ch == " " => {
                    if !tx.key_repeat() {
                        toggle(s);
                    }
                    true
                }
                _ => false,
            }
        })
        .focus_ring(2.0, 2.0, kit.c.border_focus);
    let mut header = row()
        .key("header")
        .full_width()
        .min_w(0.0)
        .center_y()
        .justify_between()
        .separate(Space::Sm)
        .child(
            row()
                .center_y()
                .shrink()
                .min_w(0.0)
                .separate(Space::Xs)
                .child(trigger)
                .children(info),
        );
    if let Some(trailing) = trailing {
        header = header.child(trailing);
    }
    let mut root = col()
        .role("group")
        .full_width()
        .min_w(0.0)
        .separate(Space::Sm)
        .motion(rune::Spring::NONE)
        .child(header);
    if open {
        root = root.child(
            col()
                .key("content")
                .role("region")
                .label(label)
                .full_width()
                .min_w(0.0)
                .child(body),
        );
    }
    root
}

fn section_icon(key: &str) -> &'static rune::Icon {
    match key {
        "settings-general" => &icons::SLIDERS_HORIZONTAL,
        "settings-conversation" => &crate::shell::icons::CONVERSATION,
        "settings-hotkeys" => &icons::KEYBOARD,
        "settings-notifications" => &crate::shell::icons::BELL,
        "settings-voice" => &icons::VOLUME_2,
        "settings-remote" => &icons::MONITOR_UP,
        "settings-opencode" => &icons::TERMINAL,
        "settings-providers" => &icons::PLUG_ZAP,
        "settings-missions" => &icons::FLAG,
        "settings-stats" => &icons::BAR_CHART_3,
        "settings-integrations" => &icons::PUZZLE,
        "settings-config-files" => &icons::FILE_COG,
        "settings-advanced" => &crate::shell::icons::SETTINGS,
        "settings-info" => &icons::INFO,
        _ => &crate::shell::icons::SETTINGS,
    }
}

fn content_icon(key: &str) -> &'static rune::Icon {
    match key {
        "thinking" => &icons::BRAIN,
        "diagnostics" => &icons::STETHOSCOPE,
        "inputs" => &icons::LOG_IN,
        "usage" => &icons::COINS,
        "system" => &icons::INFO,
        "toolgroups" => &icons::LAYERS,
        "bash" | "shell" | "terminal" => &icons::TERMINAL,
        "read" => &icons::BOOK_OPEN,
        "write" => &icons::FILE_EDIT,
        "edit" => &crate::shell::icons::PENCIL,
        "patch" => &icons::PAPERCLIP,
        "apply_patch" | "apply-patch" => &icons::LINK_2,
        "webfetch" | "web_fetch" | "websearch" => &icons::GLOBE,
        "glob" | "grep" => &crate::shell::icons::SEARCH,
        "todowrite" | "todo" | "todo_write" => &icons::CLIPBOARD_CHECK,
        "task" | "subagent" => &icons::CHECK_SQUARE,
        "execute" => &icons::CODE,
        "skill" => &icons::GRADUATION_CAP,
        "question" => &icons::HELP_CIRCLE,
        "invalid" => &crate::window_control::CLOSE,
        _ => &icons::LAYOUT_GRID,
    }
}

mod icons {
    use rune::Icon;

    pub static CHEVRON_UP: Icon = Icon {
        name: "lucide-chevron-up",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></g>"#,
    };
    pub static SLIDERS_HORIZONTAL: Icon = Icon {
        name: "lucide-sliders-horizontal",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/></g>"#,
    };
    pub static KEYBOARD: Icon = Icon {
        name: "lucide-keyboard",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/></g>"#,
    };
    pub static VOLUME_2: Icon = Icon {
        name: "lucide-volume-2",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/></g>"#,
    };
    pub static MONITOR_UP: Icon = Icon {
        name: "lucide-monitor-up",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 10 3-3 3 3"/><path d="M12 13V7"/><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M12 17v4"/><path d="M8 21h8"/></g>"#,
    };
    pub static TERMINAL: Icon = Icon {
        name: "lucide-terminal",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></g>"#,
    };
    pub static PLUG_ZAP: Icon = Icon {
        name: "lucide-plug-zap",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="m2 22 3-3"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m18 3-4 4h6l-4 4"/></g>"#,
    };
    pub static FLAG: Icon = Icon {
        name: "lucide-flag",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></g>"#,
    };
    pub static BAR_CHART_3: Icon = Icon {
        name: "lucide-bar-chart-3",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></g>"#,
    };
    pub static PUZZLE: Icon = Icon {
        name: "lucide-puzzle",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/></g>"#,
    };
    pub static FILE_COG: Icon = Icon {
        name: "lucide-file-cog",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M4.677 21.5a2 2 0 0 0 1.313.5H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v2.5"/><circle cx="6" cy="14" r="3"/><path d="m3.2 12.9-.9-.4"/><path d="m3.2 15.1-.9.4"/><path d="m4.9 11.2-.4-.9"/><path d="m4.9 16.8-.4.9"/><path d="m7.5 10.3-.4.9"/><path d="m7.5 17.7-.4-.9"/><path d="m9.7 12.5-.9.4"/><path d="m9.7 15.5-.9-.4"/></g>"#,
    };
    pub static INFO: Icon = Icon {
        name: "lucide-info",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></g>"#,
    };
    pub static LANGUAGES: Icon = Icon {
        name: "lucide-languages",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></g>"#,
    };
    pub static SHIELD_CHECK: Icon = Icon {
        name: "lucide-shield-check",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></g>"#,
    };
    pub static CHECK: Icon = Icon {
        name: "lucide-check",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></g>"#,
    };
    pub static TRASH_2: Icon = Icon {
        name: "lucide-trash-2",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></g>"#,
    };
    pub static BRAIN: Icon = Icon {
        name: "lucide-brain",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/></g>"#,
    };
    pub static STETHOSCOPE: Icon = Icon {
        name: "lucide-stethoscope",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/></g>"#,
    };
    pub static LOG_IN: Icon = Icon {
        name: "lucide-log-in",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></g>"#,
    };
    pub static COINS: Icon = Icon {
        name: "lucide-coins",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></g>"#,
    };
    pub static LAYERS: Icon = Icon {
        name: "lucide-layers",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></g>"#,
    };
    pub static BOOK_OPEN: Icon = Icon {
        name: "lucide-book-open",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></g>"#,
    };
    pub static FILE_EDIT: Icon = Icon {
        name: "lucide-file-pen-line",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 5-2.414-2.414A2 2 0 0 0 14.172 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2"/><path d="M21.378 12.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/><path d="M8 18h1"/></g>"#,
    };
    pub static PAPERCLIP: Icon = Icon {
        name: "lucide-paperclip",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></g>"#,
    };
    pub static LINK_2: Icon = Icon {
        name: "lucide-link-2",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></g>"#,
    };
    pub static GLOBE: Icon = Icon {
        name: "lucide-globe",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></g>"#,
    };
    pub static CLIPBOARD_CHECK: Icon = Icon {
        name: "lucide-clipboard-check",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></g>"#,
    };
    pub static CHECK_SQUARE: Icon = Icon {
        name: "lucide-square-check",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/></g>"#,
    };
    pub static CODE: Icon = Icon {
        name: "lucide-code",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></g>"#,
    };
    pub static GRADUATION_CAP: Icon = Icon {
        name: "lucide-graduation-cap",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/></g>"#,
    };
    pub static HELP_CIRCLE: Icon = Icon {
        name: "lucide-circle-help",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></g>"#,
    };
    pub static LAYOUT_GRID: Icon = Icon {
        name: "lucide-layout-grid",
        view: 24.0,
        body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></g>"#,
    };
}

#[cfg(test)]
#[test]
fn stepping_picker_steps_while_closed_and_opens_with_alt_down() {
    #[derive(Default)]
    struct State {
        open: bool,
        selected: usize,
    }
    const OPTIONS: [&str; 3] = ["One", "Two", "Three"];
    fn view(s: &State, cx: &mut Cx<State>) -> El {
        layout::render(cx, |_| {
            let mut layers = Vec::new();
            let trigger = build_picker(
                stepping_picker("step", "Choice", &OPTIONS)
                    .current(Some(OPTIONS[s.selected]))
                    .open(s.open)
                    .on_toggle(|s: &mut State| s.open = !s.open)
                    .on_close(|s: &mut State| s.open = false)
                    .on_choose(|s: &mut State, value, _| {
                        s.open = false;
                        if let Some(index) = OPTIONS.iter().position(|&v| v == value) {
                            s.selected = index;
                        }
                    }),
                &mut layers,
            );
            col().w_full().h_full().child(trigger).children(layers)
        })
    }
    let mut rt = rune::Runtime::new(
        State::default(),
        view,
        (320.0, 240.0),
        rune::Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.update(|_, tx| tx.focus("step-trigger", true));
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Down,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert!(!rt.state.open);
    assert_eq!(rt.state.selected, 1);

    rt.key(rune::KeyEvent {
        key: rune::Key::Up,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert!(!rt.state.open);
    assert_eq!(rt.state.selected, 0);

    rt.key(rune::KeyEvent {
        key: rune::Key::Down,
        mods: rune::Mods {
            alt: true,
            ..Default::default()
        },
    });
    rt.frame(0.02);
    assert!(rt.state.open);
}

#[test]
fn binary_row_item_exposes_path_to_accessibility_for_duplicate_labels() {
    fn view(_: &(), cx: &mut rune::Cx<()>) -> El {
        layout::render(cx, |_| {
            binary_list([
                binary_row_item(
                    "opencode",
                    Some("/usr/local/bin/opencode"),
                    None,
                    true,
                    false,
                    "bin-1".into(),
                    |_: &mut ()| {},
                    None::<(String, &str, fn(&mut ()))>,
                ),
                binary_row_item(
                    "opencode",
                    Some("/opt/alt/bin/opencode"),
                    None,
                    false,
                    false,
                    "bin-2".into(),
                    |_: &mut ()| {},
                    None::<(String, &str, fn(&mut ()))>,
                ),
            ])
        })
    }

    let mut rt = rune::Runtime::new((), view, (480.0, 240.0), rune::Env::new(false, 1.0));
    rt.frame(0.0);
    let a11y = rt.accessibility_json().to_string();
    assert!(
        a11y.contains("/usr/local/bin/opencode") && a11y.contains("/opt/alt/bin/opencode"),
        "binary paths must remain visible in accessibility output: {a11y}"
    );
}

#[test]
fn secondary_action_responds_once_to_click_enter_and_space_and_is_inert_when_disabled() {
    #[derive(Default)]
    struct State {
        enabled_hits: usize,
        disabled_hits: usize,
    }

    fn view(_: &State, cx: &mut rune::Cx<State>) -> El {
        layout::render(cx, |_| {
            col()
                .w_full()
                .h_full()
                .child(
                    secondary_action("Refresh", false, |s: &mut State| s.enabled_hits += 1)
                        .key("sec-enabled"),
                )
                .child(
                    secondary_action("Reset", true, |s: &mut State| s.disabled_hits += 1)
                        .key("sec-disabled"),
                )
        })
    }

    let mut rt = rune::Runtime::new(
        State::default(),
        view,
        (320.0, 200.0),
        rune::Env::new(false, 1.0),
    );
    rt.frame(0.0);

    let (x, y) = rt.find("sec-enabled").expect("enabled button");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert_eq!(rt.state.enabled_hits, 1);

    rt.update(|_, tx| tx.focus("sec-enabled", true));
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Enter,
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert_eq!(rt.state.enabled_hits, 2);

    rt.key(rune::KeyEvent {
        key: rune::Key::Text(" ".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    assert_eq!(rt.state.enabled_hits, 3);

    let (dx, dy) = rt.find("sec-disabled").expect("disabled button");
    rt.pointer_down(dx, dy);
    rt.pointer_up(dx, dy);
    rt.frame(0.02);
    assert_eq!(rt.state.disabled_hits, 0);
}
