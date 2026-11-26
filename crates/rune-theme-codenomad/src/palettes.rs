//! Built-in palettes resolved by the same Solid CSS pipeline as the default tokens.
use rune::Theme;
use rune_kit::Kit;
use serde_json::Value;
use std::{cell::Cell, sync::OnceLock};

pub struct Palette {
    pub id: &'static str,
    pub label: &'static str,
    pub dark: bool,
    high_contrast: bool,
    source: &'static Value,
    theme: OnceLock<Theme>,
    pub(crate) kit: OnceLock<Kit>,
    pub(crate) field: OnceLock<Kit>,
}
impl Palette {
    fn source(&self) -> &'static Value {
        if self.high_contrast {
            &self.source["contrast"]
        } else {
            self.source
        }
    }

    pub(crate) fn is_high_contrast(&self) -> bool {
        self.high_contrast
    }

    pub(crate) fn theme(&self) -> &Theme {
        self.theme.get_or_init(|| {
            let mode = if self.dark { "dark" } else { "light" };
            let document = serde_json::json!({
                "name": self.id, "blend": crate::document()["blend"],
                (mode): self.source()["colors"],
            });
            Theme::from_value(&document, self.dark).expect("generated palette tokens")
        })
    }

    pub(crate) fn shadow(&self, name: &str) -> &'static str {
        self.source()["shadows"][name]
            .as_str()
            .expect("generated palette shadow")
    }
}

pub fn built_in() -> &'static [Palette] {
    variants(false)
}

pub fn increased_contrast(palette: Option<&Palette>, dark: bool) -> Option<&'static Palette> {
    let id = palette.map_or(if dark { "classic" } else { "light" }, |palette| palette.id);
    variants(true)
        .iter()
        .find(|variant| variant.id == id && variant.dark == dark)
}

fn variants(high_contrast: bool) -> &'static [Palette] {
    static SOURCE: OnceLock<Vec<Value>> = OnceLock::new();
    static PALETTES: OnceLock<Vec<Palette>> = OnceLock::new();
    static CONTRAST: OnceLock<Vec<Palette>> = OnceLock::new();
    let cache = if high_contrast { &CONTRAST } else { &PALETTES };
    cache.get_or_init(|| {
        SOURCE
            .get_or_init(|| {
                serde_json::from_str(include_str!("../assets/palettes.json"))
                    .expect("generated palettes")
            })
            .iter()
            .map(|source| Palette {
                id: source["id"].as_str().expect("generated palette ID"),
                label: source["labelKey"]
                    .as_str()
                    .expect("generated palette label"),
                dark: source["appearance"] == "dark",
                high_contrast,
                source,
                theme: OnceLock::new(),
                kit: OnceLock::new(),
                field: OnceLock::new(),
            })
            .collect()
    })
}

#[cfg(test)]
#[test]
fn both_palette_variants_cover_the_source_colours() {
    for palette in variants(false).iter().chain(variants(true)) {
        let mode = if palette.dark { "dark" } else { "light" };
        for key in crate::document()["product"][mode]["colors"]
            .as_object()
            .unwrap()
            .keys()
        {
            assert!(
                palette.source()["colors"][key].is_string(),
                "{} is missing {key}",
                palette.id
            );
        }
    }
}

#[cfg(test)]
#[test]
fn high_contrast_changes_default_surfaces_without_flipping_filled_ink() {
    for palette in built_in() {
        let contrast = increased_contrast(Some(palette), palette.dark).unwrap();
        assert_ne!(palette.source()["colors"], contrast.source()["colors"]);
        assert_eq!(
            palette.source()["colors"]["text-on-accent"],
            contrast.source()["colors"]["text-on-accent"]
        );
    }
}

thread_local! { static ACTIVE: Cell<Option<&'static Palette>> = const { Cell::new(None) }; }
pub(crate) fn active(dark: bool) -> Option<&'static Palette> {
    current().filter(|palette| palette.dark == dark)
}
pub(crate) fn current() -> Option<&'static Palette> {
    ACTIVE.get()
}
pub fn with_palette<T>(palette: Option<&'static Palette>, render: impl FnOnce() -> T) -> T {
    struct Restore(Option<&'static Palette>);
    impl Drop for Restore {
        fn drop(&mut self) {
            ACTIVE.set(self.0);
        }
    }
    let _restore = Restore(ACTIVE.replace(palette));
    render()
}
