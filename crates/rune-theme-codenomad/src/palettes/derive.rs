//! Runtime palette derivation matching Solid's `theme-scheme.ts`, `high-contrast.ts`,
//! `classic-{light,dark}-surfaces.ts`, and `tokens.css` OKLab surface roles.
use serde_json::{Map, Value};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum ColorField {
    SurfaceBase = 0,
    SurfaceSecondary = 1,
    SurfaceMuted = 2,
    BorderBase = 3,
    TextPrimary = 4,
    TextMuted = 5,
    AccentPrimary = 6,
    StatusSuccess = 7,
    StatusWarning = 8,
    StatusError = 9,
    UserAccent = 10,
    AgentAccent = 11,
    CompactionAccent = 12,
}

impl ColorField {
    pub const ALL: [Self; 13] = [
        Self::SurfaceBase,
        Self::SurfaceSecondary,
        Self::SurfaceMuted,
        Self::BorderBase,
        Self::TextPrimary,
        Self::TextMuted,
        Self::AccentPrimary,
        Self::StatusSuccess,
        Self::StatusWarning,
        Self::StatusError,
        Self::UserAccent,
        Self::AgentAccent,
        Self::CompactionAccent,
    ];

    pub const fn index(self) -> usize {
        self as usize
    }

    pub const fn key(self) -> &'static str {
        match self {
            Self::SurfaceBase => "surfaceBase",
            Self::SurfaceSecondary => "surfaceSecondary",
            Self::SurfaceMuted => "surfaceMuted",
            Self::BorderBase => "borderBase",
            Self::TextPrimary => "textPrimary",
            Self::TextMuted => "textMuted",
            Self::AccentPrimary => "accentPrimary",
            Self::StatusSuccess => "statusSuccess",
            Self::StatusWarning => "statusWarning",
            Self::StatusError => "statusError",
            Self::UserAccent => "userAccent",
            Self::AgentAccent => "agentAccent",
            Self::CompactionAccent => "compactionAccent",
        }
    }

    pub const fn label_key(self) -> &'static str {
        match self {
            Self::SurfaceBase => "settings.appearance.colorScheme.custom.field.surfaceBase",
            Self::SurfaceSecondary => {
                "settings.appearance.colorScheme.custom.field.surfaceSecondary"
            }
            Self::SurfaceMuted => "settings.appearance.colorScheme.custom.field.surfaceMuted",
            Self::BorderBase => "settings.appearance.colorScheme.custom.field.borderBase",
            Self::TextPrimary => "settings.appearance.colorScheme.custom.field.textPrimary",
            Self::TextMuted => "settings.appearance.colorScheme.custom.field.textMuted",
            Self::AccentPrimary => "settings.appearance.colorScheme.custom.field.accentPrimary",
            Self::StatusSuccess => "settings.appearance.colorScheme.custom.field.statusSuccess",
            Self::StatusWarning => "settings.appearance.colorScheme.custom.field.statusWarning",
            Self::StatusError => "settings.appearance.colorScheme.custom.field.statusError",
            Self::UserAccent => "settings.appearance.colorScheme.custom.field.userAccent",
            Self::AgentAccent => "settings.appearance.colorScheme.custom.field.agentAccent",
            Self::CompactionAccent => {
                "settings.appearance.colorScheme.custom.field.compactionAccent"
            }
        }
    }

    pub const fn token_key(self) -> &'static str {
        match self {
            Self::SurfaceBase => "surface-base",
            Self::SurfaceSecondary => "surface-secondary",
            Self::SurfaceMuted => "surface-muted",
            Self::BorderBase => "border-base",
            Self::TextPrimary => "text-primary",
            Self::TextMuted => "text-muted",
            Self::AccentPrimary => "accent-primary",
            Self::StatusSuccess => "status-success",
            Self::StatusWarning => "status-warning",
            Self::StatusError => "status-error",
            Self::UserAccent => "message-user-border",
            Self::AgentAccent => "message-assistant-border",
            Self::CompactionAccent => "session-status-compacting-fg",
        }
    }
}

