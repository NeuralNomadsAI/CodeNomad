use crate::{
    Space, field_kit, kit,
    layout::{self, Layout, dark},
};
pub use rune::Icon as Glyph;
use rune::{El, Phase, Tx, edit::TextEdit, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, SegmentedControl, Select,
    SelectAppearance, State,
};

pub enum ButtonLook {
    Neutral,
    Flat,
    FlatWithHelp(String),
    Submit,
    WithIcon(&'static Glyph),
}

pub fn button<S: 'static>(
    label: impl Into<String>,
    look: ButtonLook,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let mut button = Button::new(label).disabled(disabled).on_press_tx(press);
    button = match look {
        ButtonLook::Neutral => button,
        ButtonLook::Flat => button.variant(ButtonVariant::Ghost),
        ButtonLook::FlatWithHelp(help) => button.variant(ButtonVariant::Ghost).help(help),
        ButtonLook::Submit => button.variant(ButtonVariant::Submit),
        ButtonLook::WithIcon(glyph) => button.variant(ButtonVariant::Ghost).icon(glyph),
    };
    button.build(&kit(dark()))
}

pub fn icon_button<S: 'static>(
    glyph: &'static Glyph,
    name: impl Into<String>,
    disabled: bool,
    active: Option<bool>,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let name = name.into();
    let button = IconButton::new(glyph)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .label(name.clone())
        .help(name)
        .state(if disabled {
            State::Disabled
        } else if active == Some(true) {
            State::Pressed
        } else {
            State::Rest
        })
        .on_press_tx(press)
        .build(&kit(dark()));
    match active {
        Some(active) => button.checked(active),
        None => button,
    }
}

pub fn overflow_trigger(label: &str) -> El {
    IconButton::new(&super::MORE_HORIZONTAL)
        .label(label)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .build(&kit(dark()))
}

pub fn compact_file_actions(width: f32, label: &str) -> bool {
    let t = crate::tokens(dark());
    let button = t.metric("fileRowAction", "minWidth").px();
    let font = t.text(crate::TextRole::Label).size;
    // Until Rune exposes intrinsic text width, use the UI face's average advance.
    width < 3.0 * button + label.chars().count() as f32 * font * 0.55
}

pub fn modes<S: 'static>(
    labels: &[&str],
    title: &str,
    selected: Option<usize>,
    select: impl Fn(&mut S, usize, &mut Tx) + Clone + 'static,
) -> El {
    SegmentedControl::new(labels, selected)
        .label(title)
        .width(None)
        .on_pick(select)
        .build(&kit(dark()))
}

pub fn fit_modes<S: 'static>(
    labels: &[&str],
    title: &str,
    selected: Option<usize>,
    panel_width: f32,
    select: impl Fn(&mut S, usize, &mut Tx) + Clone + 'static,
) -> El {
    let dark = dark();
    let t = crate::tokens(dark);
    let kit = kit(dark);
    // The Kit's fit mode makes equal columns; Solid sizes each segment to its own label.
    let metric = |name| t.metric("gitModeButton", name).px();
    let border = t.metric("gitModes", "borderTopWidth").px();
    let divider = t.metric("gitModeDivider", "borderInlineStartWidth").px();
    let edge = t.color("border-base");
    let font =
        rune::TextStyle::new(metric("fontSize"), metric("fontWeight")).lh(metric("lineHeight"));
    row()
        .role("radiogroup")
        .focus_group()
        .label(title)
        .max_w(super::selector_width(panel_width).max(0.0))
        .border(border, edge)
        .border_layout()
        .children(labels.iter().enumerate().map(|(i, &label)| {
            let pick = select.clone();
            let active = selected == Some(i);
            let segment = row()
                .key(format!("segment{i}"))
                .role("radio")
                .label(label)
                .position_in_set(i + 1, labels.len())
                .focusable(true)
                .focus_selected(active)
                .shrink()
                .px(metric("paddingLeft"))
                .py(metric("paddingTop"))
                .border_sides([0.0, 0.0, 0.0, if i == 0 { 0.0 } else { divider }], edge)
                .border_layout()
                .child(
                    text(label)
                        .font(font)
                        .color(t.color(if active { "text-primary" } else { "text-muted" }))
                        .truncate()
                        .shrink()
                        .a11y_hidden(),
                )
                .on_press_tx(move |s, tx| pick(s, i, tx));
            let segment = segment.focus_ring(border, -border, t.color("focus-ring-color"));
            if active {
                segment.fill(t.color("selection-neutral-strong-bg"))
            } else {
                kit.interactive(segment)
            }
        }))
}

