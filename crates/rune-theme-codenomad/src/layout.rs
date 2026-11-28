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
pub fn appearance_key() -> (bool, bool, Option<crate::palettes::PaletteKey>) {
    let dark = dark();
    (
        dark,
        source_palette(),
        crate::palettes::active(dark).map(|p| p.cache_key()),
    )
}
pub(crate) fn render_with_dark<S, T>(
    cx: &mut rune::Cx<S>,
    dark: bool,
    build: impl FnOnce(&mut rune::Cx<S>) -> T,
) -> T {
    cx.web_focus();
    cx.foreground(tokens(dark).color("text-primary"));
    with_appearance(dark, || build(cx))
}
/// Install Rune's inherited ink and shared keyboard focus mode for every render.
pub fn render<S, T>(cx: &mut rune::Cx<S>, build: impl FnOnce(&mut rune::Cx<S>) -> T) -> T {
    render_with_dark(cx, cx.system_dark(), build)
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
        .build(&kit(dark()));
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
        .build(&kit(dark()))
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
pub fn input(edit: &TextEdit) -> El {
    base_editor(edit).fill(tokens(dark()).color("surface-field"))
}
fn base_editor(edit: &TextEdit) -> El {
    // Rune's low-level editor retains the application's edit accessor and submit contract.
    rune::text_input(edit, tokens(dark()).text(TextRole::Body))
        .w_full()
        .padding(tokens(dark()).space(Space::Sm).px())
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
pub fn dialog(key: &str, title: &str, close_label: &str) -> rune_kit::Dialog {
    rune_kit::Dialog::new(key, title).close_label(close_label)
}
pub fn combobox<S: 'static>(
    key: &str,
    label: &str,
    search_label: &str,
    state: &rune_kit::ComboboxState,
    options: &[rune_kit::ComboboxOption],
    access: impl for<'a> Fn(&'a mut S) -> &'a mut rune_kit::ComboboxState + 'static,
) -> rune_kit::Combobox<S> {
    rune_kit::Combobox::new(key, state, options, access)
        .label(label)
        .search_label(search_label)
        .search_placeholder(search_label)
}
pub fn composer_input(edit: &TextEdit, placeholder: &str) -> El {
    base_editor(edit).hint(placeholder)
}
#[derive(Clone, Debug, PartialEq)]
pub struct PopupMenuLook(rune::PopupMenuStyle);

impl PopupMenuLook {
    pub(crate) fn into_style(self) -> rune::PopupMenuStyle {
        self.0
    }

    pub fn matches(&self, menu: &rune::PopupMenu) -> bool {
        menu.menu_style() == Some(&self.0)
    }
}

pub fn popup_menu_look() -> PopupMenuLook {
    let t = tokens(dark());
    PopupMenuLook(
        rune::PopupMenuStyle::new()
            .background(t.color("surface-overlay"))
            .text(t.color("text-primary"))
            .muted(t.color("text-muted"))
            .separator(t.color("border-base"))
            .highlight(t.color("menu-item-hover-bg"))
            .font_family(t.string("font-family-sans"))
            .font_size(t.metric("actionMenuItem", "fontSize").px())
            .line_height(t.metric("actionMenuItem", "lineHeight").px())
            .padding(t.metric("actionMenu", "paddingTop").px())
            .corner_radius(t.metric("actionMenu", "borderRadius").px())
            .item_corner_radius(t.metric("actionMenuItem", "borderRadius").px()),
    )
}
pub fn editor_menu<S: 'static>(
    tx: &mut rune::Tx,
    point: (f32, f32),
    selected: bool,
    look: PopupMenuLook,
    pick: impl FnOnce(&mut S, Option<&str>, &mut rune::Tx) + 'static,
) {
    use rune::{Label, PopupItem, PopupMenu, labels::label};
    let mut menu = PopupMenu::new()
        .style(look.into_style())
        .item(PopupItem::new("cut", label(Label::Cut)).enabled(selected))
        .item(PopupItem::new("copy", label(Label::Copy)).enabled(selected))
        .item(PopupItem::new("paste", label(Label::Paste)));
    if !cfg!(target_os = "macos") {
        menu = menu.item(PopupItem::new("select-all", label(Label::SelectAll)));
    }
    tx.popup_menu(menu, point, pick);
}
fn linear_luminance(c: rune::Color) -> f32 {
    0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}