/// Canonical 13-color semantic input table (`#RRGGBB` uppercase).
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct ColorSchemeColors([String; 13]);

const DEFAULT_CUSTOM_HEX: [&str; 13] = [
    "#17181A", "#202226", "#292C31", "#3B3F46", "#F0F1F3", "#B2B6BE", "#8FA8FF", "#72C497",
    "#D8B36A", "#E28181", "#42A5F5", "#D97706", "#C084FC",
];

impl Default for ColorSchemeColors {
    fn default() -> Self {
        Self::default_custom()
    }
}

impl ColorSchemeColors {
    pub fn default_custom() -> Self {
        Self(DEFAULT_CUSTOM_HEX.map(str::to_owned))
    }

    pub fn get(&self, field: ColorField) -> &str {
        &self.0[field.index()]
    }

    pub fn channels(&self, field: ColorField) -> [u8; 3] {
        parse_rgb(self.get(field)).unwrap_or([0, 0, 0])
    }

    pub fn with(&self, field: ColorField, hex: &str) -> Option<Self> {
        let canonical = normalize_hex(hex)?;
        let mut next = self.clone();
        next.0[field.index()] = canonical;
        Some(next)
    }

    pub fn is_default_custom(&self) -> bool {
        self.0
            .iter()
            .zip(DEFAULT_CUSTOM_HEX)
            .all(|(actual, default)| actual == default)
    }

    /// Strict 13-field parse matching Solid's `isColorSchemeColors`.
    pub fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let mut out: [String; 13] = std::array::from_fn(|_| String::new());
        for field in ColorField::ALL {
            let raw = object.get(field.key())?.as_str()?;
            if !is_canonical_hex(raw) {
                return None;
            }
            out[field.index()] = raw.to_owned();
        }
        Some(Self(out))
    }

    /// Legacy-compatible parse matching Solid's `normalizeColors` (first 10 required,
    /// last 3 optional with `DEFAULT_CUSTOM_COLORS` fallbacks).
    pub fn from_legacy_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let mut out = Self::default_custom().0;
        for (idx, field) in ColorField::ALL.into_iter().enumerate() {
            match object.get(field.key()).and_then(Value::as_str) {
                Some(raw) if is_canonical_hex(raw) => out[idx] = raw.to_owned(),
                _ if idx < 10 => return None,
                _ => {}
            }
        }
        Some(Self(out))
    }

    pub(super) fn from_token_map(colors: &Value) -> Option<Self> {
        let object = colors.as_object()?;
        let mut out: [String; 13] = std::array::from_fn(|_| String::new());
        for field in ColorField::ALL {
            let raw = object.get(field.token_key())?.as_str()?;
            let hex = raw.get(..7)?;
            out[field.index()] = normalize_hex(hex)?;
        }
        Some(Self(out))
    }

    pub fn to_json(&self) -> Value {
        let mut map = Map::with_capacity(13);
        for field in ColorField::ALL {
            map.insert(
                field.key().to_owned(),
                Value::String(self.0[field.index()].clone()),
            );
        }
        Value::Object(map)
    }
}

pub fn is_canonical_hex(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[0] == b'#'
        && bytes[1..]
            .iter()
            .all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'F'))
}

pub fn normalize_hex(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", hex.to_ascii_uppercase()))
}

pub fn parse_rgb(hex: &str) -> Option<[u8; 3]> {
    let hex = hex.strip_prefix('#')?;
    if hex.len() < 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some([r, g, b])
}

pub fn format_hex(rgb: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2])
}

fn format_rgba(rgb: [u8; 3], alpha: f64) -> String {
    let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2], a)
}

fn format_opaque(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}ff", rgb[0], rgb[1], rgb[2])
}

