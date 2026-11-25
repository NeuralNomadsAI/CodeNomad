//! Palette swatch strip, responsive workbench layout, and interactive color editor chrome.
use crate::{
    Space, TextRole,
    layout::{self, Layout},
    palettes::parse_rgb,
    tokens,
};
use rune::{Color, El, TextEdit, col, el, row, text};
use rune_kit::{Slider, TextInput};

const PICKER_WIDTH: f32 = 160.0;
const SWATCH_COUNT: f32 = 13.0;
const SWATCH_TARGET_DESKTOP: f32 = 24.0;
const SWATCH_TARGET_TOUCH: f32 = 40.0;
const SWATCH_INNER: f32 = 18.0;
const SWATCH_GAP: f32 = 2.0;
const SWATCH_PAD: f32 = 6.0;
const EDITOR_WIDTH: f32 = 280.0;
const SLIDER_WIDTH: f32 = 176.0;
const PREVIEW_SIZE: f32 = 20.0;

pub struct SwatchItem<'a> {
    pub key: &'static str,
    pub hex: &'a str,
    pub label: &'a str,
    pub accessible_label: String,
    pub selected: bool,
    pub disabled: bool,
}

/// Computes whether the 13-swatch strip still fits beside the picker and trailing actions,
/// matching `palette-strip-fit.ts` rather than a fixed breakpoint.
pub fn workbench_stacked(workbench_width: f32, actions_width: f32, coarse: bool) -> bool {
    if workbench_width <= 0.0 {
        return false;
    }
    let gap = tokens(layout::dark()).space(Space::Sm).px();
    let target = if coarse {
        SWATCH_TARGET_TOUCH
    } else {
        SWATCH_TARGET_DESKTOP
    };
    let strip = SWATCH_COUNT * target + (SWATCH_COUNT - 1.0) * SWATCH_GAP + SWATCH_PAD;
    PICKER_WIDTH + strip + actions_width + 2.0 * gap > workbench_width
}

pub fn workbench(picker: El, swatches: Option<El>, actions: El, stacked: bool) -> El {
    let actions = actions.key("palette-actions");
    let content = if stacked {
        col()
            .full_width()
            .separate(Space::Sm)
            .child(
                row()
                    .full_width()
                    .center_y()
                    .separate(Space::Sm)
                    .child(el().min_w(PICKER_WIDTH).grow(1.0).shrink().child(picker))
                    .child(actions),
            )
            .children(swatches)
    } else {
        row()
            .full_width()
            .center_y()
            .separate(Space::Sm)
            .child(el().w(PICKER_WIDTH).child(picker))
            .children(swatches.map(|strip| el().grow(1.0).shrink().child(strip)))
            .child(actions)
    };
    el().key("palette-workbench").full_width().child(content)
}

pub fn action_bar(buttons: impl IntoIterator<Item = El>, stacked: bool) -> El {
    let bar = row()
        .center_y()
        .justify_end()
        .separate(Space::Xs)
        .children(buttons);
    if stacked { bar.flex_wrap() } else { bar }
}

fn srgb_u8_color(rgb: [u8; 3]) -> Color {
    let linear = |c: u8| {
        let n = f32::from(c) / 255.0;
        if n <= 0.04045 {
            n / 12.92
        } else {
            ((n + 0.055) / 1.055).powf(2.4)
        }
    };
    Color {
        r: linear(rgb[0]),
        g: linear(rgb[1]),
        b: linear(rgb[2]),
        a: 1.0,
    }
}

pub fn swatch_strip<S: 'static>(
    items: &[SwatchItem<'_>],
    stacked: bool,
    coarse: bool,
    on_pick: impl Fn(&mut S, usize) + Clone + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let target = if coarse {
        SWATCH_TARGET_TOUCH
    } else {
        SWATCH_TARGET_DESKTOP
    };
    let border_rest = t.color("border-base");
    let border_selected = t.color("accent-primary");
    let mut strip = row()
        .key("palette-swatches")
        .center_y()
        .gap(SWATCH_GAP)
        .padding(3.0);
    if stacked {
        strip = strip.full_width().flex_wrap();
    }
    for (index, item) in items.iter().enumerate() {
        let fill = srgb_u8_color(parse_rgb(item.hex).unwrap_or([0, 0, 0]));
        let swatch = el().w(SWATCH_INNER).h(SWATCH_INNER).fill(fill).border(
            if item.selected { 2.0 } else { 1.0 },
            if item.selected {
                border_selected
            } else {
                border_rest
            },
        );
        let mut cell = el()
            .key(format!("palette-swatch-{}", item.key))
            .w(target)
            .h(target)
            .center()
            .role("button")
            .label(item.accessible_label.clone())
            .help(item.label)
            .disabled(item.disabled)
            .child(swatch);
        if !item.disabled {
            let press = on_pick.clone();
            let key_press = on_pick.clone();
            cell = cell
                .focusable(true)
                .on_press(move |s: &mut S| press(s, index))
                .on_key(move |s: &mut S, event, tx| {
                    if event.mods != rune::Mods::default() || tx.key_repeat() {
                        return false;
                    }
                    if event.key == rune::Key::Enter {
                        key_press(s, index);
                        return true;
                    }
                    false
                });
        }
        strip = strip.child(cell);
    }
    strip
}

