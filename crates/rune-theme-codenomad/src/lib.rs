//! Generated CodeNomad design tokens and shared UI messages for the native application.
#![forbid(unsafe_code)]
pub mod action_menu;
#[cfg(feature = "test-support")]
pub mod action_menu_scene;
pub mod catalogue;
mod generated_catalogues;
pub mod interruption;
mod kit;
pub mod layout;
pub mod tabs;
mod tokens;
pub mod window_control;
pub mod workspace_tree;
pub use kit::kit;
use rune::Theme;
use serde_json::Value;
use std::sync::OnceLock;
pub use tokens::{Dimension, Length, MotionRole, Space, TextRole, Tokens, tokens};

pub const THEME: &str = include_str!("../assets/theme.json");
fn document() -> &'static Value {
    static DOCUMENT: OnceLock<Value> = OnceLock::new();
    DOCUMENT.get_or_init(|| serde_json::from_str(THEME).expect("generated CodeNomad theme"))
}
pub fn theme(dark: bool) -> &'static Theme {
    static THEMES: [OnceLock<Theme>; 2] = [const { OnceLock::new() }; 2];
    THEMES[dark as usize]
        .get_or_init(|| Theme::from_value(document(), dark).expect("generated CodeNomad colors"))
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
    #[test]
    fn source_provider_body_and_component_tracking_reach_rune_styles() {
        for dark in [false, true] {
            let t = tokens(dark);
            let body = t.text(TextRole::Body);
            assert_eq!(
                (body.size, body.line_height, body.weight),
                (16.0, 24.0, 400.0)
            );
            assert!((body.tracking - 0.15008).abs() < f32::EPSILON);
            assert_eq!(t.text(TextRole::Mono).tracking, 0.0);
            let ui = kit(dark).ty.ui;
            assert_eq!((ui.size, ui.line_height), (12.0, 18.0));
            assert_eq!(ui.size, t.metric("input", "fontSize").px());
            assert_eq!(ui.size, t.metric("composerInput", "fontSize").px());
            assert_ne!(
                ui.size, body.size,
                "Field and reading typography have distinct Source contracts"
            );
            for role in [TextRole::Button, TextRole::Label, TextRole::Title] {
                assert!(t.text(role).tracking.is_finite());
            }
            let mode = if dark { "dark" } else { "light" };
            assert_eq!(
                document()["context"]["appearances"][mode]["kind"],
                "product-default"
            );
            assert_eq!(
                document()["context"]["appearances"][mode]["palette"]["id"],
                if dark { "mist" } else { "porcelain" }
            );
        }
    }
}
