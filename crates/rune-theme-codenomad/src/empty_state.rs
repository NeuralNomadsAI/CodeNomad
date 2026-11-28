//! Branded empty state for empty conversations and projects without an active session.
use crate::{Space, layout::dark, tokens};
use rune::{Align, El, Icon, TextStyle, col, icon, row, text};

const LOGO_VIEW: f32 = 230.94;
const LOGO_SIZE: f32 = 64.0;
const LOGO_SIZE_NARROW: f32 = 51.2;
const BRAND_TITLE_SIZE: f32 = 30.0;
const BRAND_TITLE_LINE: f32 = 36.0;
const BRAND_TITLE_SIZE_NARROW: f32 = 24.0;
const BRAND_TITLE_LINE_NARROW: f32 = 32.0;
const CONTENT_MAX_WIDTH: f32 = 384.0;
const CODE_FONT_SIZE: f32 = 13.0;

// Translated from packages/ui/src/images/CodeNomad-Logo-OnDark.svg (-100 -115.47 200 230.94).
static LOGO_ON_DARK: Icon = Icon {
    name: "codenomad-logo-on-dark",
    view: LOGO_VIEW,
    body: r##"<g transform="translate(115.47 115.47)"><path fill="#000" d="M0 -104.973 L90.909 -52.486 L90.909 52.486 L0 104.973 L-90.909 52.486 L-90.909 -52.486Z"/><path fill="#fff" fill-rule="evenodd" d="M0 -115.47 L100 -57.735 L100 57.735 L0 115.47 L-100 57.735 L-100 -57.735ZM-81.818 -47.238 L-81.818 47.238 L0 94.475 L81.818 47.238 L81.818 -47.238 L0 -94.475ZM-9.091 -68.232 L-63.636 -36.74 L-63.636 36.74 L-9.091 68.232 L-9.091 9.091 L-27.273 9.091 L-27.273 36.74 L-45.455 26.243 L-45.455 -26.243 L-27.273 -36.74 L-27.273 -9.091 L-9.091 -9.091ZM9.091 -68.232 L63.636 -36.74 L63.636 36.74 L45.455 47.238 L45.455 -26.243 L27.273 -36.74 L27.273 57.735 L9.091 68.232Z"/></g>"##,
};

// Translated from packages/ui/src/images/CodeNomad-Logo-OnLight.svg (-100 -115.47 200 230.94).
static LOGO_ON_LIGHT: Icon = Icon {
    name: "codenomad-logo-on-light",
    view: LOGO_VIEW,
    body: r##"<g transform="translate(115.47 115.47)"><path fill="#fff" d="M0 -104.973 L90.909 -52.486 L90.909 52.486 L0 104.973 L-90.909 52.486 L-90.909 -52.486Z"/><path fill="#000" fill-rule="evenodd" d="M0 -115.47 L100 -57.735 L100 57.735 L0 115.47 L-100 57.735 L-100 -57.735ZM-81.818 -47.238 L-81.818 47.238 L0 94.475 L81.818 47.238 L81.818 -47.238 L0 -94.475ZM-9.091 -68.232 L-63.636 -36.74 L-63.636 36.74 L-9.091 68.232 L-9.091 9.091 L-27.273 9.091 L-27.273 36.74 L-45.455 26.243 L-45.455 -26.243 L-27.273 -36.74 L-27.273 -9.091 L-9.091 -9.091ZM9.091 -68.232 L63.636 -36.74 L63.636 36.74 L45.455 47.238 L45.455 -26.243 L27.273 -36.74 L27.273 57.735 L9.091 68.232Z"/></g>"##,
};

pub struct EmptyStateCopy<'a> {
    pub logo_alt: &'a str,
    pub brand_title: &'a str,
    pub title: &'a str,
    pub description: &'a str,
    pub tip_command_palette: &'a str,
    pub tip_ask_about_codebase: &'a str,
    pub tip_attach_files_prefix: &'a str,
}