fn srgb_to_linear(channel: u8) -> f64 {
    let normalized = f64::from(channel) / 255.0;
    if normalized <= 0.04045 {
        normalized / 12.92
    } else {
        ((normalized + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(linear: f64) -> u8 {
    let clamped = linear.clamp(0.0, 1.0);
    let encoded = if clamped <= 0.0031308 {
        clamped * 12.92
    } else {
        1.055 * clamped.powf(1.0 / 2.4) - 0.055
    };
    (encoded.clamp(0.0, 1.0) * 255.0).round() as u8
}

pub fn luminance(rgb: [u8; 3]) -> f64 {
    0.2126 * srgb_to_linear(rgb[0])
        + 0.7152 * srgb_to_linear(rgb[1])
        + 0.0722 * srgb_to_linear(rgb[2])
}

pub fn contrast_ratio(a: [u8; 3], b: [u8; 3]) -> f64 {
    let la = luminance(a);
    let lb = luminance(b);
    let (bright, dark) = if la >= lb { (la, lb) } else { (lb, la) };
    (bright + 0.05) / (dark + 0.05)
}

fn text_on_color(rgb: [u8; 3]) -> [u8; 3] {
    if contrast_ratio([0, 0, 0], rgb) >= contrast_ratio([255, 255, 255], rgb) {
        [0, 0, 0]
    } else {
        [255, 255, 255]
    }
}

fn mix_srgb(first: [u8; 3], second: [u8; 3], first_weight: f64) -> [u8; 3] {
    let w2 = 1.0 - first_weight;
    [
        (f64::from(first[0]) * first_weight + f64::from(second[0]) * w2).round() as u8,
        (f64::from(first[1]) * first_weight + f64::from(second[1]) * w2).round() as u8,
        (f64::from(first[2]) * first_weight + f64::from(second[2]) * w2).round() as u8,
    ]
}

fn rgb_to_oklab(rgb: [u8; 3]) -> [f64; 3] {
    let r = srgb_to_linear(rgb[0]);
    let g = srgb_to_linear(rgb[1]);
    let b = srgb_to_linear(rgb[2]);
    let l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b).cbrt();
    let m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b).cbrt();
    let s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b).cbrt();
    [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ]
}

fn oklab_to_rgb(lab: [f64; 3]) -> [u8; 3] {
    let [cap_l, a, b] = lab;
    let l_ = cap_l + 0.3963377774 * a + 0.2158037573 * b;
    let m_ = cap_l - 0.1055613458 * a - 0.0638541728 * b;
    let s_ = cap_l - 0.0894841775 * a - 1.2914855480 * b;
    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;
    let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    let b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    [linear_to_srgb(r), linear_to_srgb(g), linear_to_srgb(b)]
}

fn mix_oklab(first: [u8; 3], first_weight: f64, second: [u8; 3]) -> [u8; 3] {
    let a = rgb_to_oklab(first);
    let b = rgb_to_oklab(second);
    let w2 = 1.0 - first_weight;
    oklab_to_rgb([
        a[0] * first_weight + b[0] * w2,
        a[1] * first_weight + b[1] * w2,
        a[2] * first_weight + b[2] * w2,
    ])
}

/// Applies `HIGH_CONTRAST_CURVE` (`contrast = 1.3`, `pivotShift = 0.3`) to every input color.
pub fn high_contrast_colors(colors: &ColorSchemeColors, dark: bool) -> ColorSchemeColors {
    let pivot = if dark { 0.2_f64 } else { 0.8_f64 };
    let contrast = 1.3_f64;
    let mut out = colors.0.clone();
    for (idx, field) in ColorField::ALL.into_iter().enumerate() {
        let rgb = colors.channels(field);
        let stretched = rgb.map(|c| {
            let value = (pivot + (f64::from(c) / 255.0 - pivot) * contrast).clamp(0.0, 1.0);
            (value * 255.0).round() as u8
        });
        out[idx] = format_hex(stretched);
    }
    ColorSchemeColors(out)
}

/// Derives the complete token map for a custom or overridden palette, matching Solid's
/// `applyColorScheme` + `tokens.css` + `utilities.css` active-toggle formulas.
pub(super) fn derive_palette_colors(
    id: Option<&str>,
    dark: bool,
    high_contrast: bool,
    source: &ColorSchemeColors,
    base_tokens: &Map<String, Value>,
) -> Value {
    let effective = if high_contrast {
        high_contrast_colors(source, dark)
    } else {
        source.clone()
    };
    let surface_base = effective.channels(ColorField::SurfaceBase);
    let surface_secondary = effective.channels(ColorField::SurfaceSecondary);
    let surface_muted = effective.channels(ColorField::SurfaceMuted);
    let border_base = effective.channels(ColorField::BorderBase);
    let text_primary = effective.channels(ColorField::TextPrimary);
    let text_muted = effective.channels(ColorField::TextMuted);
    let accent_primary = effective.channels(ColorField::AccentPrimary);
    let status_success = effective.channels(ColorField::StatusSuccess);
    let status_warning = effective.channels(ColorField::StatusWarning);
    let status_error = effective.channels(ColorField::StatusError);
    let user_accent = effective.channels(ColorField::UserAccent);
    let agent_accent = effective.channels(ColorField::AgentAccent);
    let compaction_accent = effective.channels(ColorField::CompactionAccent);

    // Filled-action ink follows the palette's original accent, never flipping on high contrast.
    let text_on_accent = text_on_color(source.channels(ColorField::AccentPrimary));
    let selection = text_muted;

    let mut surface_hover = mix_srgb(text_primary, surface_secondary, 0.04);
    let mut border_secondary = mix_srgb(border_base, surface_secondary, 0.72);
    let mut border_muted = mix_srgb(border_base, surface_secondary, 0.5);
    let mut border_strong = mix_srgb(text_primary, border_base, 0.3);
    let mut text_secondary = text_muted;
    let mut accent_hover = mix_srgb(
        if dark { [255, 255, 255] } else { [0, 0, 0] },
        accent_primary,
        if dark { 0.14 } else { 0.18 },
    );
    let list_highlight_solid =
        mix_srgb(selection, surface_secondary, if dark { 0.22 } else { 0.12 });
    let mut message_user_bg = mix_srgb(
        user_accent,
        surface_secondary,
        if dark { 0.05 } else { 0.06 },
    );
    let mut message_assistant_bg = surface_muted;
    let mut message_tool_bg = surface_muted;
    let mut message_tool_border = mix_srgb(text_muted, border_base, 0.28);

    let surface_shade_light = mix_oklab(surface_secondary, 0.75, surface_base);
    let surface_shade_strong = mix_oklab(surface_secondary, 0.25, surface_base);
    let surface_subtle = mix_oklab(surface_secondary, 0.36, surface_base);
    let surface_control = mix_oklab(surface_secondary, 0.72, surface_base);
    let surface_interactive_hover = mix_oklab(text_primary, 0.04, surface_secondary);
    let mut surface_code = surface_shade_strong;

    // Classic V1 surface overrides (classic-light-surfaces.ts / classic-dark-surfaces.ts).
    if id == Some("light") {
        if effective.get(ColorField::SurfaceMuted) == "#F8FAFC" {
            message_assistant_bg = [0xF8, 0xF8, 0xF8];
            message_tool_bg = [0xF8, 0xF8, 0xF8];
            if effective.get(ColorField::SurfaceBase) == "#FFFFFF" {
                surface_code = [0xF1, 0xF5, 0xF9];
            }
        }
        if effective.get(ColorField::TextMuted) == "#475569" {
            text_secondary = [0x33, 0x41, 0x55];
        }
        if effective.get(ColorField::AccentPrimary) == "#0066FF" {
            accent_hover = [0x00, 0x52, 0xCC];
        }
    } else if id == Some("classic") {
        if effective.get(ColorField::UserAccent) == "#2196F3"
            && effective.get(ColorField::SurfaceBase) == "#1A1A1A"
            && effective.get(ColorField::SurfaceSecondary) == "#2A2A2A"
        {
            message_user_bg = [0x20, 0x27, 0x34];
        }
        if effective.get(ColorField::AccentPrimary) == "#0080FF" {
            accent_hover = [0x00, 0x66, 0xCC];
        }
        if effective.get(ColorField::BorderBase) == "#3A3A3A"
            && effective.get(ColorField::TextMuted) == "#999999"
        {
            message_tool_border = [0xAD, 0xB5, 0xBD];
            border_secondary = [0x3A, 0x3A, 0x3A];
            border_muted = [0x3A, 0x3A, 0x3A];
            border_strong = [0x3A, 0x3A, 0x3A];
        }
    }

    let _ = &mut surface_hover;
    let border_divider = mix_oklab(border_base, 0.82, text_primary);
    let code_block_header_bg = if dark {
        surface_secondary
    } else {
        mix_oklab(surface_secondary, 0.78, text_primary)
    };
    let icon_toggle_active_ink = mix_oklab(
        mix_oklab(accent_primary, 0.80, text_on_accent),
        0.90,
        surface_base,
    );
    let tab_active_hover_bg = mix_srgb(text_primary, surface_base, 0.04);
    let tab_inactive_hover_bg = mix_srgb(text_primary, surface_secondary, 0.04);

    let mut out = base_tokens.clone();
    let mut set = |key: &str, value: String| {
        out.insert(key.to_owned(), Value::String(value));
    };

    set("surface-base", format_opaque(surface_base));
    set("surface-primary", format_opaque(surface_base));
    set("surface-field", format_opaque(surface_base));
    set("surface-secondary", format_opaque(surface_secondary));
    set("surface-muted", format_opaque(surface_muted));
    set("surface-shade-light", format_opaque(surface_shade_light));
    set("surface-chrome", format_opaque(surface_shade_light));
    set("surface-shade-strong", format_opaque(surface_shade_strong));
    set("surface-canvas", format_opaque(surface_shade_strong));
    set("surface-overlay", format_opaque(surface_shade_strong));
    set("surface-inset", format_opaque(surface_shade_strong));
    set("surface-code", format_opaque(surface_code));
    set("surface-subtle", format_opaque(surface_subtle));
    set("surface-control", format_opaque(surface_control));
    set("surface-hover", format_opaque(surface_hover));
    set(
        "surface-interactive-hover",
        format_opaque(surface_interactive_hover),
    );
    set("surface-hover-overlay", format_rgba(text_primary, 0.04));
    set("selection-neutral-bg", format_rgba(text_primary, 0.07));
    set(
        "selection-neutral-strong-bg",
        format_rgba(text_primary, 0.10),
    );
    set("menu-item-hover-bg", format_rgba(text_primary, 0.07));
    set(
        "menu-item-selected-bg",
        format_rgba(selection, if dark { 0.22 } else { 0.16 }),
    );
    set("message-part-hover", format_rgba(text_primary, 0.04));
    set("control-ghost-bg", format_rgba(text_primary, 0.06));
    set("scrollbar-thumb", format_rgba(text_muted, 0.18));
    set("scrollbar-thumb-hover", format_rgba(text_muted, 0.42));

    set("border-base", format_opaque(border_base));
    set("border-secondary", format_opaque(border_secondary));
    set("border-muted", format_opaque(border_muted));
    set("border-strong", format_opaque(border_strong));
    set("border-divider", format_opaque(border_divider));
    set("border-row", format_rgba(border_base, 0.78));
    set("border-critical", format_opaque(status_error));

    set("text-primary", format_opaque(text_primary));
    set("text-secondary", format_opaque(text_secondary));
    set("text-muted", format_opaque(text_muted));
    set("text-tertiary", format_opaque(text_muted));
    set("text-inverted", format_opaque(text_on_accent));
    set("text-on-accent", format_opaque(text_on_accent));
    set("button-danger-text", format_opaque(text_on_accent));
    set("icon-button-color", format_opaque(text_muted));
    set("icon-button-hover-color", format_opaque(text_primary));
    set("dropdown-highlight-text", format_opaque(text_primary));
    set("message-part-header-title", format_opaque(text_primary));
    if dark {
        set("message-part-header-type", format_opaque(text_muted));
    }
    set("log-level-default", format_opaque(text_primary));
    set(
        "log-level-debug",
        format_opaque(if dark { text_secondary } else { text_muted }),
    );
    set("log-level-warn", format_opaque(status_warning));
    set("log-level-error", format_opaque(status_error));

    set("accent-primary", format_opaque(accent_primary));
    set("accent-hover", format_opaque(accent_hover));
    set("focus-ring-color", format_opaque(accent_primary));
    set("focus-ring-offset", format_opaque(surface_shade_strong));

    if !dark {
        set("button-primary-bg", format_opaque(accent_primary));
        set("button-primary-hover-bg", format_opaque(accent_hover));
        set("button-primary-text", format_opaque(text_on_accent));
    }
    set("code-block-header-bg", format_opaque(code_block_header_bg));
    set(
        "icon-toggle-active-bg",
        format_rgba(icon_toggle_active_ink, 0.44),
    );
    set(
        "file-row-active-bg",
        format_rgba(icon_toggle_active_ink, 0.44),
    );
    set(
        "file-row-active-hover-bg",
        format_rgba(icon_toggle_active_ink, 0.56),
    );

    set(
        "list-item-highlight-bg",
        format_rgba(selection, if dark { 0.2 } else { 0.12 }),
    );
    set(
        "list-item-highlight-bg-solid",
        format_opaque(list_highlight_solid),
    );
    set(
        "session-user-active-bg",
        format_opaque(list_highlight_solid),
    );
    set(
        "session-assistant-active-bg",
        format_opaque(list_highlight_solid),
    );
    set(
        "list-item-highlight-border",
        format_rgba(selection, if dark { 0.4 } else { 0.25 }),
    );
    set("attachment-chip-bg", format_rgba(accent_primary, 0.1));
    set("attachment-chip-text", format_opaque(accent_primary));
    set(
        "attachment-chip-ring",
        format_rgba(accent_primary, if dark { 0.2 } else { 0.1 }),
    );
    set(
        "badge-neutral-bg",
        format_rgba(accent_primary, if dark { 0.15 } else { 0.05 }),
    );
    set("badge-neutral-text", format_opaque(accent_primary));
    set(
        "env-vars-bg",
        format_rgba(accent_primary, if dark { 0.2 } else { 0.1 }),
    );
    set(
        "env-vars-border",
        format_rgba(accent_primary, if dark { 0.3 } else { 0.2 }),
    );
    set("env-vars-text", format_opaque(accent_primary));
    set(
        "dropdown-highlight-bg",
        format_rgba(selection, if dark { 0.2 } else { 0.12 }),
    );
    set(
        "selection-highlight-bg",
        format_rgba(selection, if dark { 0.22 } else { 0.16 }),
    );
    set(
        "selection-highlight-strong-bg",
        format_rgba(selection, if dark { 0.32 } else { 0.24 }),
    );

    set("status-success", format_opaque(status_success));
    set("status-warning", format_opaque(status_warning));
    set("status-error", format_opaque(status_error));
    set("status-success-bg", format_rgba(status_success, 0.16));
    set("status-warning-bg", format_rgba(status_warning, 0.16));
    set("status-error-bg", format_rgba(status_error, 0.16));
    set("status-success-ring", format_rgba(status_success, 0.42));
    set("status-warning-ring", format_rgba(status_warning, 0.42));
    set("status-error-ring", format_rgba(status_error, 0.42));
    set("status-ready-fg", format_opaque(status_success));
    set("status-ready-bg", format_rgba(status_success, 0.16));
    set("status-starting-fg", format_opaque(status_warning));
    set("status-starting-bg", format_rgba(status_warning, 0.16));
    set("status-error-fg", format_opaque(status_error));

    set("message-user-bg", format_opaque(message_user_bg));
    set("message-user-border", format_opaque(user_accent));
    set("message-assistant-bg", format_opaque(message_assistant_bg));
    set("message-assistant-border", format_opaque(agent_accent));
    set("message-tool-bg", format_opaque(message_tool_bg));
    set("message-tool-border", format_opaque(message_tool_border));
    set(
        "session-status-compacting-fg",
        format_opaque(compaction_accent),
    );
    set(
        "session-status-compacting-bg",
        format_rgba(compaction_accent, if dark { 0.28 } else { 0.18 }),
    );

    set("kbd-bg", format_opaque(surface_secondary));
    set("kbd-border", format_opaque(border_base));
    set("kbd-text", format_opaque(text_primary));
    set("tab-active-bg", format_opaque(surface_base));
    set("tab-active-hover-bg", format_opaque(tab_active_hover_bg));
    set("tab-active-text", format_opaque(text_primary));
    set("tab-inactive-bg", format_opaque(surface_secondary));
    set(
        "tab-inactive-hover-bg",
        format_opaque(tab_inactive_hover_bg),
    );
    set("tab-inactive-text", format_opaque(text_muted));
    set("tab-rail-bg", format_opaque(surface_secondary));
    set("tab-border", format_opaque(border_base));
    set("new-tab-bg", format_opaque(surface_secondary));
    set("new-tab-hover-bg", format_opaque(surface_muted));
    set("new-tab-text", format_opaque(text_muted));

    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::palettes::{built_in, increased_contrast};

    fn parse_rgba(hex: &str) -> [u8; 4] {
        let hex = hex.strip_prefix('#').unwrap();
        [
            u8::from_str_radix(&hex[0..2], 16).unwrap(),
            u8::from_str_radix(&hex[2..4], 16).unwrap(),
            u8::from_str_radix(&hex[4..6], 16).unwrap(),
            u8::from_str_radix(&hex[6..8], 16).unwrap(),
        ]
    }

    #[test]
    fn runtime_derivation_matches_generated_palettes_json() {
        for palette in built_in() {
            let base_colors = palette.colors();
            let reference_base = built_in()
                .iter()
                .find(|candidate| candidate.id == if palette.dark { "classic" } else { "light" })
                .unwrap();
            for high_contrast in [false, true] {
                let expected = if high_contrast {
                    increased_contrast(Some(palette), palette.dark).unwrap()
                } else {
                    palette
                };
                let derived = derive_palette_colors(
                    Some(palette.id),
                    palette.dark,
                    high_contrast,
                    &base_colors,
                    reference_base.source()["colors"].as_object().unwrap(),
                );
                let actual_map = derived.as_object().unwrap();
                for (key, expected_val) in expected.source()["colors"].as_object().unwrap() {
                    let expected_rgba = parse_rgba(expected_val.as_str().unwrap());
                    let actual_rgba = parse_rgba(actual_map[key].as_str().unwrap());
                    // Canvas readback in generate-palettes.mjs quantizes low-alpha premultiplied RGB.
                    let tol = if expected_rgba[3] < 0x30 {
                        18
                    } else if expected_rgba[3] < 0xFF {
                        4
                    } else {
                        2
                    };
                    for channel in 0..4 {
                        let diff = expected_rgba[channel].abs_diff(actual_rgba[channel]);
                        assert!(
                            diff <= tol,
                            "palette={} hc={high_contrast} token={key} expected={} actual={} (channel {channel} diff={diff} > {tol})",
                            palette.id,
                            expected_val,
                            actual_map[key]
                        );
                    }
                }
            }
        }
    }
}
