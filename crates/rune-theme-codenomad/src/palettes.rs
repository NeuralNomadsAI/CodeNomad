//! Built-in palettes resolved by the same Solid CSS pipeline as the default tokens.
use rune::Theme;
use rune_kit::Kit;
use serde_json::Value;
use std::{cell::Cell, sync::OnceLock};

pub struct Palette {
    pub id: &'static str,
    pub label: &'static str,
    pub dark: bool,
    source: &'static Value,
    theme: OnceLock<Theme>,
    pub(crate) kit: OnceLock<Kit>,
    pub(crate) field: OnceLock<Kit>,
}
impl Palette {
    pub(crate) fn theme(&self) -> &Theme {
        self.theme.get_or_init(|| {
            let mode = if self.dark { "dark" } else { "light" };
            let document = serde_json::json!({
                "name": self.id, "blend": crate::document()["blend"],
                (mode): self.source["colors"],
            });
            Theme::from_value(&document, self.dark).expect("generated palette tokens")
        })
    }

    pub(crate) fn shadow(&self, name: &str) -> &'static str {
        self.source["shadows"][name]
            .as_str()
            .expect("generated palette shadow")
    }
}

pub fn built_in() -> &'static [Palette] {
    static SOURCE: OnceLock<Vec<Value>> = OnceLock::new();
    static PALETTES: OnceLock<Vec<Palette>> = OnceLock::new();
    PALETTES.get_or_init(|| {
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
                source,
                theme: OnceLock::new(),
                kit: OnceLock::new(),
                field: OnceLock::new(),
            })
            .collect()
    })
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
