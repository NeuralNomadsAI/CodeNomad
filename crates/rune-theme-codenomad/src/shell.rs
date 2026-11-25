//! Geometry shared by the application bar and conversation panels.
pub mod icons;
pub mod notices;
use crate::{
    Length, Space, TextRole, kit,
    layout::{self, enter_action},
    tokens,
};
use rune::{App, AppSpec, Cx, El, Icon, Tx, col, el, row, text};
use rune_kit::{
    Button, ButtonVariant, ControlSize, IconButton, IconButtonVariant, SidebarRow, WindowTitlebar,
};
use std::rc::Rc;

// Solid's shell/storage.ts and instance-shell2.tsx own these layout breakpoints.
pub const CENTER_MIN: f32 = 390.0;
pub const PANEL_MIN: [f32; 2] = [220.0, 200.0];
pub const PANEL_DEFAULT: [f32; 2] = [340.0, 260.0];
pub fn default_right_panel(window_width: f32) -> f32 {
    (window_width * 0.35).max(PANEL_MIN[1])
}

pub enum Resize {
    Start,
    Set(f32),
    Nudge(f32),
    End,
}

pub fn panel_grip<S: 'static>(
    key: &str,
    label: &str,
    leading: bool,
    rtl: bool,
    held: bool,
    desired: f32,
    min: f32,
    max: f32,
    resize: impl Fn(&mut S, Resize, &mut Tx) + Clone + 'static,
) -> El {
    let t = tokens(layout::dark());
    let zero = Some(0.0);
    let width = t.space(Space::Xs).px();
    let accent = t.color("accent-primary");
    let drag_resize = resize.clone();
    let sign = if leading != rtl { 1.0 } else { -1.0 };
    let step = t.space(Space::Sm).px();
    el().key(key)
        .w(width)
        .pin(
            (!leading).then_some(0.0),
            zero,
            leading.then_some(0.0),
            zero,
        )
        .role("separator")
        .label(label)
        .range_value(f64::from(desired), f64::from(min), f64::from(max))
        .focusable(true)
        .fill(if held {
            accent
        } else {
            rune::Color::TRANSPARENT
        })
        .hover(accent)
        .cursor(rune::Cursor::ResizeColumn)
        .touch_drags_at_once()
        .on_drag(move |s, drag, tx| {
            let event = match drag.phase {
                rune::Phase::Down => {
                    drag.data = desired;
                    Resize::Start
                }
                rune::Phase::Move => Resize::Set(drag.data + sign * drag.dx),
                rune::Phase::Up => Resize::End,
            };
            drag_resize(s, event, tx);
        })
        .on_key(move |s, event, tx| {
            if event.mods != rune::Mods::default() {
                return false;
            }
            let delta = match event.key {
                rune::Key::Left => -step,
                rune::Key::Right => step,
                _ => return false,
            };
            resize(s, Resize::Nudge(desired + delta * sign), tx);
            true
        })
}

fn titlebar_height() -> f32 {
    tokens(layout::dark()).length(Length::Chrome).px()
}

/// A producer can update an owning window independently of its next paint.
pub type WindowFeed<S> = rune::AppHandle<S>;

pub fn app<S: 'static>(
    spec: AppSpec<S>,
    closing: fn(&mut S, &mut Tx),
    native_chrome: bool,
    locale: &'static str,
) -> App<S> {
    app_with_quit(spec, closing, closing, native_chrome, locale)
}

pub fn app_with_quit<S: 'static>(
    spec: AppSpec<S>,
    closing: fn(&mut S, &mut Tx),
    quitting: fn(&mut S, &mut Tx),
    native_chrome: bool,
    locale: &'static str,
) -> App<S> {
    let mut app = App::new(spec).on_close(closing).on_quit(quitting);
    if native_chrome {
        native_locale(locale);
        app = app.titlebar(rune::Titlebar::new(titlebar_height()));
    }
    app
}

#[cfg(not(target_arch = "wasm32"))]
pub fn on_fast_exit(last: fn()) {
    rune::fast_exit(last);
}

pub fn native_locale(locale: &'static str) {
    rune::labels::set_locale(locale);
    rune::labels::set_direction(if crate::catalogue::direction(locale) == "rtl" {
        rune::Direction::Rtl
    } else {
        rune::Direction::Ltr
    });
    rune::labels::set_labels(move |label| {
        use rune::labels::Label;
        crate::catalogue::message(
            locale,
            match label {
                Label::Cut => "window.menu.native.cut",
                Label::Copy => "window.menu.native.copy",
                Label::Paste => "window.menu.native.paste",
                Label::SelectAll => "window.menu.native.selectAll",
                Label::Undo => "window.menu.native.undo",
                Label::Redo => "window.menu.native.redo",
                Label::Minimize => "window.controls.minimize",
                Label::Close => "window.controls.close",
                _ => return None,
            },
        )
        .map(str::to_owned)
    });
}

pub fn live_caption() -> bool {
    cfg!(target_os = "windows") && !rune::is_headless()
}

