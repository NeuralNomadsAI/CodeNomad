//! Semantic application geometry. Values resolve from the generated CSS catalogue.
//! Layout assembly remains subject to native/browser screenshot qualification.
use crate::{Space, TextRole, kit, tokens};
use rune::{El, GrowthSpec, edit::TextEdit};
use std::{borrow::Cow, cell::Cell, rc::Rc};

thread_local! { static APPEARANCE: Cell<bool> = const { Cell::new(false) }; }
pub type DrawnRect = rune::Live<[f32; 4]>;

thread_local! { static SOURCE_PALETTE: Cell<bool> = const { Cell::new(false) }; }
pub(crate) fn source_palette() -> bool {
    SOURCE_PALETTE.get()
}
/// Use Solid's product defaults where the app hasn't selected a palette.
pub fn with_source_palette<T>(render: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            SOURCE_PALETTE.set(self.0);
        }
    }
    let _restore = Restore(SOURCE_PALETTE.replace(true));
    render()
}
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
    let action = Rc::new(press);
    let press = action.clone();
    let button = rune_kit::Button::new(label)
        .disabled(disabled)
        .on_press_tx(move |s, tx| press(s, tx))
        .build(kit(dark()));
    if disabled {
        button
    } else {
        button.on_key(enter_action(action))
    }
}
/// Disabled kit button visuals that remain keyboard-focusable (`aria-disabled`).
pub fn focusable_disabled_button(label: &str) -> El {
    rune_kit::Button::new(label)
        .disabled(true)
        .build(kit(dark()))
        .disabled(false)
        .focusable(true)
        .aria_disabled(true)
}

pub(crate) fn enter_action<S: 'static>(
    action: Rc<impl Fn(&mut S, &mut rune::Tx) + 'static>,
) -> impl Fn(&mut S, &rune::KeyEvent, &mut rune::Tx) -> bool + 'static {
    move |s, key, tx| {
        if key.key != rune::Key::Enter || key.mods != rune::Mods::default() {
            return false;
        }
        if !tx.key_repeat() {
            action(s, tx);
        }
        true
    }
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
fn composer_focus_inset(k: &rune_kit::Kit) -> f32 {
    let field = k
        .metrics
        .field
        .unwrap_or_else(|| rune_kit::FieldMetrics::kit(k));
    (-field.focus_offset).max(0.0)
}
pub fn composer_textarea(edit: &TextEdit, placeholder: &str, compact: bool) -> rune_kit::TextArea {
    let k = crate::field_kit(dark());
    let metrics = k
        .metrics
        .text_area
        .unwrap_or_else(|| rune_kit::TextAreaMetrics::kit(k));
    let inset = composer_focus_inset(k);
    let max_inner = (320.0 - 2.0 * (metrics.padding + inset)).max(metrics.style.line_px());
    rune_kit::TextArea::new(edit)
        .width(None)
        .placeholder(placeholder)
        .auto_grow(if compact { 1 } else { 4 }, 20)
        .max_height(max_inner)
}
pub fn build_composer(
    area: rune_kit::TextArea,
    trailing: El,
    focused: bool,
    disabled: bool,
    compact: bool,
) -> El {
    // Deliberate shortcut: pinned rune_kit::TextArea::trailing shares its row direction with
    // the inner editor and lacks TextArea::dir / dir_by_paragraph, so placing content_direction()
    // outside TextArea flips Send with draft script. Upgrade to TextArea::trailing directly once
    // Rune forwards per-paragraph direction to TextArea's inner text_input leaf.
    let k = crate::field_kit(dark());
    let field = k
        .metrics
        .field
        .unwrap_or_else(|| rune_kit::FieldMetrics::kit(k));
    let padding = k
        .metrics
        .text_area
        .unwrap_or_else(|| rune_kit::TextAreaMetrics::kit(k))
        .padding;
    let inset = composer_focus_inset(k);
    let editor = rune::col()
        .content_direction()
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .child(
            area.plain()
                .disabled(disabled)
                .build(k)
                .fill(k.c.bg_base)
                .key("composer"),
        );
    let trailing = rune::row()
        .key("trailing")
        .self_end()
        .pr((padding - inset).max(0.0))
        .pb((padding - inset).max(0.0))
        .child(trailing);
    let mut shell = rune::row()
        .key("composer-box")
        .w_full()
        .padding(inset)
        .fill(k.c.bg_base)
        .radius(field.radius)
        .child(editor)
        .child(trailing);
    if !compact {
        shell = shell.min_h(104.0);
    }
    if disabled {
        return k.elevate(shell, k.elevation.input());
    }
    if let Some(highlight) = k.forced {
        let shell = shell.border(1.0, k.c.text_base);
        return if focused {
            shell.outline(2.0, 2.0, highlight)
        } else {
            shell
        };
    }
    if focused {
        shell.outline(field.focus_width, field.focus_offset, k.c.border_focus)
    } else {
        k.elevate(shell, k.elevation.input())
    }
}
pub fn editor_menu<S: 'static>(
    tx: &mut rune::Tx,
    point: (f32, f32),
    selected: bool,
    pick: impl FnOnce(&mut S, Option<&str>, &mut rune::Tx) + 'static,
) {
    use rune::{Label, PopupItem, PopupMenu, labels::label};
    let mut menu = PopupMenu::new()
        .item(PopupItem::new("cut", label(Label::Cut)).enabled(selected))
        .item(PopupItem::new("copy", label(Label::Copy)).enabled(selected))
        .item(PopupItem::new("paste", label(Label::Paste)));
    if !cfg!(target_os = "macos") {
        menu = menu.item(PopupItem::new("select-all", label(Label::SelectAll)));
    }
    tx.popup_menu(menu, point, pick);
}
pub fn announce_polite(tx: &mut rune::Tx, text: impl Into<String>) {
    tx.announce(text, rune::LiveRegion::Polite);
}

