//! Built-in and runtime-derived custom palettes resolved by the same Solid CSS pipeline.
mod derive;
pub use derive::{
    ColorField, ColorSchemeColors, contrast_ratio, format_hex, high_contrast_colors,
    is_canonical_hex, luminance, normalize_hex, parse_rgb,
};

use rune::Theme;
use rune_kit::Kit;
use serde_json::Value;
use std::{
    cell::{Cell, OnceCell, RefCell},
    rc::Rc,
    sync::OnceLock,
};

pub struct Palette {
    pub id: &'static str,
    pub label: &'static str,
    pub dark: bool,
    high_contrast: bool,
    source: &'static Value,
    theme: OnceLock<Theme>,
    pub(crate) kit: OnceLock<Kit>,
    pub(crate) field: OnceLock<Kit>,
    pub(crate) code: OnceLock<Kit>,
}
impl Palette {
    pub(super) fn source(&self) -> &'static Value {
        if self.high_contrast {
            &self.source["contrast"]
        } else {
            self.source
        }
    }

    /// The palette's 13 canonical base input colors (before high-contrast stretching).
    pub fn colors(&self) -> ColorSchemeColors {
        ColorSchemeColors::from_token_map(&self.source["colors"])
            .expect("generated palette base colors")
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PaletteKey {
    BuiltIn(&'static str, bool),
    Custom(u64),
}

pub struct CustomPalette {
    id: String,
    dark: bool,
    generation: u64,
    base: &'static Palette,
    theme: Theme,
    kit: OnceCell<Kit>,
    field: OnceCell<Kit>,
    code: OnceCell<Kit>,
}

impl CustomPalette {
    fn new(id: Option<&str>, dark: bool, high_contrast: bool, colors: &ColorSchemeColors) -> Self {
        thread_local! {
            static NEXT_GENERATION: Cell<u64> = const { Cell::new(1) };
        }
        let generation = NEXT_GENERATION.with(|next| {
            let current = next.get();
            next.set(current.wrapping_add(1).max(1));
            current
        });
        let base_id = if dark { "classic" } else { "light" };
        let base = built_in()
            .iter()
            .find(|palette| palette.id == base_id)
            .expect("built-in base palette");
        let base_tokens = base.source()["colors"]
            .as_object()
            .expect("generated base palette colors");
        let derived = derive::derive_palette_colors(id, dark, high_contrast, colors, base_tokens);
        let mode = if dark { "dark" } else { "light" };
        let name = id.unwrap_or("custom").to_owned();
        let document = serde_json::json!({
            "name": name,
            "blend": crate::document()["blend"],
            (mode): derived,
        });
        let theme = Theme::from_value(&document, dark).expect("derived custom palette tokens");
        Self {
            id: name,
            dark,
            generation,
            base,
            theme,
            kit: OnceCell::new(),
            field: OnceCell::new(),
            code: OnceCell::new(),
        }
    }

    pub(crate) fn theme(&self) -> &Theme {
        &self.theme
    }

    pub(crate) fn kit(&self) -> &Kit {
        self.kit.get_or_init(|| {
            crate::kit::build_from(
                self.dark,
                |name| self.theme.color(name),
                |name| self.base.shadow(name),
            )
        })
    }

    pub(crate) fn field_kit(&self) -> &Kit {
        self.field.get_or_init(|| {
            let mut kit = self.kit().clone();
            kit.c.bg_base = kit.c.surface_base;
            kit
        })
    }

    pub(crate) fn code_kit(&self) -> &Kit {
        self.code.get_or_init(|| {
            crate::document_reader::editor::build_code_kit(
                self.dark,
                self.kit(),
                self.theme.color("surface-inset"),
            )
        })
    }

    pub(crate) fn shadow(&self, name: &str) -> &'static str {
        self.base.shadow(name)
    }
}

#[derive(Clone)]
pub enum ResolvedPalette {
    BuiltIn(&'static Palette),
    Custom(Rc<CustomPalette>),
}

impl ResolvedPalette {
    pub fn id(&self) -> &str {
        match self {
            Self::BuiltIn(palette) => palette.id,
            Self::Custom(palette) => &palette.id,
        }
    }

    pub fn dark(&self) -> bool {
        match self {
            Self::BuiltIn(palette) => palette.dark,
            Self::Custom(palette) => palette.dark,
        }
    }

    pub(crate) fn cache_key(&self) -> PaletteKey {
        match self {
            Self::BuiltIn(palette) => PaletteKey::BuiltIn(palette.id, palette.is_high_contrast()),
            Self::Custom(palette) => PaletteKey::Custom(palette.generation),
        }
    }

    pub(crate) fn shadow(&self, name: &str) -> &'static str {
        match self {
            Self::BuiltIn(palette) => palette.shadow(name),
            Self::Custom(palette) => palette.shadow(name),
        }
    }
}

impl From<&'static Palette> for ResolvedPalette {
    fn from(palette: &'static Palette) -> Self {
        Self::BuiltIn(palette)
    }
}

#[derive(Clone, PartialEq, Eq)]
struct CustomCacheKey {
    id: Option<String>,
    dark: bool,
    high_contrast: bool,
    colors: ColorSchemeColors,
}

const CUSTOM_CACHE_LIMIT: usize = 8;

/// Resolves a custom or overridden 13-color palette, caching recent derived instances
/// per thread so repeated frames reuse the built `Theme` and `Kit` without leaking.
pub fn custom(
    id: Option<&str>,
    dark: bool,
    high_contrast: bool,
    colors: ColorSchemeColors,
) -> ResolvedPalette {
    thread_local! {
        static CACHE: RefCell<Vec<(CustomCacheKey, Rc<CustomPalette>)>> = const { RefCell::new(Vec::new()) };
    }
    let key = CustomCacheKey {
        id: id.map(str::to_owned),
        dark,
        high_contrast,
        colors,
    };
    CACHE.with(|cache| {
        let mut entries = cache.borrow_mut();
        if let Some(pos) = entries.iter().position(|(k, _)| k == &key) {
            let entry = entries.remove(pos);
            let resolved = Rc::clone(&entry.1);
            entries.push(entry);
            return ResolvedPalette::Custom(resolved);
        }
        let palette = Rc::new(CustomPalette::new(
            key.id.as_deref(),
            dark,
            high_contrast,
            &key.colors,
        ));
        if entries.len() >= CUSTOM_CACHE_LIMIT {
            entries.remove(0);
        }
        entries.push((key, Rc::clone(&palette)));
        ResolvedPalette::Custom(palette)
    })
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
                code: OnceLock::new(),
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

thread_local! { static ACTIVE: RefCell<Option<ResolvedPalette>> = const { RefCell::new(None) }; }

pub(crate) fn active(dark: bool) -> Option<ResolvedPalette> {
    current().filter(|palette| palette.dark() == dark)
}

pub(crate) fn current() -> Option<ResolvedPalette> {
    ACTIVE.with(|cell| cell.borrow().clone())
}

pub fn with_resolved<T>(palette: Option<ResolvedPalette>, render: impl FnOnce() -> T) -> T {
    struct Restore(Option<ResolvedPalette>);
    impl Drop for Restore {
        fn drop(&mut self) {
            ACTIVE.with(|cell| *cell.borrow_mut() = self.0.take());
        }
    }
    let previous = ACTIVE.with(|cell| std::mem::replace(&mut *cell.borrow_mut(), palette));
    let _restore = Restore(previous);
    render()
}

pub fn with_palette<T>(palette: Option<&'static Palette>, render: impl FnOnce() -> T) -> T {
    with_resolved(palette.map(ResolvedPalette::BuiltIn), render)
}