fn contrast_ratio(fg: rune::Color, bg: rune::Color) -> f32 {
    let over = rune::Color {
        r: fg.r * fg.a + bg.r * (1.0 - fg.a),
        g: fg.g * fg.a + bg.g * (1.0 - fg.a),
        b: fg.b * fg.a + bg.b * (1.0 - fg.a),
        a: 1.0,
    };
    let l1 = linear_luminance(over);
    let l2 = linear_luminance(bg);
    (l1.max(l2) + 0.05) / (l1.min(l2) + 0.05)
}
fn readable_on(bg: rune::Color, candidates: &[rune::Color]) -> rune::Color {
    if let Some(&color) = candidates
        .iter()
        .find(|&&color| contrast_ratio(color, bg) >= 4.5)
    {
        return color;
    }
    candidates
        .iter()
        .copied()
        .max_by(|a, b| {
            contrast_ratio(*a, bg)
                .partial_cmp(&contrast_ratio(*b, bg))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(rune::Color::WHITE)
}
fn shell_send_colors(t: &crate::Tokens) -> (rune::Color, rune::Color) {
    let fill = t.color("status-success");
    let ink = readable_on(
        fill,
        &[
            t.color("text-inverted"),
            t.color("text-primary"),
            rune::Color::WHITE,
            rune::Color::BLACK,
        ],
    );
    (fill, ink)
}
fn shell_status_ink(t: &crate::Tokens) -> rune::Color {
    let field = t.color("surface-field");
    readable_on(
        field,
        &[
            t.color("status-success"),
            t.color("text-secondary"),
            t.color("text-primary"),
            rune::Color::BLACK,
            rune::Color::WHITE,
        ],
    )
}
const SHELL_PROMPT: rune::Icon = rune::Icon {
    name: "shell-prompt",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 4-5 4"/><path d="M13 16h6"/></g>"#,
};
pub fn shell_send_button_tx<S: 'static>(
    label: &str,
    aria_label: &str,
    disabled: bool,
    press: impl Fn(&mut S, &mut rune::Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let mut theme = kit(dark()).clone();
    let (fill, ink) = shell_send_colors(t);
    theme.c.bg_icon_button_contrast = fill;
    theme.c.bg_contrast = fill;
    theme.c.contrast_hover = fill;
    theme.c.contrast_pressed = fill;
    theme.c.bg_accent = fill;
    theme.c.submit_highlight = rune::Color::TRANSPARENT;
    theme.c.submit_hover = fill;
    theme.c.submit_fg = ink;
    theme.c.submit_icon = ink;
    theme.c.text_contrast = ink;
    theme.c.icon_contrast = ink;
    let action = Rc::new(press);
    let press = action.clone();
    let button = rune_kit::Button::new(label)
        .icon(&SHELL_PROMPT)
        .variant(rune_kit::ButtonVariant::Submit)
        .disabled(disabled)
        .on_press_tx(move |s, tx| press(s, tx))
        .build(&theme)
        .label(aria_label);
    if disabled {
        button
    } else {
        button.on_key(enter_action(action))
    }
}
fn caret_pin(key: &'static str, top: f32, height: f32) -> El {
    let top = if top.is_finite() { top.max(0.0) } else { 0.0 };
    let height = if height.is_finite() {
        height.max(1.0)
    } else {
        1.0
    };
    rune::el().key(key).absolute(0.0, top).w(0.0).h(height)
}

pub fn composer_field(
    editor: El,
    bounds: crate::interruption::SessionLayout,
    focused: bool,
    on_scroll: impl Fn(f32, f32) + 'static,
    inner_caret_pin: Option<(f32, f32)>,
    stack_caret_pin: Option<(f32, f32)>,
) -> El {
    composer_field_with_status(
        editor,
        bounds,
        focused,
        on_scroll,
        inner_caret_pin,
        stack_caret_pin,
        false,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn composer_field_with_status(
    editor: El,
    bounds: crate::interruption::SessionLayout,
    focused: bool,
    on_scroll: impl Fn(f32, f32) + 'static,
    inner_caret_pin: Option<(f32, f32)>,
    stack_caret_pin: Option<(f32, f32)>,
    shell_mode: bool,
    shell_status: Option<&str>,
) -> El {
    let t = tokens(dark());
    let minimum = if bounds.composer_min.is_finite() {
        bounds.composer_min.max(0.0)
    } else {
        0.0
    };
    let maximum = if bounds.composer_max.is_finite() {
        bounds.composer_max.max(minimum)
    } else {
        minimum
    };
    let mut field = rune::auto_grow(editor.min_h(minimum), 1, usize::MAX)
        .min_h(minimum)
        .max_h(maximum)
        .on_scroll_offset(move |at| on_scroll(at.offset[1], at.max[1]));
    if let Some((top, height)) = inner_caret_pin {
        field = field.child(caret_pin("composer-caret-pin", top, height));
    }
    let mut box_el = rune::col()
        .w_full()
        .child(field)
        .fill(t.color("surface-field"));
    if let Some((top, height)) = stack_caret_pin {
        box_el = box_el.child(caret_pin("stack-caret-pin", top, height));
    }
    if !bounds.scroll_stack
        && let Some(status) = shell_status
    {
        let sm = t.space(Space::Sm).px();
        let xs = t.space(Space::Xs).px();
        box_el = box_el.child(
            rune::row()
                .key("composer-shell-status")
                .role("note")
                .pin(Some(sm), None, Some(sm), Some(xs))
                .child(
                    rune::text(status)
                        .font(t.text(TextRole::Small))
                        .color(shell_status_ink(t)),
                ),
        );
    }
    if shell_mode && focused {
        box_el.outline(2.0, -2.0, t.color("status-success-ring"))
    } else if shell_mode {
        box_el.outline(1.0, -1.0, t.color("status-success-ring"))
    } else if focused {
        box_el.outline(1.0, -1.0, t.color("focus-ring-color"))
    } else {
        box_el
    }
}
pub fn caret_rect<S>(cx: &rune::Cx<S>, key: &str) -> Option<[f32; 4]> {
    cx.caret(key)
}
pub fn layout_rect<S>(cx: &rune::Cx<S>, key: &str) -> Option<[f32; 4]> {
    cx.layout(key)
}
pub fn window_layout<S>(cx: &rune::Cx<S>, key: &str) -> Option<[f32; 4]> {
    cx.window_layout(key)
}
pub fn layout_probe(key: impl Into<String>) -> El {
    rune::el().key(key.into()).absolute(0.0, 0.0).w(0.0).h(0.0)
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
/// Keeps `body` clear of a phone's status bar, cutout, navigation bar and keyboard, over a
/// surface that still reaches the screen's edges. A desktop window has no insets.
pub fn safe_area<S>(cx: &rune::Cx<S>, body: El) -> El {
    let [top, right, bottom, left] = cx.safe_area();
    let bottom = bottom.max(cx.keyboard_inset());
    rune::col()
        .key("safe-area")
        .w_full()
        .h_full()
        .pt(top)
        .pr(right)
        .pb(bottom)
        .pl(left)
        .fill(tokens(dark()).color("surface-secondary"))
        .child(body)
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
                crate::palettes::with_resolved(palette.clone(), || {
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
    fn the_safe_area_keeps_the_application_inside_a_phones_insets() {
        // What the body and the surface under it measure: the shell sizes its overlays by the
        // first, and the second is what the system's bars sit on.
        #[derive(Default)]
        struct Measured {
            body: [f32; 4],
            surface: [f32; 4],
        }
        fn view(_: &Measured, cx: &mut rune::Cx<Measured>) -> El {
            render(cx, |cx| {
                let body = rune::el()
                    .key("body")
                    .w_full()
                    .h_full()
                    .on_layout_tx(|s: &mut Measured, bounds, _| s.body = bounds);
                safe_area(cx, body).on_layout_tx(|s: &mut Measured, bounds, _| s.surface = bounds)
            })
        }
        let window = [0.0, 0.0, 200.0, 400.0];
        let mut rt = rune::Runtime::new(
            Measured::default(),
            view,
            (200.0, 400.0),
            rune::Env::default(),
        );
        // A layout is reported on the frame after it.
        let mut at = 0.0;
        let mut settle = |rt: &mut rune::Runtime<Measured>| {
            for _ in 0..3 {
                rt.frame(at);
                at += 16.0;
            }
        };
        settle(&mut rt);
        assert_eq!(rt.state.body, window, "no insets: the whole window");
        // A rotation changes them while the application runs.
        rt.set_safe_area([10.0, 4.0, 30.0, 6.0]);
        settle(&mut rt);
        assert_eq!(
            rt.state.body,
            [6.0, 10.0, 190.0, 360.0],
            "inside top, right, bottom and left"
        );
        assert_eq!(
            rt.state.surface, window,
            "the surface still reaches the edges"
        );
        // The keyboard covers the navigation bar: the taller of the two is kept clear, not both.
        rt.set_keyboard_inset(150.0);
        settle(&mut rt);
        assert_eq!(
            rt.state.body,
            [6.0, 10.0, 190.0, 240.0],
            "above the keyboard"
        );
        rt.set_keyboard_inset(0.0);
        settle(&mut rt);
        assert_eq!(rt.state.body[3], 360.0, "the keyboard closed");
        rt.set_safe_area([0.0; 4]);
        settle(&mut rt);
        assert_eq!(rt.state.body, window, "the whole window again");
    }
    #[test]
    fn shared_button_preserves_kit_geometry_and_disabled_semantics() {
        fn view(&(direct, disabled): &(bool, bool), cx: &mut rune::Cx<(bool, bool)>) -> El {
            render(cx, |_| {
                if direct {
                    rune_kit::Button::new("Save")
                        .disabled(disabled)
                        .on_press(|_: &mut (bool, bool)| {})
                        .build(&kit(dark()))
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
                    .child(input(edit).key("editor"))
                    .child(field(edit).build(&crate::field_kit(dark())).key("field"))
                    .child(textarea(edit).build(&crate::field_kit(dark())).key("area"))
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
    #[test]
    fn popup_menu_style_follows_theme_palettes_with_square_corners() {
        for dark in [false, true] {
            let look = with_appearance(dark, popup_menu_look);
            let t = tokens(dark);
            let expected = rune::PopupMenuStyle::new()
                .background(t.color("surface-overlay"))
                .text(t.color("text-primary"))
                .muted(t.color("text-muted"))
                .separator(t.color("border-base"))
                .highlight(t.color("menu-item-hover-bg"))
                .font_family(t.string("font-family-sans"))
                .font_size(t.metric("actionMenuItem", "fontSize").px())
                .line_height(t.metric("actionMenuItem", "lineHeight").px())
                .padding(t.metric("actionMenu", "paddingTop").px())
                .corner_radius(0.0)
                .item_corner_radius(0.0);
            assert_eq!(look.clone().into_style(), expected);

            let contrast = crate::palettes::increased_contrast(None, dark).unwrap();
            let high_contrast = crate::palettes::with_palette(Some(contrast), || {
                with_appearance(dark, popup_menu_look)
            });
            assert_ne!(high_contrast, look);

            // Verify every theme popup-menu helper attaches the provided look.
            let mut rt = rune::Runtime::new(
                (),
                |_, _| rune::el().key("anchor").size(40.0, 20.0),
                (200.0, 120.0),
                rune::Env::new(dark, 1.0),
            );
            rt.frame(0.0);

            let editor_look = look.clone();
            rt.update(move |_, tx| {
                editor_menu(tx, (10.0, 10.0), true, editor_look, |_: &mut (), _, _| {})
            });
            rt.frame(0.0);
            assert!(look.matches(rt.popup_menu().unwrap()));
            rt.resolve_popup(None).unwrap();

            let link_look = look.clone();
            rt.update(move |_, tx| {
                crate::markdown::link_menu(
                    tx,
                    (10.0, 10.0),
                    "Open",
                    "Copy link",
                    None,
                    link_look,
                    |_: &mut (), _, _| {},
                )
            });
            rt.frame(0.0);
            assert!(look.matches(rt.popup_menu().unwrap()));
            rt.resolve_popup(None).unwrap();

            #[cfg(target_os = "windows")]
            {
                let title_look = look.clone();
                rt.update(move |_, tx| {
                    crate::shell::open_titlebar_menu(
                        tx,
                        "anchor",
                        title_look,
                        [("close", "Close", true, false)],
                        |_: &mut (), _, _| {},
                    )
                });
                rt.frame(0.0);
                assert!(look.matches(rt.popup_menu().unwrap()));
                rt.resolve_popup(None).unwrap();
            }
        }
    }
    #[test]
    fn shell_send_and_status_meet_wcag_contrast_in_every_palette() {
        let check = |label: &str, dark: bool| {
            let t = tokens(dark);
            let (fill, ink) = shell_send_colors(t);
            let send_ratio = contrast_ratio(ink, fill);
            assert!(
                send_ratio >= 4.5,
                "{label}: shell send button contrast {send_ratio:.2} < 4.5"
            );
            let field = t.color("surface-field");
            let status_ratio = contrast_ratio(shell_status_ink(t), field);
            assert!(
                status_ratio >= 4.5,
                "{label}: shell status contrast {status_ratio:.2} < 4.5"
            );
        };
        for dark in [false, true] {
            check(
                if dark {
                    "default-dark"
                } else {
                    "default-light"
                },
                dark,
            );
            let high = crate::palettes::increased_contrast(None, dark).unwrap();
            crate::palettes::with_palette(Some(high), || check("default-hc", dark));
        }
        for palette in crate::palettes::built_in() {
            crate::palettes::with_palette(Some(palette), || check(palette.id, palette.dark));
            let high = crate::palettes::increased_contrast(Some(palette), palette.dark).unwrap();
            crate::palettes::with_palette(Some(high), || check(palette.id, palette.dark));
        }
    }
    #[test]
    fn localized_dialog_and_combobox_forward_accessible_labels() {
        fn has_node(node: &serde_json::Value, role: &str, name: &str) -> bool {
            if node["role"].as_str() == Some(role) && node["name"].as_str() == Some(name) {
                return true;
            }
            node["children"]
                .as_array()
                .is_some_and(|children| children.iter().any(|child| has_node(child, role, name)))
        }

        fn dialog_view(open: &bool, cx: &mut rune::Cx<bool>) -> El {
            render(cx, |_| {
                let mut layers = Vec::new();
                dialog("confirm", "Confirmer", "Fermer")
                    .open(*open)
                    .on_close(|open: &mut bool| *open = false)
                    .build(&kit(dark()), &mut layers);
                rune::el().w_full().h_full().children(layers)
            })
        }
        let mut dialog_rt = rune::Runtime::new(
            true,
            dialog_view,
            (480.0, 320.0),
            rune::Env::new(false, 1.0),
        );
        dialog_rt.frame(0.0);
        let tree = dialog_rt.accessibility_json();
        assert!(has_node(&tree, "button", "Fermer"), "{tree}");
        assert!(!has_node(&tree, "button", "Close"), "{tree}");

        fn combo_view(
            state: &rune_kit::ComboboxState,
            cx: &mut rune::Cx<rune_kit::ComboboxState>,
        ) -> El {
            render(cx, |_| {
                let mut layers = Vec::new();
                let options = [
                    rune_kit::ComboboxOption::new("a", "Alpha"),
                    rune_kit::ComboboxOption::new("b", "Beta"),
                ];
                let trigger = combobox(
                    "models",
                    "Modèle",
                    "Rechercher des modèles",
                    state,
                    &options,
                    |s: &mut rune_kit::ComboboxState| s,
                )
                .build(&kit(dark()), &mut layers);
                rune::col()
                    .w_full()
                    .h_full()
                    .child(trigger)
                    .children(layers)
            })
        }
        let mut combo_rt = rune::Runtime::new(
            rune_kit::ComboboxState::default(),
            combo_view,
            (480.0, 320.0),
            rune::Env::new(false, 1.0),
        );
        combo_rt.frame(0.0);
        let (x, y) = combo_rt.find("models-trigger").unwrap();
        combo_rt.pointer_down(x, y);
        combo_rt.pointer_up(x, y);
        combo_rt.frame(0.02);
        let tree = combo_rt.accessibility_json();
        assert!(
            has_node(&tree, "text-input", "Rechercher des modèles"),
            "{tree}"
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