pub fn announce_alert(tx: &mut rune::Tx, message: &str) {
    tx.announce(message, rune::LiveRegion::Assertive);
}

pub fn suggestion_list<S: 'static>(
    key: &str,
    anchor: &str,
    label: &str,
    empty: &str,
    active: usize,
    items: impl IntoIterator<Item = (String, String)>,
) -> rune_kit::PopupList<S> {
    rune_kit::PopupList::new(key, anchor)
        .label(label)
        .empty_message(empty)
        .active(Some(active))
        .items(
            items
                .into_iter()
                .enumerate()
                .map(|(index, (name, description))| {
                    rune_kit::PopupItem::new(index.to_string(), name).description(description)
                }),
        )
}
pub fn with_overlays(base: El, layers: Vec<El>) -> El {
    rune_kit::root(base, layers)
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
    let palette = crate::palettes::current();
    rune::col()
        .w_full()
        .growth(GrowthSpec::default())
        .virtual_rows(
            count,
            tokens(dark()).length(crate::Length::TouchTarget).px(),
            key,
            move |state, index| {
                crate::palettes::with_palette(palette, || {
                    with_appearance(appearance, || build(state, index))
                })
            },
        )
}
pub fn composer<S>(editor: El, scroll_stack: Option<&rune::Cx<S>>) -> El {
    composer_bounds(editor, 104.0, scroll_stack)
}
pub fn compact_composer<S>(editor: El, scroll_stack: Option<&rune::Cx<S>>) -> El {
    let t = tokens(dark());
    composer_bounds(
        editor,
        t.text(TextRole::Body).line_px() + t.space(Space::Sm).px() * 2.0,
        scroll_stack,
    )
}
fn composer_bounds<S>(editor: El, minimum: f32, scroll_stack: Option<&rune::Cx<S>>) -> El {
    const MAX_HEIGHT: f32 = 320.0;
    let editor = editor.min_h(minimum);
    if scroll_stack.is_some_and(|cx| {
        cx.layout_size("composer")
            .is_none_or(|size| size[1] <= MAX_HEIGHT)
    }) {
        return rune::col()
            .key("scroll")
            .w_full()
            .min_h(minimum)
            .max_h(MAX_HEIGHT)
            .child(editor);
    }
    // The editor owns the whole painted space, including blank lines above the minimum.
    rune::auto_grow(editor, 1, usize::MAX)
        .min_h(minimum)
        .max_h(MAX_HEIGHT)
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
    fn source_subtrees_inherit_active_contrast_and_keep_the_standalone_fallback() {
        for dark in [false, true] {
            let fallback = with_source_palette(|| tokens(dark).color("surface-secondary"));
            let palette = crate::palettes::increased_contrast(None, dark).unwrap();
            crate::palettes::with_palette(Some(palette), || {
                let contrast = tokens(dark).color("surface-secondary");
                assert_ne!(contrast, fallback);
                with_source_palette(|| {
                    assert_eq!(tokens(dark).color("surface-secondary"), contrast);
                    assert_eq!(kit(dark).c.layer_01, contrast);
                });
                assert!(!source_palette());
            });
            assert_eq!(
                with_source_palette(|| tokens(dark).color("surface-secondary")),
                fallback
            );
        }
    }
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
    fn focusable_disabled_button_keeps_disabled_appearance_and_focus() {
        fn view(focusable_disabled: &bool, cx: &mut rune::Cx<bool>) -> El {
            render(cx, |_| {
                if *focusable_disabled {
                    focusable_disabled_button("Save").key("save")
                } else {
                    button("Save", true, |_: &mut bool| {}).key("save")
                }
            })
        }
        for dark in [false, true] {
            let inspect = |focusable_disabled| {
                let mut rt = rune::Runtime::new(
                    focusable_disabled,
                    view,
                    (320.0, 180.0),
                    rune::Env::new(dark, 1.0),
                );
                rt.frame(1.0);
                let visuals: Vec<_> = rt
                    .elements()
                    .into_iter()
                    .map(|e| {
                        (
                            e.role,
                            e.label,
                            e.rect,
                            e.radius,
                            e.fill,
                            e.text_color,
                            e.opacity,
                        )
                    })
                    .collect();
                let instances: Vec<_> = rt
                    .instances
                    .iter()
                    .map(|i| (i.rect, i.fill, i.border, i.params))
                    .collect();
                let dimmed = rt
                    .instances
                    .iter()
                    .any(|i| i.params[1] == rune::render::KIND_LAYER && i.fill[3] < 1.0);
                let root = rt
                    .elements()
                    .into_iter()
                    .find(|e| e.key.as_deref() == Some("save"))
                    .unwrap();
                (visuals, instances, root.focusable, dimmed, rt)
            };
            let (plain_vis, plain_inst, plain_focus, plain_dimmed, _) = inspect(false);
            let (keep_vis, keep_inst, keep_focus, keep_dimmed, mut rt) = inspect(true);
            assert_eq!(keep_vis, plain_vis);
            assert_eq!(keep_inst, plain_inst);
            assert!(!plain_focus);
            assert!(keep_focus);
            assert!(plain_dimmed);
            assert!(keep_dimmed);
            rt.update(|_, tx| tx.focus("save", true));
            rt.frame(1.0 / 60.0);
            let states = rt.accessibility_json()["children"][0]["states"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            assert!(states.contains(&serde_json::Value::from("disabled")));
            assert!(states.contains(&serde_json::Value::from("focused")));
        }
    }
    #[test]
    fn shared_button_responds_once_to_enter_and_space_when_enabled() {
        fn view(&(disabled, _): &(bool, usize), _: &mut rune::Cx<(bool, usize)>) -> El {
            button("Save", disabled, |s: &mut (bool, usize)| s.1 += 1).key("save")
        }
        for disabled in [false, true] {
            let mut rt = rune::Runtime::new(
                (disabled, 0),
                view,
                (320.0, 180.0),
                rune::Env::new(false, 1.0),
            );
            rt.frame(0.0);
            rt.update(|_, tx| tx.focus("save", true));
            rt.frame(0.01);
            for (index, key) in [rune::Key::Enter, rune::Key::Text(" ".into())]
                .into_iter()
                .enumerate()
            {
                let key = rune::KeyEvent {
                    key,
                    mods: rune::Mods::default(),
                };
                rt.key(key.clone());
                rt.repeat_key(key.clone());
                rt.key_up(key);
                rt.frame(0.02 + index as f64 * 0.01);
                assert_eq!(rt.state.1, if disabled { 0 } else { index + 1 });
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
            for key in ["bare", "title"] {
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
            let editor = runtime
                .elements()
                .into_iter()
                .find(|node| node.path.ends_with("/area/scroll/input"))
                .expect("textarea inner input");
            assert_eq!(
                editor.text_color,
                Some(tokens(dark).color("text-primary")),
                "inherited ink for textarea inner input"
            );
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

    #[test]
    fn composer_geometry_respects_outer_cap_and_full_mode_minimum() {
        struct ComposerCase {
            edit: TextEdit,
            compact: bool,
        }
        let measure = |text: &str, compact: bool| {
            let mut rt = rune::Runtime::new(
                ComposerCase {
                    edit: TextEdit::new(text),
                    compact,
                },
                |s, cx| {
                    render(cx, |_| {
                        let send = button("Send", false, |_: &mut ComposerCase| {}).key("send");
                        let area = composer_textarea(&s.edit, "Prompt", s.compact)
                            .on_edit(|s: &mut ComposerCase| &mut s.edit);
                        rune::col().w_full().h_full().child(
                            rune::col().w_full().key("slot").child(build_composer(
                                area,
                                send,
                                s.edit.focused,
                                false,
                                s.compact,
                            )),
                        )
                    })
                },
                (640.0, 600.0),
                rune::Env::new(false, 1.0),
            );
            for _ in 0..120 {
                rt.frame(1.0 / 60.0);
            }
            let outer = rt
                .elements()
                .into_iter()
                .find(|node| node.key.as_deref() == Some("slot"))
                .expect("outer composer slot")
                .rect[3];
            let box_h = rt
                .elements()
                .into_iter()
                .find(|node| node.key.as_deref() == Some("composer-box"))
                .expect("painted composer")
                .rect[3];
            (outer, box_h)
        };
        let overflow = (0..40)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (full_empty_outer, full_empty_box) = measure("", false);
        assert!(
            (full_empty_outer - 104.0).abs() <= 0.5,
            "full mode outer min height expected 104, got {full_empty_outer}"
        );
        assert!(full_empty_box <= 104.5);
        let (full_max_outer, full_max_box) = measure(&overflow, false);
        assert!(
            full_max_outer <= 320.5 && full_max_box <= 320.5,
            "full mode outer cap must not exceed 320, got outer={full_max_outer} box={full_max_box}"
        );
        assert!(
            full_max_box >= 316.0,
            "expected grown box near 320, got {full_max_box}"
        );

        let (compact_empty_outer, compact_empty_box) = measure("", true);
        assert!(
            compact_empty_outer < 104.0 && compact_empty_box < 104.0,
            "compact mode must stay below full-mode 104px minimum, got {compact_empty_outer}"
        );
        let (compact_max_outer, compact_max_box) = measure(&overflow, true);
        assert!(
            compact_max_outer <= 320.5 && compact_max_box <= 320.5,
            "compact mode outer cap must not exceed 320, got outer={compact_max_outer} box={compact_max_box}"
        );
        assert!(
            compact_max_box >= 316.0,
            "expected grown compact box near 320, got {compact_max_box}"
        );
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
