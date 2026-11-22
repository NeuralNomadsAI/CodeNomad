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
pub fn button<S: 'static>(label: &str, disabled: bool, press: impl Fn(&mut S) + 'static) -> El {
    button_tx(label, disabled, move |s, _| press(s))
}
pub fn button_tx<S: 'static>(
    label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    rune_kit::Button::new(label)
        .disabled(disabled)
        .on_press_tx(press)
        .build(kit(dark()))
}
pub fn input(edit: &TextEdit) -> El {
    // Rune's low-level editor retains the application's edit accessor and submit contract.
    rune::text_input(edit, tokens(dark()).text(TextRole::Body))
        .w_full()
        .padding(tokens(dark()).space(Space::Sm).px())
        .fill(tokens(dark()).color("surface-field"))
        .dir(rune::Direction::Auto)
}
pub fn field(edit: &TextEdit) -> rune_kit::TextInput {
    rune_kit::TextInput::new(edit).width(None)
}
pub fn literal_field(edit: &TextEdit) -> rune_kit::TextInput {
    field(edit).dir(rune::Direction::Ltr)
}
pub fn hinted_field(edit: &TextEdit, hint: &str) -> rune_kit::TextInput {
    field(edit).placeholder(hint)
}
pub fn textarea(edit: &TextEdit) -> rune_kit::TextArea {
    rune_kit::TextArea::new(edit).width(None).auto_grow(1, 1)
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
pub fn run<S: 'static>(spec: rune::AppSpec<S>, closing: fn(&mut S, &mut rune::Tx)) {
    rune::App::new(spec)
        .on_close(closing)
        .on_quit(closing)
        .run();
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
    composer_bounds(editor, 104.0)
}
pub fn compact_composer(editor: El) -> El {
    let t = tokens(dark());
    composer_bounds(
        editor,
        t.text(TextRole::Body).line_px() + t.space(Space::Sm).px() * 2.0,
    )
}
fn composer_bounds(editor: El, minimum: f32) -> El {
    // The editor owns the whole painted space, including blank lines above the minimum.
    rune::auto_grow(editor.min_h(minimum), 1, usize::MAX)
        .min_h(minimum)
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
    fn shared_button_preserves_kit_geometry_and_disabled_semantics() {
        fn view(&(direct, disabled): &(bool, bool), cx: &mut rune::Cx<(bool, bool)>) -> El {
            render(cx, |_| {
                if direct {
                    rune_kit::Button::new("Save")
                        .disabled(disabled)
                        .on_press(|_: &mut (bool, bool)| {})
                        .build(kit(dark()))
                } else {
                    button("Save", disabled, |_: &mut (bool, bool)| {})
                }
            })
        }
        for dark in [false, true] {
            for disabled in [false, true] {
                let inspect = |direct| {
                    let mut rt = rune::Runtime::new(
                        (direct, disabled),
                        view,
                        (320.0, 180.0),
                        rune::Env::new(dark, 1.0),
                    );
                    rt.frame(1.0);
                    rt.elements()
                        .into_iter()
                        .map(|e| {
                            (
                                e.role,
                                e.label,
                                e.rect,
                                e.radius,
                                e.fill,
                                e.text_color,
                                e.focusable,
                                e.inert,
                                e.opacity,
                            )
                        })
                        .collect::<Vec<_>>()
                };
                assert_eq!(inspect(false), inspect(true));
            }
        }
    }
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
                    .child(field(edit).build(crate::field_kit(dark())).key("field"))
                    .child(textarea(edit).build(crate::field_kit(dark())).key("area"))
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
            for key in ["field", "area"] {
                let node = runtime
                    .elements()
                    .into_iter()
                    .find(|node| node.key.as_deref() == Some(key))
                    .unwrap();
                assert_eq!(node.fill, tokens(dark).color("surface-field"));
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
