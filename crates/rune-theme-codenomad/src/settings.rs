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
    let kit = &*crate::kit(dark);
    let mut sidebar = Sidebar::new()
        .inset(tokens(dark).space(Space::Sm).px())
        .header(heading(title))
        .label(label);
    for (key, label, selected) in sections {
        let select = select.clone();
        sidebar = sidebar.child(
            SidebarRow::new(label)
                .selected(selected)
                .on_select(move |s, _| select(s, key))
                .build(kit)
                .key(key),
        );
    }
    sidebar.build(kit)
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

pub fn narrow_header<S: 'static>(
    title: &str,
    back: Option<(&str, &str, bool, impl Fn(&mut S, &mut rune::Tx) + 'static)>,
    close_label: &str,
    touch: bool,
    on_close: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let height = if touch {
        t.length(crate::Length::Chrome).px().max(48.0)
    } else {
        t.length(crate::Length::Chrome).px()
    };
    let mut bar = row()
        .key("settings-narrow-header")
        .full_width()
        .min_w(0.0)
        .center_y()
        .h(height)
        .fill(t.color("surface-chrome"))
        .px(t.space(Space::Sm).px())
        .separate(Space::Sm)
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-divider"));
    if let Some((back_label, back_help, rtl, on_back)) = back {
        let glyph = if rtl {
            &crate::shell::icons::FORWARD
        } else {
            &crate::shell::icons::BACK
        };
        bar = bar.child(
            header_icon_button(glyph, back_label, back_help, touch, on_back)
                .key("settings-narrow-back"),
        );
    }
    bar.child(
        text(title)
            .role("heading")
            .text_role(TextRole::Title)
            .grow(1.0)
            .shrink()
            .truncate(),
    )
    .child(
        header_icon_button(
            &crate::window_control::CLOSE,
            close_label,
            close_label,
            touch,
            on_close,
        )
        .key("settings-close"),
    )
}

