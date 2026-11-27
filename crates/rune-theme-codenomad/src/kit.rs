//! Map shared CodeNomad surface roles onto rune-kit's generic semantic schema.
//! Component geometry, glyphs and spring-curve parity remain explicit qualification gaps.
use crate::{
    Length, MotionRole, Space, TextRole, document,
    palettes::{CustomPalette, ResolvedPalette},
    tokens,
};
use rune::{Color, Spring};
use rune_kit::{
    ButtonMetrics, BySize, CheckboxColors, Elevation, FieldMetrics, IconButtonMetrics, Kit,
    Metrics, Motion, Palette, Radius, StateColors, SwitchMetrics, TextAreaMetrics, Type, css,
    glyphs,
};
use std::{ops::Deref, rc::Rc, sync::OnceLock};

pub(crate) enum DynamicKit {
    Base,
    Field,
    Code,
}

enum KitRefInner {
    Static(&'static Kit),
    Dynamic(Rc<CustomPalette>, DynamicKit),
}

pub struct KitRef(KitRefInner);

impl KitRef {
    pub(crate) fn static_kit(kit: &'static Kit) -> Self {
        Self(KitRefInner::Static(kit))
    }

    pub(crate) fn dynamic(palette: Rc<CustomPalette>, variant: DynamicKit) -> Self {
        Self(KitRefInner::Dynamic(palette, variant))
    }
}

impl Deref for KitRef {
    type Target = Kit;
    fn deref(&self) -> &Kit {
        match &self.0 {
            KitRefInner::Static(kit) => kit,
            KitRefInner::Dynamic(palette, DynamicKit::Base) => palette.kit(),
            KitRefInner::Dynamic(palette, DynamicKit::Field) => palette.field_kit(),
            KitRefInner::Dynamic(palette, DynamicKit::Code) => palette.code_kit(),
        }
    }
}

impl AsRef<Kit> for KitRef {
    fn as_ref(&self) -> &Kit {
        self
    }
}

pub fn kit(dark: bool) -> KitRef {
    if let Some(palette) = crate::palettes::active(dark) {
        return match palette {
            ResolvedPalette::BuiltIn(palette) => {
                KitRef::static_kit(palette.kit.get_or_init(|| build(dark)))
            }
            ResolvedPalette::Custom(palette) => KitRef::dynamic(palette, DynamicKit::Base),
        };
    }
    static KITS: [OnceLock<Kit>; 4] = [const { OnceLock::new() }; 4];
    KitRef::static_kit(KITS[crate::palette_index(dark)].get_or_init(|| build(dark)))
}
pub fn field_kit(dark: bool) -> KitRef {
    if let Some(palette) = crate::palettes::active(dark) {
        return match palette {
            ResolvedPalette::BuiltIn(palette) => {
                KitRef::static_kit(palette.field.get_or_init(|| {
                    let mut kit = kit(dark).clone();
                    kit.c.bg_base = kit.c.surface_base;
                    kit
                }))
            }
            ResolvedPalette::Custom(palette) => KitRef::dynamic(palette, DynamicKit::Field),
        };
    }
    static FIELDS: [OnceLock<Kit>; 4] = [const { OnceLock::new() }; 4];
    KitRef::static_kit(FIELDS[crate::palette_index(dark)].get_or_init(|| {
        let mut kit = kit(dark).clone();
        kit.c.bg_base = kit.c.surface_base;
        kit
    }))
}
pub(crate) fn build(dark: bool) -> Kit {
    let t = tokens(dark);
    let shadows = if crate::layout::source_palette() {
        &document()["product"][t.mode()]["shadows"]
    } else {
        &document()["shadows"][t.mode()]
    };
    let active = crate::palettes::active(dark);
    build_from(
        dark,
        |name| t.color(name),
        |name| {
            active.as_ref().map_or_else(
                || shadows[name].as_str().expect("generated CSS shadow"),
                |p| p.shadow(name),
            )
        },
    )
}

pub(crate) fn build_from(
    dark: bool,
    color_of: impl Fn(&str) -> Color,
    shadow_css: impl Fn(&str) -> &'static str,
) -> Kit {
    let t = tokens(dark);
    let c = |name| color_of(name);
    let state = |bg, fg| StateColors {
        bg: c(bg),
        fg: c(fg),
        border: c(fg),
        icon: c(fg),
    };
    let palette = Palette {
        page: c("surface-canvas"),
        bg_base: c("surface-canvas"),
        bg_deep: c("surface-inset"),
        layer_01: c("surface-secondary"),
        layer_02: c("surface-overlay"),
        layer_03: c("surface-overlay"),
        layer_04: c("surface-overlay"),
        bg_inverse: c("text-primary"),
        bg_contrast: c("button-primary-bg"),
        bg_button_neutral: c("surface-control"),
        bg_icon_button_contrast: c("button-primary-bg"),
        bg_accent: c("accent-primary"),
        // CodeNomad's primary button is flat; its computed stylesheet has no gradient sheen.
        submit_highlight: Color::TRANSPARENT,
        submit_hover: c("button-primary-hover-bg"),
        submit_fg: c("button-primary-text"),
        submit_icon: c("button-primary-text"),
        text_base: c("text-primary"),
        text_muted: c("text-secondary"),
        text_faint: c("text-muted"),
        text_inverse: c("text-inverted"),
        text_contrast: c("text-on-accent"),
        text_accent: c("accent-primary"),
        icon_base: c("text-primary"),
        icon_muted: c("text-secondary"),
        icon_faint: c("text-muted"),
        icon_inverse: c("text-inverted"),
        icon_contrast: c("text-on-accent"),
        icon_accent: c("accent-primary"),
        border_muted: c("border-muted"),
        border_base: c("border-base"),
        border_strong: c("border-strong"),
        border_focus: c("focus-ring-color"),
        hover: c("surface-hover-overlay"),
        pressed: c("surface-hover-overlay"),
        contrast_hover: c("button-primary-hover-bg"),
        contrast_pressed: c("button-primary-hover-bg"),
        scrim: c("overlay-scrim"),
        depth_top: Color::TRANSPARENT,
        depth_bottom: Color::TRANSPARENT,
        white: c("text-on-accent").alpha(1.0),
        black: c("overlay-scrim").alpha(1.0),
        knob: c("surface-secondary"),
        knob_on: c("text-on-accent"),
        success: state("status-ready-bg", "status-ready-fg"),
        warning: state("status-starting-bg", "status-starting-fg"),
        danger: state("status-error-bg", "status-error-fg"),
        info: state("badge-neutral-bg", "accent-primary"),
        surface_base: c("surface-field"),
        surface_weak: c("surface-muted"),
        surface_hover: c("surface-hover"),
        surface_raised: c("surface-overlay"),
        surface_raised_base: c("surface-overlay"),
        surface_raised_hover: c("surface-hover"),
        surface_float: c("surface-overlay"),
        surface_disabled: c("surface-control"),
        border_weak: c("border-muted"),
        border_hover: c("border-strong"),
        border_active: c("accent-primary"),
        border_disabled: c("border-muted"),
        text_strong: c("text-primary"),
        text_weak: c("text-secondary"),
        text_invert_strong: c("text-inverted"),
        icon_weaker: c("text-muted"),
        std_border: c("border-base"),
        std_icon: c("text-primary"),
        std_icon_invert: c("text-inverted"),
        std_icon_strong: c("text-primary"),
        std_text: c("text-primary"),
    };
    let shadow = |name| css::box_shadows(shadow_css(name), |color| color);
    let mut elevation = Elevation::default().with_input(Vec::new());
    elevation.raised = shadow("panel-shadow");
    elevation.floating = shadow("popover-shadow");
    elevation.overlay = shadow("panel-shadow-strong");
    elevation.md = shadow("panel-shadow");
    let medium = |role| {
        let mut style = t.text(role);
        style.weight = t.number("font-weight-medium").px();
        style
    };
    let ty = Type {
        ui: t.text(TextRole::Body),
        ui_medium: t.text(TextRole::Button),
        ui_compact: t.text(TextRole::Label),
        small: t.text(TextRole::Small),
        small_medium: medium(TextRole::Small),
        body: t.text(TextRole::Body),
        body_medium: medium(TextRole::Body),
        text_small: t.text(TextRole::Body),
        text_small_medium: medium(TextRole::Body),
        text_xsmall: t.text(TextRole::Label),
        text_xsmall_medium: t.text(TextRole::Button),
        mono: t.text(TextRole::Mono),
    };
    let radius = Radius {
        xs: t.number("radius-xs").px(),
        sm: t.number("radius-sm").px(),
        md: t.number("radius-md").px(),
        lg: t.number("radius-lg").px(),
        xl: t.number("radius-xl").px(),
    };
    let button_radius = t.number("button-radius").px();
    let pad_sm = t.space(Space::Sm).px();
    let pad_md = t.length(Length::ButtonPadX).px();
    let pad_lg = t.space(Space::Lg).px();
    let icon_sm = t.space(Space::Md).px();
    let icon_md = t.length(Length::Icon).px();
    let icon_lg = t.space(Space::Lg).px();
    let switch_inset = t.space(Space::Xxs).px();
    let switch = |track_width, track_height| {
        let knob = track_height - 2.0 * switch_inset;
        SwitchMetrics {
            track_width,
            track_height,
            knob_width: knob,
            knob_height: knob,
            inset: switch_inset,
        }
    };
    let metrics = Metrics {
        button: Some(BySize {
            mini: ButtonMetrics {
                height: t.length(Length::ControlSmall).px() - t.space(Space::Xs).px(),
                padding_x: pad_sm,
                radius: button_radius,
                icon: icon_sm,
            },
            small: ButtonMetrics {
                height: t.length(Length::ControlSmall).px(),
                padding_x: pad_sm,
                radius: button_radius,
                icon: icon_md,
            },
            regular: ButtonMetrics {
                height: t.length(Length::Control).px(),
                padding_x: pad_md,
                radius: button_radius,
                icon: icon_md,
            },
            large: ButtonMetrics {
                height: t.length(Length::TouchCompact).px(),
                padding_x: pad_md,
                radius: button_radius,
                icon: icon_lg,
            },
            extra_large: ButtonMetrics {
                height: t.length(Length::TouchTarget).px(),
                padding_x: pad_lg,
                radius: button_radius,
                icon: icon_lg,
            },
        }),
        icon_button: Some(BySize {
            mini: IconButtonMetrics {
                size: t.length(Length::ControlSmall).px() - t.space(Space::Xs).px(),
                radius: button_radius,
                icon: icon_sm,
            },
            small: IconButtonMetrics {
                size: t.length(Length::ControlSmall).px(),
                radius: button_radius,
                icon: icon_md,
            },
            regular: IconButtonMetrics {
                size: t.length(Length::IconButton).px(),
                radius: button_radius,
                icon: icon_md,
            },
            large: IconButtonMetrics {
                size: t.length(Length::TouchCompact).px(),
                radius: button_radius,
                icon: icon_lg,
            },
            extra_large: IconButtonMetrics {
                size: t.length(Length::TouchTarget).px(),
                radius: button_radius,
                icon: icon_lg,
            },
        }),
        // Circular thumb (knob_width == knob_height) inside a capsule track, matching switches.css.
        switch: Some(BySize {
            mini: switch(t.length(Length::Control).px(), t.space(Space::Lg).px()),
            small: switch(
                t.length(Length::TouchCompact).px(),
                t.length(Length::ControlSmall).px() - t.space(Space::Xs).px(),
            ),
            regular: switch(
                t.length(Length::Selector).px(),
                t.length(Length::ControlSmall).px(),
            ),
            large: switch(
                t.length(Length::TouchTarget).px(),
                t.length(Length::Control).px(),
            ),
            extra_large: switch(
                t.length(Length::TouchTarget).px() + t.space(Space::Sm).px(),
                t.length(Length::TouchCompact).px(),
            ),
        }),
        // Keep the 1px inset focus ring so full-width fields inside scroll clips stay unclipped.
        field: Some(FieldMetrics {
            height: t.length(Length::Control).px(),
            large_height: t.length(Length::TouchCompact).px(),
            padding_x: pad_sm,
            radius: radius.md,
            focus_width: 1.0,
            focus_offset: -1.0,
        }),
        text_area: Some(TextAreaMetrics {
            style: t.text(TextRole::Body),
            padding: pad_sm,
        }),
        checkbox: Some(CheckboxColors {
            fill: c("accent-primary"),
            border: c("accent-primary"),
            mark: c("text-on-accent"),
        }),
        ..Metrics::default()
    };
    Kit {
        dark,
        c: palette,
        elevation,
        glyph: glyphs::DEFAULT,
        ty,
        radius,
        // Source durations are exact; CSS easing and spring curves require separate qualification.
        motion: Motion {
            control: Spring::new(t.duration_seconds(MotionRole::Control), 0.0),
            overlay: Spring::new(t.duration_seconds(MotionRole::Control), 0.0),
            disclosure: Spring::new(t.duration_seconds(MotionRole::Disclosure), 0.0),
        },
        blend_over: Some(c("surface-canvas")),
        ring: None,
        invalid_text: false,
        forced: None,
        metrics,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Cx, El, Env, Runtime, TextEdit, col};
    use rune_kit::{Button, Checkbox, ControlSize, IconButton, Switch, TextInput};

    #[test]
    fn kit_metrics_follow_generated_tokens_and_drive_rendered_controls() {
        for dark in [false, true] {
            let k = kit(dark);
            let t = tokens(dark);
            let buttons = k.metrics.button.expect("button metrics");
            assert_eq!(buttons.small.height, t.length(Length::ControlSmall).px());
            assert_eq!(buttons.regular.height, t.length(Length::Control).px());
            assert_eq!(buttons.large.height, t.length(Length::TouchCompact).px());
            assert_eq!(
                buttons.extra_large.height,
                t.length(Length::TouchTarget).px()
            );
            assert_eq!(buttons.regular.padding_x, t.length(Length::ButtonPadX).px());
            assert_eq!(buttons.regular.radius, 0.0);

            let icon_buttons = k.metrics.icon_button.expect("icon_button metrics");
            assert_eq!(
                icon_buttons.mini.size,
                t.length(Length::ControlSmall).px() - t.space(Space::Xs).px()
            );
            assert_eq!(icon_buttons.small.size, t.length(Length::ControlSmall).px());
            assert_eq!(icon_buttons.regular.size, t.length(Length::IconButton).px());
            assert_eq!(icon_buttons.large.size, t.length(Length::TouchCompact).px());
            assert_eq!(
                icon_buttons.extra_large.size,
                t.length(Length::TouchTarget).px()
            );
            assert_eq!(icon_buttons.regular.icon, t.length(Length::Icon).px());
            assert_eq!(icon_buttons.regular.radius, 0.0);

            let switches = k.metrics.switch.expect("switch metrics");
            for size in [
                ControlSize::Mini,
                ControlSize::Small,
                ControlSize::Regular,
                ControlSize::Large,
                ControlSize::ExtraLarge,
            ] {
                let s = switches.get(size);
                assert_eq!(s.knob_width, s.knob_height, "circular switch thumb");
                assert_eq!(s.knob_height, s.track_height - 2.0 * s.inset);
                assert!(s.track_width > s.knob_width + 2.0 * s.inset);
            }

            let field = k.metrics.field.expect("field metrics");
            assert_eq!(field.height, t.length(Length::Control).px());
            assert_eq!(field.large_height, t.length(Length::TouchCompact).px());
            assert_eq!(field.padding_x, t.space(Space::Sm).px());
            assert_eq!(field.radius, 0.0);

            let area = k.metrics.text_area.expect("text_area metrics");
            assert_eq!(area.style, t.text(TextRole::Body));
            assert_eq!(area.padding, t.space(Space::Sm).px());

            let checkbox = k.metrics.checkbox.expect("checkbox colours");
            assert_eq!(checkbox.fill, t.color("accent-primary"));
            assert_eq!(checkbox.border, t.color("accent-primary"));
            assert_eq!(checkbox.mark, t.color("text-on-accent"));

            let code_area = crate::document_reader::editor::metrics(dark);
            assert_eq!(code_area.style, crate::document_reader::source_font(dark));
            assert_eq!(code_area.padding, t.space(Space::Sm).px());

            fn view(edit: &TextEdit, cx: &mut Cx<TextEdit>) -> El {
                crate::layout::render(cx, |cx| {
                    let dark = cx.system_dark();
                    let k = kit(dark);
                    col()
                        .w_full()
                        .h_full()
                        .child(Button::new("Default").build(&k).key("btn-default"))
                        .child(
                            Button::new("Small")
                                .control_size(ControlSize::Small)
                                .build(&k)
                                .key("btn-small"),
                        )
                        .child(
                            Button::new("Regular")
                                .control_size(ControlSize::Regular)
                                .build(&k)
                                .key("btn-regular"),
                        )
                        .child(
                            IconButton::new(k.glyph.close)
                                .label("Icon small")
                                .control_size(ControlSize::Small)
                                .build(&k)
                                .key("icon-btn-small"),
                        )
                        .child(
                            IconButton::new(k.glyph.close)
                                .label("Icon regular")
                                .control_size(ControlSize::Regular)
                                .build(&k)
                                .key("icon-btn-regular"),
                        )
                        .child(
                            IconButton::new(k.glyph.close)
                                .label("Icon large")
                                .control_size(ControlSize::Large)
                                .build(&k)
                                .key("icon-btn-large"),
                        )
                        .child(
                            TextInput::new(edit)
                                .label("Field")
                                .build(&field_kit(dark))
                                .key("field-box"),
                        )
                        .child(
                            TextInput::new(edit)
                                .label("Large field")
                                .large()
                                .build(&field_kit(dark))
                                .key("field-large"),
                        )
                        .child(
                            Switch::new(true)
                                .label("Toggle")
                                .build(&k)
                                .key("switch-box"),
                        )
                        .child(
                            Checkbox::new(true)
                                .label("Checked")
                                .build(&k)
                                .key("check-box"),
                        )
                })
            }

            let mut rt = Runtime::new(
                TextEdit::new("hello"),
                view,
                (360.0, 320.0),
                Env::new(dark, 1.0),
            );
            rt.frame(0.0);
            let elements = rt.elements();
            let rect = |key| {
                elements
                    .iter()
                    .find(|node| node.key.as_deref() == Some(key))
                    .unwrap_or_else(|| panic!("missing {key}"))
                    .rect
            };
            assert_eq!(rect("btn-default")[3], buttons.regular.height);
            assert_eq!(rect("btn-small")[3], buttons.small.height);
            assert_eq!(rect("btn-regular")[3], buttons.regular.height);
            assert_eq!(rect("icon-btn-small")[2], icon_buttons.small.size);
            assert_eq!(rect("icon-btn-small")[3], icon_buttons.small.size);
            assert_eq!(rect("icon-btn-regular")[2], icon_buttons.regular.size);
            assert_eq!(rect("icon-btn-regular")[3], icon_buttons.regular.size);
            assert_eq!(rect("icon-btn-large")[2], icon_buttons.large.size);
            assert_eq!(rect("icon-btn-large")[3], icon_buttons.large.size);
            let field_floor = k.ty.ui_compact.line_px() + 12.0;
            assert_eq!(rect("field-box")[3], field.height.max(field_floor));
            assert_eq!(rect("field-large")[3], field.large_height.max(field_floor));
            assert!(
                elements.iter().any(|node| {
                    node.path.contains("/check-box/") && node.fill == checkbox.fill
                }),
                "checked checkbox must paint accent-primary fill"
            );
            assert!(
                elements.iter().any(|node| {
                    node.path.contains("/switch-box/")
                        && (node.rect[2] - switches.mini.track_width).abs() < 0.01
                        && (node.rect[3] - switches.mini.track_height).abs() < 0.01
                }),
                "compact switch must render theme-owned track dimensions"
            );
        }
    }
}
