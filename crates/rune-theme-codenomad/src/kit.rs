//! Map shared CodeNomad surface roles onto rune-kit's generic semantic schema.
//! Component geometry, glyphs and spring-curve parity remain explicit qualification gaps.
use crate::{MotionRole, TextRole, document, tokens};
use rune::{Color, Spring};
use rune_kit::{Elevation, Kit, Motion, Palette, Radius, StateColors, Type, css, glyphs};
use std::sync::OnceLock;

pub fn kit(dark: bool) -> &'static Kit {
    static KITS: [OnceLock<Kit>; 2] = [const { OnceLock::new() }; 2];
    KITS[dark as usize].get_or_init(|| build(dark))
}
fn build(dark: bool) -> Kit {
    let t = tokens(dark);
    let c = |name| t.color(name);
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
    let shadow = |name| {
        css::box_shadows(
            document()["shadows"][t.mode()][name]
                .as_str()
                .expect("generated CSS shadow"),
            |color| color,
        )
    };
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
    Kit {
        dark,
        c: palette,
        elevation,
        glyph: glyphs::DEFAULT,
        ty,
        radius: Radius {
            xs: t.number("radius-xs").px(),
            sm: t.number("radius-sm").px(),
            md: t.number("radius-md").px(),
            lg: t.number("radius-lg").px(),
            xl: t.number("radius-xl").px(),
        },
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
    }
}