pub fn brand_logo(logo_alt: &str, size: f32) -> El {
    let glyph = if dark() {
        &LOGO_ON_DARK
    } else {
        &LOGO_ON_LIGHT
    };
    icon(glyph, size)
        .key("branded-empty-logo")
        .role("img")
        .label(logo_alt)
}

pub fn branded(copy: EmptyStateCopy<'_>, narrow: bool) -> El {
    let t = tokens(dark());
    let semibold = t.number("font-weight-semibold").px();
    let regular = t.number("font-weight-regular").px();
    let primary = t.color("text-primary");
    let muted = t.color("text-muted");
    let base_size = t.number("font-size-base").px();
    let base_line = (base_size * t.number("line-height-normal").px()).ceil();
    let base_style = TextStyle::new(base_size, regular).lh(base_line);
    let title_size = t.number("font-size-xl").px();
    let title_line = (title_size * t.number("line-height-tight").px()).ceil();
    let title_style = TextStyle::new(title_size, regular).lh(title_line);
    let (logo_size, brand_size, brand_line) = if narrow {
        (
            LOGO_SIZE_NARROW,
            BRAND_TITLE_SIZE_NARROW,
            BRAND_TITLE_LINE_NARROW,
        )
    } else {
        (LOGO_SIZE, BRAND_TITLE_SIZE, BRAND_TITLE_LINE)
    };
    let brand_style = TextStyle::new(brand_size, semibold).lh(brand_line);
    let code_line = (CODE_FONT_SIZE * t.number("line-height-tight").px()).ceil();
    let code_style = TextStyle::new(CODE_FONT_SIZE, regular).lh(code_line).mono();

    let header = col()
        .items_center()
        .gap(t.space(Space::Md).px())
        .pb(t.space(Space::Xl).px())
        .child(brand_logo(copy.logo_alt, logo_size))
        .child(
            text(copy.brand_title)
                .key("branded-empty-brand-title")
                .font(brand_style)
                .color(primary)
                .align(Align::Center)
                .role("heading"),
        );

    let attach_tip = row()
        .key("branded-empty-tip-attach")
        .items_center()
        .justify_center()
        .flex_wrap()
        .gap(t.space(Space::Xs).px())
        .child(
            text(copy.tip_attach_files_prefix)
                .font(base_style)
                .color(muted)
                .align(Align::Center),
        )
        .child(
            row()
                .key("branded-empty-tip-at")
                .fill(t.color("surface-code"))
                .px(6.0)
                .py(2.0)
                .radius(0.0)
                .child(text("@").font(code_style).color(muted)),
        );

    let tips = col()
        .key("branded-empty-tips")
        .w_full()
        .items_center()
        .gap(t.space(Space::Sm).px())
        .child(
            text(copy.tip_command_palette)
                .key("branded-empty-tip-palette")
                .font(base_style)
                .color(muted)
                .wrap()
                .align(Align::Center),
        )
        .child(
            text(copy.tip_ask_about_codebase)
                .key("branded-empty-tip-codebase")
                .font(base_style)
                .color(muted)
                .wrap()
                .align(Align::Center),
        )
        .child(attach_tip);

    let content = col()
        .key("branded-empty-content")
        .w_full()
        .max_w(CONTENT_MAX_WIDTH)
        .items_center()
        .child(header)
        .child(
            text(copy.title)
                .key("branded-empty-title")
                .font(title_style)
                .color(primary)
                .wrap()
                .align(Align::Center)
                .pb(t.space(Space::Md).px()),
        )
        .child(
            text(copy.description)
                .key("branded-empty-description")
                .font(base_style)
                .color(muted)
                .wrap()
                .align(Align::Center)
                .pb(t.space(Space::Lg).px()),
        )
        .child(tips);

    col()
        .key("branded-empty-state")
        .w_full()
        .items_center()
        .padding(t.space(Space::Xl).px() * 2.0)
        .child(content)
}