pub fn titlebar<S>(cx: &mut Cx<S>, title: &str, rtl: bool, menus: El) -> El {
    let t = tokens(layout::dark());
    let gutter = t.space(Space::Md).px();
    let mut insets = cx.chrome_insets();
    if cfg!(target_os = "windows") {
        let buttons = insets.leading + insets.trailing;
        // A locale switch can arrive after the host measured the previous direction.
        (insets.leading, insets.trailing) = if rtl { (buttons, 0.0) } else { (0.0, buttons) };
    }
    cx.caption_color(t.color("text-primary"));
    WindowTitlebar::from_insets(insets)
        .key("native-titlebar")
        .height(titlebar_height())
        .leading_padding(gutter)
        .trailing_padding(gutter)
        .gap(t.space(Space::Sm).px())
        .direction(if rtl {
            rune::Direction::Rtl
        } else {
            rune::Direction::Ltr
        })
        .fill(t.color("surface-shade-strong"))
        .leading(
            text(title)
                .key("app-title")
                .font(t.text(TextRole::Small))
                .color(t.color("text-secondary"))
                .truncate(),
        )
        .leading(menus)
        .build(kit(layout::dark()))
}

pub fn titlebar_menu<S: 'static>(label: &str, activate: impl Fn(&mut S, &mut Tx) + 'static) -> El {
    let activate = Rc::new(activate);
    let press = activate.clone();
    Button::new(label)
        .variant(ButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .on_press_tx(move |s, tx| press(s, tx))
        .build(kit(layout::dark()))
        .on_key(enter_action(activate))
}

pub fn panel_tabs<S: 'static>(
    title: &str,
    labels: &[&str],
    chosen: usize,
    activate: impl Fn(&mut S, usize, &mut Tx) + Clone + 'static,
) -> El {
    let dark = layout::dark();
    // Solid's project and right-panel strips share the same tab height.
    let height = tokens(dark).metric("tabActive", "height").px();
    row().role("tablist").label(title).focus_group().children(
        labels.iter().copied().enumerate().map(|(index, label)| {
            let activate = activate.clone();
            let action = Rc::new(move |s: &mut S, tx: &mut Tx| activate(s, index, tx));
            let press = action.clone();
            Button::new(label)
                .variant(if index == chosen {
                    ButtonVariant::Ghost
                } else {
                    ButtonVariant::GhostMuted
                })
                .control_size(ControlSize::Small)
                .on_press_tx(move |s, tx| press(s, tx))
                .build(kit(dark))
                .h(height)
                .key(format!("right-panel-tab-{index}"))
                .role("tab")
                .focus_selected(index == chosen)
                .on_key(enter_action(action))
        }),
    )
}

pub fn open_titlebar_menu<S: 'static>(
    tx: &mut Tx,
    anchor: &str,
    items: impl IntoIterator<Item = (&'static str, &'static str, bool, bool)>,
    pick: impl FnOnce(&mut S, Option<&str>, &mut Tx) + 'static,
) {
    #[cfg(target_os = "windows")]
    tx.popup_menu(
        rune::PopupMenu::new().items(items.into_iter().map(|(id, name, enabled, checked)| {
            rune::PopupItem::new(id, name)
                .enabled(enabled)
                .checked(checked)
        })),
        anchor,
        pick,
    );
    #[cfg(not(target_os = "windows"))]
    let _ = (tx, anchor, items, pick);
}

pub fn frame() -> El {
    col().w_full().h_full().min_w(0.0).min_h(0.0)
}

pub fn columns() -> El {
    row().w_full().h_full().min_w(0.0).min_h(0.0)
}

pub fn conversation_column() -> El {
    col().grow(1.0).min_w(0.0).h_full().min_h(0.0)
}

pub fn empty_conversation(title: &str) -> El {
    col().w_full().h_full().center().child(text(title))
}

pub fn panel(width: f32, floating: bool) -> El {
    let base = col()
        .h_full()
        .min_h(0.0)
        .fill(tokens(layout::dark()).color("surface-secondary"));
    if floating { cover(base) } else { base.w(width) }
}

pub fn cover(element: El) -> El {
    element.pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
}

pub fn floating_notice(notice: El) -> El {
    let inset = tokens(layout::dark()).space(Space::Sm).px();
    row()
        .pin(None, Some(inset), Some(inset), None)
        .raise()
        .child(notice)
}

pub fn header(left: bool, right: bool, touch: bool, actions: impl IntoIterator<Item = El>) -> El {
    let t = tokens(layout::dark());
    let inset = |reserve| {
        if reserve {
            t.space(Space::Xs).px() + control_size(touch) + t.space(Space::Sm).px()
        } else {
            t.space(Space::Md).px()
        }
    };
    let line = t.number("panel-header-action-center").px() * 2.0;
    let border = t.metric("tabActive", "borderBottomWidth").px();
    col()
        .w_full()
        .h(t.length(Length::PanelHeader).px())
        .fill(t.color("surface-shade-light"))
        .border_sides([0.0, 0.0, border, 0.0], t.color("tab-border"))
        .child(
            row()
                .h(line)
                .pl(inset(left))
                .pr(inset(right))
                .items_center()
                .gap(t.space(Space::Xs).px())
                .children(actions),
        )
}

