//! Preferences geometry follows settings-screen.css and the native Preferences bounds.
use crate::{
    Space, TextRole,
    layout::{self, Layout},
    tokens,
};
use rune::{AppSpec, Cx, El, ScrollSpec, col, el, row, text};
use rune_kit::{SegmentedControl, Select, SelectAppearance, Sidebar, SidebarRow};

pub const WINDOW_SIZE: (f32, f32) = (1100.0, 760.0);
pub const WINDOW_MIN: (f32, f32) = (760.0, 560.0);

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

pub fn shell_entry(tabs: El, entry: El) -> El {
    row()
        .full_width()
        .child(tabs.grow(1.0).shrink())
        .child(entry)
}

pub fn nav<S: 'static>(
    title: &str,
    label: &str,
    sections: impl IntoIterator<Item = (&'static str, &'static str, bool)>,
    select: impl Fn(&mut S, &'static str) + Clone + 'static,
) -> El {
    let dark = layout::dark();
    let kit = crate::kit(dark);
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
    control.build(crate::kit(layout::dark()))
}

pub fn picker(key: &str, label: &str, options: &[&str]) -> Select {
    Select::new(key, options)
        .label(label)
        .width(180.0)
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
    dismiss: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let dark = layout::dark();
    let theme = tokens(dark);
    let body = col()
        .key("transcript-filters")
        .role("dialog")
        .label(label)
        .focus_group()
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
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(content),
        );
    rune_kit::popover::anchored(
        crate::kit(dark),
        body,
        trigger,
        rune_kit::Placement::BottomEnd,
        6.0,
    )
}

pub fn transcript_preset_picker(key: &str, label: &str, options: &[&str]) -> Select {
    picker(key, label, options).width(272.0)
}

pub fn transcript_filter_row<S: 'static>(
    label: &str,
    visibility: (&str, bool, impl Fn(&mut S, &mut rune::Tx) + 'static),
    expansion: (&str, bool, impl Fn(&mut S, &mut rune::Tx) + 'static),
    disabled: bool,
) -> El {
    use crate::git_panel::{CHEVRON_DOWN, CHEVRON_RIGHT, EYE, icon_button};
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
        .child(
            icon_button(
                &EYE,
                visibility_name,
                disabled,
                Some(visible),
                set_visibility,
            )
            .key("visibility"),
        )
        .child(
            icon_button(
                if expanded {
                    &CHEVRON_DOWN
                } else {
                    &CHEVRON_RIGHT
                },
                expansion_name,
                disabled || !visible,
                Some(expanded),
                set_expansion,
            )
            .key("expansion"),
        )
}

pub fn render<S, T>(
    cx: &mut Cx<S>,
    dark: bool,
    palette: Option<&'static crate::palettes::Palette>,
    build: impl FnOnce(&mut Cx<S>) -> T,
) -> T {
    crate::palettes::with_palette(palette, || {
        cx.foreground(tokens(dark).color("text-primary"));
        layout::with_appearance(dark, || build(cx))
    })
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

pub fn setting_row(label: &str, control: El) -> El {
    setting_row_with_info(label, None, control)
}

pub fn setting_row_with_info(label: &str, info: Option<El>, control: El) -> El {
    layout::action_row()
        .justify_between()
        .child(
            row()
                .center_y()
                .separate(Space::Xs)
                .child(text(label).text_role(TextRole::Button))
                .children(info),
        )
        .child(control)
}

pub fn info_link<S: 'static>(help: &str, open: impl Fn(&mut S, &mut rune::Tx) + 'static) -> El {
    layout::button_tx("ⓘ", false, open).label(help).help(help)
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
        .build(crate::kit(layout::dark()))
}

pub fn color_scheme(title: &str, mode: &str, segments: El, contrast: El, picker: El) -> El {
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
        .child(picker)
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
    rune_kit::Collapsible::new(label, open)
        .child(body)
        .on_toggle(toggle)
        .build(crate::kit(layout::dark()))
}