#[allow(clippy::too_many_arguments)]
pub fn color_editor<S: 'static>(
    title: &str,
    hex: &str,
    rgb: [u8; 3],
    hex_input: &TextEdit,
    close_label: &str,
    on_hex_edit: impl Fn(&mut S) -> &mut TextEdit + 'static,
    on_hex_change: impl Fn(&mut S) + 'static,
    on_channel: impl Fn(&mut S, usize, u8) + Clone + 'static,
    on_close: impl Fn(&mut S) + Clone + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let kit = crate::kit(dark);
    let field_kit = crate::field_kit(dark);
    let preview = el()
        .w(PREVIEW_SIZE)
        .h(PREVIEW_SIZE)
        .fill(srgb_u8_color(rgb))
        .border(1.0, t.color("border-base"));
    let close_modal = on_close.clone();
    let close_btn = on_close;
    let hex_field = TextInput::new(hex_input)
        .label(title)
        .placeholder("#RRGGBB")
        .on_edit(on_hex_edit)
        .on_change(move |s: &mut S, _| on_hex_change(s))
        .build(&field_kit)
        .key("palette-color-hex");
    let channels = [("R", 0usize), ("G", 1usize), ("B", 2usize)].map(|(name, idx)| {
        let on_channel = on_channel.clone();
        let value = rgb[idx];
        row()
            .full_width()
            .center_y()
            .separate(Space::Xs)
            .child(text(name).text_role(TextRole::Mono).w(16.0))
            .child(
                Slider::new(format!("palette-channel-{name}"), f32::from(value))
                    .range(0.0..=255.0)
                    .step(1.0)
                    .width(SLIDER_WIDTH)
                    .label(format!("{title} {name}"))
                    .hide_label()
                    .value_text(value.to_string())
                    .on_change(move |s: &mut S, next, _| {
                        on_channel(s, idx, next.round().clamp(0.0, 255.0) as u8);
                    })
                    .build(&kit),
            )
            .child(text(format!("{value:3}")).text_role(TextRole::Mono).w(28.0))
    });
    el().key("palette-color-editor-layer")
        .absolute(0.0, 0.0)
        .full_width()
        .full_height()
        .center()
        .fill(kit.c.scrim)
        .child(
            col()
                .key("palette-color-editor")
                .role("dialog")
                .label(title)
                .w(EDITOR_WIDTH)
                .fill(t.color("surface-overlay"))
                .border(1.0, t.color("border-strong"))
                .pad(Space::Md)
                .separate(Space::Sm)
                .child(
                    row()
                        .full_width()
                        .center_y()
                        .separate(Space::Xs)
                        .child(preview)
                        .child(
                            text(title)
                                .text_role(TextRole::Button)
                                .grow(1.0)
                                .shrink()
                                .truncate(),
                        )
                        .child(text(hex).text_role(TextRole::Mono))
                        .child(layout::button("×", false, close_btn).label(close_label)),
                )
                .child(hex_field)
                .children(channels)
                .modal(true, close_modal)
                .modal_click_outside(true),
        )
}

pub fn name_editor<S: 'static>(
    label: &str,
    edit: &TextEdit,
    disabled: bool,
    on_edit: impl Fn(&mut S) -> &mut TextEdit + 'static,
    on_change: impl Fn(&mut S) + 'static,
) -> El {
    let field_kit = crate::field_kit(layout::dark());
    row()
        .key("palette-name-editor")
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .child(text(label).text_role(TextRole::Label))
        .child(
            el().grow(1.0).shrink().child(
                TextInput::new(edit)
                    .label(label)
                    .disabled(disabled)
                    .on_edit(on_edit)
                    .on_change(move |s: &mut S, _| on_change(s))
                    .build(&field_kit)
                    .key("palette-name-input"),
            ),
        )
}

pub fn save_error(message: &str) -> El {
    let t = tokens(layout::dark());
    text(message)
        .text_role(TextRole::Small)
        .color(t.color("status-error"))
        .wrap()
        .role("alert")
}

pub fn confirm_dialog<S: 'static>(
    message: &str,
    confirm_label: &str,
    cancel_label: &str,
    decide: impl Fn(&mut S, bool, &mut rune::Tx) + Clone + 'static,
) -> El {
    crate::document_reader::editor::confirmation(
        layout::dark(),
        message,
        cancel_label,
        confirm_label,
        decide,
    )
}