pub fn control(icon: &'static Icon, label: &'static str, touch: bool) -> IconButton {
    IconButton::new(icon)
        .label(label)
        .variant(IconButtonVariant::GhostMuted)
        .control_size(if touch {
            ControlSize::Large
        } else {
            ControlSize::Regular
        })
}

pub fn older_button<S: 'static>(
    label: &'static str,
    busy: bool,
    activate: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    control(&icons::UP, label, false)
        .help(label)
        .disabled(busy)
        .on_press_tx(activate)
        .build(kit(layout::dark()))
        .key("older")
}

pub fn session_row<S: 'static>(
    title: &str,
    selected: bool,
    disabled: bool,
    select: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let mut row = SidebarRow::new(title).selected(selected);
    if !disabled {
        row = row.on_select(select);
    }
    row.build(kit(layout::dark())).disabled(disabled)
}

fn control_size(touch: bool) -> f32 {
    tokens(layout::dark())
        .length(if touch {
            Length::TouchCompact
        } else {
            Length::IconButton
        })
        .px()
}

pub fn toggle<S: 'static>(
    icon: &'static Icon,
    label: &'static str,
    key: &'static str,
    leading: bool,
    touch: bool,
    open: bool,
    activate: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let side = t.space(Space::Xs).px();
    let top = t.number("panel-header-action-center").px() - control_size(touch) / 2.0;
    let mut kit = kit(layout::dark()).clone();
    if open {
        let tint = t
            .color("accent-primary")
            .mix(t.color("text-on-accent"), 0.2)
            .mix(t.color("surface-base"), 0.1);
        kit.c.pressed = tint.alpha(0.44);
        kit.c.hover = tint.alpha(0.56);
    }
    let activate = Rc::new(activate);
    let press = activate.clone();
    let button = control(icon, label, touch)
        .expanded(open)
        .on_press_tx(move |s, tx| press(s, tx))
        .build(&kit)
        .on_key(enter_action(activate))
        .key(key);
    let size = control_size(touch);
    row()
        .size(size, size)
        .center()
        .pin(
            leading.then_some(side),
            Some(top),
            (!leading).then_some(side),
            None,
        )
        .raise()
        .child(button)
}

pub fn panel_title(title: &str) -> El {
    let t = tokens(layout::dark());
    text(title)
        .font(t.text(TextRole::Small))
        .color(t.color("text-muted"))
        .truncate()
        .min_w(0.0)
        .shrink()
}

pub fn spacer() -> El {
    el().grow(1.0).min_w(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_group_exposes_sidebar_rows_and_activates_them_with_enter() {
        let mut rt = rune::Runtime::new(
            0_usize,
            |_, _| {
                col().role("list").focus_group().child(
                    session_row("A", false, false, |count: &mut usize, _| *count += 1)
                        .key("session-a"),
                )
            },
            (180.0, 100.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        rt.update(|_, tx| tx.focus("session-a", true));
        rt.frame(0.0);
        rt.key(rune::KeyEvent {
            key: rune::Key::Enter,
            mods: rune::Mods::default(),
        });
        rt.frame(0.01);
        assert_eq!(rt.state, 1);
    }

    #[test]
    fn enter_activates_a_caption_menu() {
        let mut rt = rune::Runtime::new(
            0_usize,
            |_, _| titlebar_menu("View", |count: &mut usize, _| *count += 1).key("view-menu"),
            (180.0, 100.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        rt.update(|_, tx| tx.focus("view-menu", true));
        rt.frame(0.0);
        rt.key(rune::KeyEvent {
            key: rune::Key::Enter,
            mods: rune::Mods::default(),
        });
        rt.frame(0.01);
        assert_eq!(rt.state, 1);
    }

    #[test]
    fn panel_breakpoints_follow_solid() {
        let storage = include_str!("../../../packages/ui/src/components/instance/shell/storage.ts");
        let shell =
            include_str!("../../../packages/ui/src/components/instance/instance-shell2.tsx");
        assert!(shell.contains(&format!("MIN_SESSION_CENTER_WIDTH = {CENTER_MIN}")));
        for (key, value) in [
            ("DEFAULT_SESSION_SIDEBAR_WIDTH", PANEL_DEFAULT[0]),
            ("MIN_SESSION_SIDEBAR_WIDTH", PANEL_MIN[0]),
            ("RIGHT_DRAWER_WIDTH", PANEL_DEFAULT[1]),
            ("MIN_RIGHT_DRAWER_WIDTH", PANEL_MIN[1]),
        ] {
            assert!(
                storage
                    .lines()
                    .any(|line| line == format!("export const {key} = {value}"))
            );
        }
    }
}
