//! Semantic application geometry. Values resolve from the generated CSS catalogue.
//! Layout assembly remains subject to native/browser screenshot qualification.
use crate::{Space, TextRole, kit, tokens};
use rune::{El, GrowthSpec, edit::TextEdit};
use std::{borrow::Cow, cell::Cell};

thread_local! { static APPEARANCE: Cell<bool> = const { Cell::new(false) }; }
pub fn dark() -> bool {
    APPEARANCE.get()
}
/// Install Rune's inherited ink for every render, including unstyled text and editors.
pub fn render<S, T>(cx: &mut rune::Cx<S>, build: impl FnOnce(&mut rune::Cx<S>) -> T) -> T {
    let dark = cx.system_dark();
    cx.foreground(tokens(dark).color("text-primary"));
    with_appearance(dark, || build(cx))
}
/// Bind one render's adapters to Rune's current system/CLI appearance.
pub fn with_appearance<T>(dark: bool, render: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            APPEARANCE.set(self.0);
        }
    }
    let _restore = Restore(APPEARANCE.replace(dark));
    render()
}
pub fn button(label: &str, disabled: bool) -> El {
    let t = tokens(dark());
    let label = label.to_owned();
    rune_kit::Button::new(&label)
        .disabled(disabled)
        .label_with(move |_, ink| rune::text(label).font(t.text(TextRole::Button)).color(ink))
        .build(kit(dark()))
        .h(t.metric("button", "minHeight").px())
        .px(t.metric("button", "paddingLeft").px())
        .py(t.metric("button", "paddingTop").px())
        .radius(t.number("button-radius").px())
}
pub fn input(edit: &TextEdit) -> El {
    // Rune's low-level editor retains the application's edit accessor and submit contract.
    rune::text_input(edit, tokens(dark()).text(TextRole::Body))
        .w_full()
        .padding(tokens(dark()).space(Space::Sm).px())
        .fill(tokens(dark()).color("surface-field"))
        .dir(rune::Direction::Auto)
}
/// Shared wrapping action groups follow the available native/browser width.
pub fn action_row() -> El {
    rune::row()
        .w_full()
        .flex_wrap()
        .items_center()
        .gap(tokens(dark()).space(Space::Sm).px())
}
pub fn font_families() -> (&'static str, &'static str) {
    let t = tokens(dark());
    (t.string("font-family-sans"), t.string("font-family-mono"))
}
pub fn initial_window() -> (f32, f32) {
    // The native host's local project window: src-tauri/src/local_windows.rs.
    (1400.0, 900.0)
}
pub fn app_spec<S: 'static>(
    title: &'static str,
    init: fn() -> S,
    view: fn(&S, &mut rune::Cx<S>) -> El,
) -> rune::AppSpec<S> {
    rune::AppSpec {
        families: font_families(),
        ..rune::AppSpec::new(title, initial_window(), init, view)
    }
}
pub fn transcript_rows<S: 'static>(
    count: usize,
    key: impl for<'a> Fn(&'a S, usize) -> Cow<'a, str> + 'static,
    build: impl Fn(&S, usize) -> El + 'static,
) -> El {
    // Solid virtual-follow-measurements.ts uses a 40px first-row fallback;
    // the matching CSS touch-target token keeps this estimate in the shared scale.
    let appearance = dark();
    rune::col()
        .w_full()
        .growth(GrowthSpec::default())
        .virtual_rows(
            count,
            tokens(dark()).length(crate::Length::TouchTarget).px(),
            key,
            move |state, index| with_appearance(appearance, || build(state, index)),
        )
}
pub fn composer(editor: El) -> El {
    // Current prompt-input.css editor bounds. A dedicated shared variant preserves them.
    rune::auto_grow(editor, 1, usize::MAX)
        .min_h(104.0)
        .max_h(320.0)
}
pub trait Layout {
    fn locale_direction(self, locale: &str) -> Self;
    fn literal_direction(self) -> Self;
    fn content_direction(self) -> Self;
    /// ```compile_fail
    /// use rune_theme_codenomad::layout::Layout;
    /// rune::col().pad(17.0);
    /// ```
    fn full_width(self) -> Self;
    fn full_height(self) -> Self;
    fn remaining(self) -> Self;
    fn pad(self, space: Space) -> Self;
    fn separate(self, space: Space) -> Self;
    fn reading_surface(self) -> Self;
    fn field_surface(self) -> Self;
    fn inset_surface(self) -> Self;
    fn text_role(self, role: TextRole) -> Self;
    fn hint(self, label: &str) -> Self;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_geometry_tracks_the_shared_sources() {
        let composer = include_str!("../../../packages/ui/src/styles/messaging/prompt-input.css");
        assert!(composer.contains("min-height: 104px;"));
        assert!(composer.contains("max-height: 320px;"));
        let host = include_str!("../../../packages/tauri-app/src-tauri/src/local_windows.rs");
        assert!(host.contains(".inner_size(1400.0, 900.0)"));
        assert_eq!(initial_window(), (1400.0, 900.0));
    }
    #[test]
    fn render_appearance_is_scoped_and_tracks_rune() {
        assert!(!dark());
        with_appearance(true, || {
            assert!(dark());
            with_appearance(false, || assert!(!dark()));
            assert!(dark());
        });
        assert!(!dark());
    }
    #[test]
    fn inherited_ink_tracks_system_changes_for_bare_text_titles_and_editors() {
        fn view(edit: &TextEdit, cx: &mut rune::Cx<TextEdit>) -> El {
            render(cx, |_| {
                rune::col()
                    .w_full()
                    .h_full()
                    .reading_surface()
                    .child(rune::text("Bare text").key("bare"))
                    .child(rune::text("Title").key("title").text_role(TextRole::Title))
                    .child(input(edit).key("editor"))
            })
        }
        let mut runtime = rune::Runtime::new(
            TextEdit::new("Typed text"),
            view,
            (320.0, 180.0),
            rune::Env::new(false, 1.0),
        );
        for dark in [false, true, false] {
            runtime.set_system_dark(dark);
            // ElementInfo exposes the presented P_TEXT colour, which transitions after
            // a theme commit; advance the real virtual clock before checking its endpoint.
            for _ in 0..120 {
                runtime.frame(1.0 / 60.0);
            }
            for key in ["bare", "title", "editor"] {
                let node = runtime
                    .elements()
                    .into_iter()
                    .find(|node| node.key.as_deref() == Some(key))
                    .unwrap();
                assert_eq!(
                    node.text_color,
                    Some(tokens(dark).color("text-primary")),
                    "inherited ink for {key}"
                );
            }
        }
    }
}
impl Layout for El {
    fn locale_direction(self, locale: &str) -> Self {
        self.dir(if crate::catalogue::direction(locale) == "rtl" {
            rune::Direction::Rtl
        } else {
            rune::Direction::Ltr
        })
    }
    fn literal_direction(self) -> Self {
        self.dir(rune::Direction::Ltr)
    }
    fn content_direction(self) -> Self {
        self.dir(rune::Direction::Auto).dir_by_paragraph()
    }
    fn full_width(self) -> Self {
        self.w_full()
    }
    fn full_height(self) -> Self {
        self.h_full()
    }
    fn remaining(self) -> Self {
        self.grow(1.0).min_h(0.0)
    }
    fn pad(self, space: Space) -> Self {
        self.padding(tokens(dark()).space(space).px())
    }
    fn separate(self, space: Space) -> Self {
        self.gap(tokens(dark()).space(space).px())
    }
    fn reading_surface(self) -> Self {
        self.fill(tokens(dark()).color("surface-canvas"))
            .color(tokens(dark()).color("text-primary"))
    }
    fn field_surface(self) -> Self {
        self.fill(tokens(dark()).color("surface-field"))
    }
    fn inset_surface(self) -> Self {
        self.fill(tokens(dark()).color("surface-inset"))
    }
    fn text_role(self, role: TextRole) -> Self {
        self.font(tokens(dark()).text(role))
    }
    fn hint(self, label: &str) -> Self {
        self.placeholder(label, tokens(dark()).color("text-muted"))
    }
}
