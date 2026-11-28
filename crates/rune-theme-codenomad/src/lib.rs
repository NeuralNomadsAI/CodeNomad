//! Generated CodeNomad design tokens and shared UI messages for the native application.
#![forbid(unsafe_code)]
pub mod action_menu;
#[cfg(feature = "test-support")]
pub mod action_menu_scene;
pub mod ansi;
pub mod attachment;
pub mod catalogue;
pub mod clipboard;
pub mod document_reader;
pub mod empty_state;
pub mod file_row_actions;
pub mod form_controls;
mod generated_catalogues;
mod generated_layout;
pub mod git_diff;
pub mod git_panel;
pub mod interruption;
mod kit;
pub mod launcher;
pub mod layout;
pub mod markdown;
pub mod palettes;
pub mod provider_usage;
pub mod settings;
pub mod shell;
pub mod tabs;
pub mod timeline;
mod tokens;
pub mod transcript;
pub mod usage;
pub mod window_control;
pub mod workspace_tree;
pub use kit::{KitRef, field_kit, kit};
use rune::Theme;
use serde_json::Value;
use std::{ops::Deref, rc::Rc, sync::OnceLock};
pub use tokens::{Dimension, Length, MotionRole, Space, TextRole, Tokens, tokens};

pub enum ThemeRef {
    Static(&'static Theme),
    Dynamic(Rc<palettes::CustomPalette>),
}

impl Deref for ThemeRef {
    type Target = Theme;
    fn deref(&self) -> &Theme {
        match self {
            Self::Static(theme) => theme,
            Self::Dynamic(palette) => palette.theme(),
        }
    }
}

pub const THEME: &str = include_str!("../assets/theme.json");
fn document() -> &'static Value {
    static DOCUMENT: OnceLock<Value> = OnceLock::new();
    DOCUMENT.get_or_init(|| serde_json::from_str(THEME).expect("generated CodeNomad theme"))
}
pub fn theme(dark: bool) -> ThemeRef {
    if let Some(palette) = palettes::active(dark) {
        return match palette {
            palettes::ResolvedPalette::BuiltIn(palette) => ThemeRef::Static(palette.theme()),
            palettes::ResolvedPalette::Custom(palette) => ThemeRef::Dynamic(palette),
        };
    }
    static THEMES: [OnceLock<Theme>; 4] = [const { OnceLock::new() }; 4];
    ThemeRef::Static(THEMES[palette_index(dark)].get_or_init(|| {
        let doc = document();
        if layout::source_palette() {
            let product = serde_json::json!({
                "blend": doc["blend"],
                "name": doc["name"],
                "light": doc["product"]["light"]["colors"],
                "dark": doc["product"]["dark"]["colors"],
            });
            Theme::from_value(&product, dark)
        } else {
            Theme::from_value(doc, dark)
        }
        .expect("generated CodeNomad colors")
    }))
}
fn palette_index(dark: bool) -> usize {
    2 * usize::from(layout::source_palette()) + usize::from(dark)
}
pub fn qualification_gaps() -> &'static [Value] {
    document()["gaps"]
        .as_array()
        .expect("theme qualification gaps")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn both_appearances_resolve_all_shared_tokens() {
        for dark in [false, true] {
            let tokens = tokens(dark);
            assert_eq!(tokens.space(Space::Md).px(), 12.0);
            assert_eq!(tokens.length(Length::Control).px(), 28.0);
            assert_eq!(tokens.number("radius-md").px(), 0.0);
            for name in document()[if dark { "dark" } else { "light" }]
                .as_object()
                .unwrap()
                .keys()
            {
                let _ = tokens.color(name);
            }
            let kit = kit(dark);
            assert_eq!(kit.dark, dark);
            assert_eq!(kit.radius.md, 0.0);
            assert!(tokens.string("font-family-sans").contains("Segoe UI"));
        }
        assert_ne!(
            tokens(false).color("surface-field"),
            tokens(true).color("surface-field")
        );
    }
}