pub fn section_button<S: 'static>(
    name: &str,
    count: usize,
    open: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = crate::tokens(dark());
    let title = |property| t.metric("gitSectionTitle", property).px();
    let chip = |property| t.metric("gitSectionCount", property).px();
    let title_font =
        rune::TextStyle::new(title("fontSize"), title("fontWeight")).lh(title("lineHeight"));
    let label = format!("{name} · {count}");
    let name = name.to_owned();
    let counter = text(count.to_string())
        .font(
            rune::TextStyle::new(chip("fontSize"), t.number("font-weight-regular").px())
                .lh(chip("lineHeight")),
        )
        .color(t.color("text-muted"))
        .fill(t.color("surface-inset"))
        .radius(t.number("chip-radius").px())
        .opacity(chip("opacity"))
        .px(chip("paddingLeft"))
        .py(chip("paddingTop"))
        .border(chip("borderTopWidth"), t.color("border-base"))
        .border_layout();
    Button::new(label)
        .variant(ButtonVariant::GhostMuted)
        .control_size(ControlSize::Regular)
        .expanded(open)
        .label_with(move |_, ink| {
            row()
                .full_width()
                .items_center()
                .gap(t.metric("gitSection", "columnGap").px())
                .child(
                    rune::icon(
                        if open {
                            &super::CHEVRON_DOWN
                        } else {
                            &super::CHEVRON_RIGHT
                        },
                        t.length(crate::Length::Icon).px(),
                    )
                    .color(ink),
                )
                .child(
                    text(name)
                        .key("git-section-title")
                        .font(title_font)
                        .color(ink)
                        .truncate()
                        .remaining(),
                )
                .child(counter)
        })
        .on_press_tx(press)
        .build(&kit(dark()))
        .full_width()
}

pub fn worktree_picker<S: 'static>(
    labels: &[String],
    current: Option<&str>,
    name: &str,
    directory: Option<&str>,
    width: f32,
    open: bool,
    disabled: bool,
    toggle: impl Fn(&mut S) + 'static,
    close: impl Fn(&mut S) + 'static,
    choose: impl Fn(&mut S, &str, &mut Tx) + Clone + 'static,
    overlay: &mut Vec<El>,
) -> El {
    let picker = Select::new("git-worktree", labels)
        .current(current)
        .label(name)
        .appearance(SelectAppearance::Field)
        .width(super::selector_width(width))
        .open(open)
        .disabled(disabled)
        .step_closed(true)
        .on_toggle(toggle)
        .on_close(close)
        .on_choose(choose);
    let trigger = crate::settings::build_picker(picker, overlay);
    // Select has no help builder; set the accessible description on its trigger explicitly.
    match directory {
        Some(directory) => trigger.help(directory).description(directory),
        None => trigger,
    }
}

pub fn session_worktree_picker<S: 'static>(
    labels: &[String],
    current: Option<&str>,
    name: &str,
    unavailable: &str,
    open: bool,
    disabled: bool,
    toggle: impl Fn(&mut S) + 'static,
    close: impl Fn(&mut S) + 'static,
    choose: impl Fn(&mut S, &str, &mut Tx) + Clone + 'static,
    overlays: &mut Vec<El>,
) -> El {
    Select::new("session-worktree", labels)
        .label(name)
        .placeholder(unavailable)
        .current(current)
        .open(open)
        .disabled(disabled)
        .step_closed(true)
        .on_toggle(toggle)
        .on_close(close)
        .on_choose(choose)
        .build(&kit(dark()), overlays)
        .shrink()
}

pub fn commit_message<S: 'static>(
    text: &TextEdit,
    label: &str,
    edit: impl Fn(&mut S) -> &mut TextEdit + 'static,
) -> El {
    layout::textarea(text)
        .label(label)
        .placeholder(label)
        .on_edit(edit)
        .build(&field_kit(dark()))
        .remaining()
}

pub fn file<S: 'static>(
    path: String,
    kind: String,
    counts: Option<(u64, u64)>,
    help: String,
    disabled: bool,
    selected: bool,
    click: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let label = counts.map_or_else(
        || format!("{kind} {path}"),
        |(a, d)| format!("{kind} {path} +{a} −{d}"),
    );
    Button::new(label)
        .variant(ButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .help(help)
        .disabled(disabled)
        .on_press_tx(click)
        .label_with(move |font, ink| {
            row()
                .full_width()
                .items_center()
                .separate(Space::Sm)
                .child(text(kind).font(font).color(ink))
                .child(
                    text(path)
                        .font(font)
                        .color(ink)
                        .truncate()
                        .remaining()
                        .shrink()
                        .literal_direction(),
                )
                .child(counts.map_or_else(rune::el, |(plus, minus)| super::changes(plus, minus)))
        })
        .build(&kit(dark()))
        .remaining()
        .shrink()
        .checked(selected)
}

pub fn with_file_drop<S: 'static>(
    button: El,
    drop: impl Fn(&mut S, [f32; 2], &mut Tx) + 'static,
) -> El {
    button.on_drag(move |s, drag, tx| {
        if drag.phase == Phase::Move {
            drag.data = 1.0;
        }
        if drag.phase == Phase::Up && !drag.cancelled() && drag.data != 0.0 {
            drop(s, drag.window_point(), tx);
        }
    })
}