pub fn narrow_nav<S: 'static>(
    label: &str,
    sections: impl IntoIterator<Item = (&'static str, &'static str, bool)>,
    touch: bool,
    rtl: bool,
    select: impl Fn(&mut S, &'static str, &mut rune::Tx) + Clone + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = &*crate::kit(dark);
    let row_height = if touch { 44.0 } else { 36.0 };
    let chevron_glyph = if rtl {
        &crate::shell::icons::BACK
    } else {
        &crate::git_panel::CHEVRON_RIGHT
    };
    let mut list = col()
        .key("settings-narrow-list")
        .role("list")
        .label(label)
        .focus_group()
        .full_width()
        .min_w(0.0)
        .pad(Space::Sm)
        .separate(Space::Xxs);
    for (key, row_label, selected) in sections {
        let select = select.clone();
        let chevron = rune::icon(chevron_glyph, 14.0)
            .color(t.color("text-muted"))
            .a11y_hidden();
        list = list.child(
            SidebarRow::new(row_label)
                .height(row_height)
                .trailing(chevron)
                .selected(selected)
                .on_select(move |s, tx| select(s, key, tx))
                .build(kit)
                .key(key),
        );
    }
    col()
        .key("settings-narrow-scroll")
        .full_width()
        .min_w(0.0)
        .remaining()
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
        .child(list)
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

pub fn narrow_list_screen(header: El, list: El) -> El {
    col()
        .full_width()
        .full_height()
        .min_w(0.0)
        .child(header)
        .child(list)
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
    let kit = &*crate::kit(dark);
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
            let mut button = rune_kit::Button::new(option)
                .disabled(disabled)
                .on_press_tx(move |s: &mut S, tx| press(s, tx));
            if active {
                button = button.variant(rune_kit::ButtonVariant::Submit);
            }
            let button = button
                .build(kit)
                .min_h(44.0)
                .key(format!("transcript-preset-{index}"))
                .checked(active);
            #[cfg(target_arch = "wasm32")]
            let button = match (active, disabled) {
                (true, true) => button.description(format!("{active_tag}, {disabled_tag}")),
                (true, false) => button.description(active_tag),
                (false, true) => button.description(disabled_tag),
                (false, false) => button,
            };
            #[cfg(not(target_arch = "wasm32"))]
            let _ = (active_tag, disabled_tag);
            if disabled {
                button
            } else {
                button.on_key(layout::enter_action(action))
            }
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

const PICKER_WIDTH: f32 = 180.0;
const COMPACT_PICKER_WIDTH: f32 = 136.0;
const PALETTE_PICKER_WIDTH: f32 = 160.0;

fn table_width(compact: bool) -> f32 {
    if compact {
        COMPACT_PICKER_WIDTH
    } else {
        PICKER_WIDTH
    }
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
    table_picker(key, label, options, false)
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

pub fn binary_row(button: El, path: Option<&str>, caption: Option<&str>, remove: Option<El>) -> El {
    let mut info = col().grow(1.0).shrink().child(button);
    if let Some(path) = path {
        info = info.child(
            text(path)
                .text_role(TextRole::Small)
                .literal_direction()
                .truncate(),
        );
    }
    if let Some(caption) = caption {
        info = info.child(text(caption).text_role(TextRole::Small).role("status"));
    }
    let mut line = row()
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .child(info);
    if let Some(remove) = remove {
        line = line.child(remove);
    }
    line
}

pub fn setting_row(label: &str, control: El) -> El {
    setting_row_with_info(label, None, control)
}

pub fn setting_table_header(item: &str, state: &str, compact: bool) -> El {
    let t = tokens(layout::dark());
    row()
        .role("row")
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .py(t.space(Space::Xs).px())
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-divider"))
        .child(table_header(item, "columnheader").grow(1.0))
        .child(table_header(state, "columnheader").w(table_width(compact)))
}

pub fn setting_table_row(label: &str, control: El, compact: bool) -> El {
    let t = tokens(layout::dark());
    row()
        .role("row")
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .py(t.space(Space::Xs).px())
        .border_sides([0.0, 0.0, 1.0, 0.0], t.color("border-divider"))
        .child(table_header(label, "rowheader").grow(1.0))
        .child(el().role("cell").w(table_width(compact)).child(control))
}

fn table_header(label: &str, role: &'static str) -> El {
    col()
        .role(role)
        .label(label)
        .child(text(label).wrap().a11y_hidden())
}

pub fn checkbox_table_header(label: &str, columns: [&str; 3]) -> El {
    checkbox_row(
        table_header(label, "columnheader"),
        columns.map(|column| table_header(column, "columnheader")),
        false,
    )
}

pub fn checkbox_table_row(label: &str, cells: [El; 3]) -> El {
    checkbox_row(table_header(label, "rowheader"), cells, true)
}

fn checkbox_row(label: El, cells: [El; 3], body: bool) -> El {
    let tokens = tokens(layout::dark());
    row()
        .role("row")
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .child(label.grow(1.0))
        .children(cells.map(|cell| {
            let column = col().w(tokens.space(Space::Lg).px() * 3.0).center();
            if body {
                column.role("cell").child(cell)
            } else {
                column.child(cell)
            }
        }))
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

pub fn setting_row_with_info(label: &str, info: Option<El>, control: El) -> El {
    layout::action_row()
        .min_w(0.0)
        .justify_between()
        .child(
            row()
                .center_y()
                .shrink()
                .min_w(0.0)
                .separate(Space::Xs)
                .child(text(label).text_role(TextRole::Button).shrink().wrap())
                .children(info),
        )
        .child(control)
}

pub fn info_link<S: 'static>(help: &str, open: impl Fn(&mut S, &mut rune::Tx) + 'static) -> El {
    layout::button_tx("ⓘ", false, open).label(help).help(help)
}

pub fn info_tip<S: 'static>(
    label: &str,
    help: &str,
    open: bool,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    layout::button("ⓘ", false, toggle)
        .label(label)
        .description(help)
        .help(help)
        .help_open(open)
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
    col()
        .full_width()
        .separate(Space::Sm)
        .child(text(title).role("heading").text_role(TextRole::Button))
        .child(
            layout::action_row()
                .child(text(mode))
                .child(segments)
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
    row()
        .flex_wrap()
        .center_y()
        .separate(Space::Xs)
        .child(text(label))
        .child(
            layout::button("ⓘ", false, toggle)
                .key("contrast-info")
                .label(label)
                .help(help)
                .help_open(help_open),
        )
        .child(controls)
}

pub fn disclosure<S: 'static>(
    label: &str,
    open: bool,
    body: El,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    let toggle = std::rc::Rc::new(toggle);
    let press = toggle.clone();
    rune_kit::Collapsible::new(label, open)
        .child(body)
        .on_toggle(move |s| press(s))
        .build(&crate::kit(layout::dark()))
        .on_key(move |s, event, tx| {
            if tx.focused() != Some("trigger")
                || event.key != rune::Key::Enter
                || event.mods != rune::Mods::default()
            {
                return false;
            }
            if !tx.key_repeat() {
                toggle(s);
            }
            true
        })
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
