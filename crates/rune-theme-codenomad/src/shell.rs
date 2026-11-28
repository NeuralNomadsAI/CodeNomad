//! Geometry shared by the application bar and conversation panels.
pub mod blank_cleanup;
pub mod command_palette;
mod header_tabs;
pub mod icons;
pub mod notices;
pub mod tab_rename;
pub mod temporary_close;
use crate::{
    Length, Space, TextRole, kit,
    layout::{self, Layout, enter_action},
    tokens,
};
pub use header_tabs::{
    ContextMeterDensity, connection_indicator, context_meter, panel_tabs, right_panel_header,
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
pub use rune::CloseResponse;

pub fn app<S: 'static>(
    spec: AppSpec<S>,
    close_request: fn(&mut S, &mut Tx) -> CloseResponse,
    closing: fn(&mut S, &mut Tx),
    native_chrome: bool,
    locale: &'static str,
) -> App<S> {
    let mut app = App::new(spec)
        .on_close_request(close_request)
        .on_close(closing)
        .on_quit(closing);
    if native_chrome {
        native_locale(locale);
        app = app.titlebar(rune::Titlebar::new(titlebar_height()));
    }
    app
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

#[cfg(not(target_arch = "wasm32"))]
pub fn is_headless() -> bool {
    rune::is_headless()
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
        .build(&kit(layout::dark()))
}

pub fn titlebar_menu<S: 'static>(label: &str, activate: impl Fn(&mut S, &mut Tx) + 'static) -> El {
    let activate = Rc::new(activate);
    let press = activate.clone();
    Button::new(label)
        .variant(ButtonVariant::GhostMuted)
        .control_size(ControlSize::Small)
        .on_press_tx(move |s, tx| press(s, tx))
        .build(&kit(layout::dark()))
        .on_key(enter_action(activate))
}

pub fn open_titlebar_menu<S: 'static>(
    tx: &mut Tx,
    anchor: &str,
    look: crate::layout::PopupMenuLook,
    items: impl IntoIterator<Item = (&'static str, &'static str, bool, bool)>,
    pick: impl FnOnce(&mut S, Option<&str>, &mut Tx) + 'static,
) {
    #[cfg(target_os = "windows")]
    tx.popup_menu(
        rune::PopupMenu::new()
            .style(look.into_style())
            .items(items.into_iter().map(|(id, name, enabled, checked)| {
                rune::PopupItem::new(id, name)
                    .enabled(enabled)
                    .checked(checked)
            })),
        anchor,
        pick,
    );
    #[cfg(not(target_os = "windows"))]
    let _ = (tx, anchor, look, items, pick);
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

pub fn viewport_probe<S: 'static>(
    touch: bool,
    on_layout: impl Fn(&mut S, [f32; 4], &mut Tx) + 'static,
) -> El {
    rune::el()
        .key(if touch {
            "shell-viewport-touch"
        } else {
            "shell-viewport-pointer"
        })
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .inert()
        .a11y_hidden()
        .on_layout_tx(on_layout)
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
                .w_full()
                .min_w(0.0)
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
        .build(&kit(layout::dark()))
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
    row.build(&kit(layout::dark())).disabled(disabled)
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceDot {
    Ready,
    Pending,
    Error,
    Stopped,
}

pub fn status_dot(state: ServiceDot) -> El {
    let t = tokens(layout::dark());
    let size = t.space(Space::Sm).px();
    let color = match state {
        ServiceDot::Ready => t.color("status-ready-fg"),
        ServiceDot::Pending => t.color("status-starting-fg"),
        ServiceDot::Error => t.color("status-error-fg"),
        ServiceDot::Stopped => t.color("text-muted"),
    };
    el().size(size, size)
        .radius(size * 0.5)
        .fill(color)
        .a11y_hidden()
}

pub fn compact_switch<S: 'static>(
    label: &str,
    checked: bool,
    disabled: bool,
    toggle: impl Fn(&mut S) + 'static,
) -> El {
    rune_kit::Switch::new(checked)
        .control_size(ControlSize::Small)
        .label(label)
        .hide_label()
        .disabled(disabled)
        .on_toggle(toggle)
        .build(&kit(layout::dark()))
}

pub fn service_row(leading: Option<El>, title: &str, trailing: impl IntoIterator<Item = El>) -> El {
    let mut line = row().full_width().center_y().separate(Space::Xs);
    if let Some(lead) = leading {
        line = line.child(lead);
    }
    line.child(text(title).truncate().min_w(0.0).grow(1.0).shrink())
        .children(trailing)
}

pub fn service_header(trailing: impl IntoIterator<Item = El>) -> El {
    row()
        .full_width()
        .center_y()
        .separate(Space::Sm)
        .child(spacer())
        .children(trailing)
}

pub fn service_heading_row(title: &str, trailing: impl IntoIterator<Item = El>) -> El {
    row()
        .full_width()
        .center_y()
        .separate(Space::Xs)
        .child(
            text(title)
                .text_role(TextRole::Button)
                .role("heading")
                .truncate()
                .min_w(0.0)
                .grow(1.0)
                .shrink(),
        )
        .children(trailing)
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
    fn panel_tabs_web_mirror_groups_tabs_under_tablist() {
        let mut rt = rune::Runtime::new(
            0_usize,
            |chosen, _| {
                panel_tabs("Right panel", &["Status", "Files"], *chosen, |s, i, _| {
                    *s = i;
                })
            },
            (280.0, 60.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let items: Vec<serde_json::Value> = serde_json::from_str(&rt.a11y_json()).unwrap();
        let tablist_index = items
            .iter()
            .position(|e| e["o"] == "tablist" && e["t"] == "Right panel")
            .unwrap_or_else(|| panic!("missing panel tablist in web mirror: {}", rt.a11y_json()));
        let tabs: Vec<_> = items.iter().filter(|e| e["o"] == "tab").collect();
        assert_eq!(tabs.len(), 2, "real web mirror: {}", rt.a11y_json());
        assert!(
            tabs.iter().all(|tab| {
                let mut ancestor = tab["a"].as_u64().map(|index| index as usize);
                while let Some(index) = ancestor {
                    if index == tablist_index {
                        return true;
                    }
                    ancestor = items[index]["a"].as_u64().map(|next| next as usize);
                }
                false
            }),
            "panel tabs must be grouped inside tablist: {}",
            rt.a11y_json()
        );
        assert!(
            tabs.iter()
                .any(|tab| tab["t"] == "Status" && tab["se"] == true)
        );
        assert!(
            tabs.iter()
                .any(|tab| tab["t"] == "Files" && tab["se"] == false)
        );
    }

    #[test]
    fn older_button_web_mirror_exposes_disabled_state() {
        for busy in [false, true] {
            let mut rt = rune::Runtime::new(
                busy,
                |busy, _| older_button("Older messages", *busy, |_: &mut bool, _| {}),
                (180.0, 60.0),
                rune::Env::new(false, 1.0),
            );
            rt.frame(0.0);
            let items: Vec<serde_json::Value> = serde_json::from_str(&rt.a11y_json()).unwrap();
            let button = items
                .iter()
                .find(|item| item["k"] == "button" && item["t"] == "Older messages")
                .unwrap_or_else(|| panic!("missing older button: {}", rt.a11y_json()));
            assert_eq!(button.get("dis") == Some(&serde_json::json!(true)), busy);
        }
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
