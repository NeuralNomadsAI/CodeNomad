//! Shared overflow rows; callers supply their trigger surface and translated labels.
use crate::{kit, layout, tokens};
use rune::{El, Tx};
use rune_kit::{Placement, popover};
use std::{collections::HashMap, rc::Rc, time::Duration};

pub type Action<S> = Rc<dyn Fn(&mut S, &mut Tx)>;
pub type Focus<S> = Rc<dyn Fn(&S) -> Option<String>>;
pub type StateAt<S> = fn(&mut S) -> Option<&mut State<S>>;

pub struct Item<S> {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
    pub icon: Option<Rc<dyn Fn() -> El>>,
    pub disabled: bool,
    pub checked: Option<bool>,
    pub select_before_close: bool,
    pub focus_after_select: Option<Focus<S>>,
    pub on_select: Action<S>,
    pub on_mouse_enter: Option<Action<S>>,
    pub on_mouse_leave: Option<Action<S>>,
}
impl<S> Item<S> {
    pub fn new(key: &str, label: &str, select: impl Fn(&mut S, &mut Tx) + 'static) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            description: None,
            icon: None,
            disabled: false,
            checked: None,
            select_before_close: false,
            focus_after_select: None,
            on_select: Rc::new(select),
            on_mouse_enter: None,
            on_mouse_leave: None,
        }
    }
}
struct Pending<S> {
    action: Option<Action<S>>,
    restored: Option<Action<S>>,
    focus: Option<Focus<S>>,
    menu: String,
}
struct Open<S> {
    hovered: Option<(String, Option<Action<S>>)>,
    restored: Option<Action<S>>,
}
pub struct State<S> {
    menus: HashMap<String, Open<S>>,
    pending: Vec<Pending<S>>,
}
impl<S> Default for State<S> {
    fn default() -> Self {
        Self {
            menus: HashMap::new(),
            pending: vec![],
        }
    }
}
impl<S> State<S> {
    pub fn is_open(&self, key: &str) -> bool {
        self.menus.contains_key(key)
    }
}
pub struct Menu<S> {
    pub key: String,
    pub label: String,
    pub items: Vec<Rc<Item<S>>>,
    pub min_items: usize,
    pub on_open_change: Option<Rc<dyn Fn(&mut S, bool, &mut Tx)>>,
    pub on_focus_restored: Option<Action<S>>,
}
impl<S> Menu<S> {
    pub fn new(key: &str, label: &str, items: Vec<Rc<Item<S>>>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            items,
            min_items: 1,
            on_open_change: None,
            on_focus_restored: None,
        }
    }
}
fn clear_hover<S>(s: &mut S, at: StateAt<S>, key: &str, tx: &mut Tx) {
    let leave = at(s)
        .and_then(|m| m.menus.get_mut(key))
        .and_then(|m| m.hovered.take())
        .and_then(|(_, leave)| leave);
    if let Some(leave) = leave {
        leave(s, tx);
    }
}
fn open<S>(s: &mut S, at: StateAt<S>, menu: &Menu<S>, tx: &mut Tx) {
    let Some(state) = at(s) else { return };
    if state.is_open(&menu.key) {
        return;
    }
    state.menus.insert(
        menu.key.clone(),
        Open {
            hovered: None,
            restored: menu.on_focus_restored.clone(),
        },
    );
    if let Some(change) = &menu.on_open_change {
        change(s, true, tx);
    }
}
fn unique_items<S>(menu: &Menu<S>) -> Vec<Rc<Item<S>>> {
    let mut items: Vec<Rc<Item<S>>> = vec![];
    for item in &menu.items {
        if let Some(index) = items.iter().position(|old| old.key == item.key) {
            items[index] = item.clone();
        } else {
            items.push(item.clone());
        }
    }
    items
}
fn close<S>(
    s: &mut S,
    at: StateAt<S>,
    menu: &Menu<S>,
    action: Option<Action<S>>,
    focus: Option<Focus<S>>,
    tx: &mut Tx,
) {
    clear_hover(s, at, &menu.key, tx);
    let Some(state) = at(s) else { return };
    if state.menus.remove(&menu.key).is_none() {
        return;
    }
    state.pending.push(Pending {
        action,
        restored: menu.on_focus_restored.clone(),
        focus,
        menu: menu.key.clone(),
    });
    if let Some(change) = &menu.on_open_change {
        change(s, false, tx);
    }
    tx.wake_after(Duration::ZERO);
}
/// Keep State in the application, outside virtualized rows. Poll after input commits;
/// selected callbacks survive item replacement, clear(), and disappearance of their row.
pub fn poll<S>(s: &mut S, at: StateAt<S>, tx: &mut Tx) -> bool {
    let Some(state) = at(s) else { return false };
    let pending = std::mem::take(&mut state.pending);
    let mut delivered = false;
    for mut pending in pending {
        if tx.focused().is_some_and(|key| {
            key == format!("{}:menu", pending.menu)
                || key.starts_with(&format!("{}:item:", pending.menu))
        }) {
            if let Some(state) = at(s) {
                state.pending.push(pending);
            }
            tx.wake_after(Duration::ZERO);
            continue;
        }
        let target = pending.focus.take().and_then(|target| target(s));
        if let Some(target) = target.filter(|_| {
            tx.focused()
                .is_none_or(|key| key == format!("{}:trigger", pending.menu))
        }) {
            tx.return_focus(target, false);
            if let Some(state) = at(s) {
                state.pending.push(pending);
            }
            tx.wake_after(Duration::ZERO);
            delivered = true;
            continue;
        }
        if let Some(action) = pending.action.clone() {
            action(s, tx);
            if pending.restored.is_some() {
                if let Some(state) = at(s) {
                    state.pending.push(Pending {
                        action: None,
                        ..pending
                    });
                    tx.wake_after(Duration::ZERO);
                }
            }
        } else if let Some(restored) = pending.restored {
            restored(s, tx);
        }
        delivered = true;
    }
    delivered
}
/// Release pointer previews when the caller removes a row or its items.
pub fn clear<S>(s: &mut S, at: StateAt<S>, key: &str, tx: &mut Tx) {
    clear_hover(s, at, key, tx);
    if let Some(state) = at(s) {
        if let Some(open) = state.menus.remove(key) {
            state.pending.push(Pending {
                action: None,
                restored: open.restored,
                focus: None,
                menu: key.into(),
            });
            tx.wake_after(Duration::ZERO);
        }
    }
}
/// Synchronize changed items/min_items before publishing the new model.
pub fn sync<S>(s: &mut S, at: StateAt<S>, menu: &Menu<S>, tx: &mut Tx) {
    let Some(open) = at(s).and_then(|state| state.menus.get_mut(&menu.key)) else {
        return;
    };
    open.restored = menu.on_focus_restored.clone();
    let removed = open
        .hovered
        .as_ref()
        .is_some_and(|(key, _)| !menu.items.iter().any(|item| &item.key == key));
    if menu.items.len() < menu.min_items {
        clear(s, at, &menu.key, tx);
    } else if removed {
        clear_hover(s, at, &menu.key, tx);
    }
}
/// Place the optional surface in rune-kit::root's layer. Trigger geometry belongs to its
/// real caller (FileRowActions supplies its compact icon control).
pub fn view<S: 'static>(
    state: &State<S>,
    at: StateAt<S>,
    menu: Rc<Menu<S>>,
    trigger: El,
    viewport_width: f32,
) -> (El, Option<El>) {
    if menu.items.len() < menu.min_items {
        return (rune::el(), None);
    }
    let t = tokens(layout::dark());
    let k = &*kit(layout::dark());
    let trigger_key = format!("{}:trigger", menu.key);
    let items = unique_items(&menu);
    let key_action = menu.clone();
    let first = items.first().map(|item| item.key.clone());
    let last = items.last().map(|item| item.key.clone());
    let action = menu.clone();
    let pressed_first = first.clone();
    let control = trigger
        .key(trigger_key.clone())
        .label(&menu.label)
        .help(&menu.label)
        .expanded(state.is_open(&menu.key))
        .on_press_tx(move |s, tx| {
            let Some(state) = at(s) else { return };
            if state.is_open(&action.key) {
                close(s, at, &action, None, None, tx);
            } else {
                open(s, at, &action, tx);
                if tx.by_keys() || tx.press_point().is_none() {
                    if let Some(first) = &pressed_first {
                        tx.focus(format!("{}:item:{first}", action.key), true);
                    }
                }
            }
        })
        .on_key(move |s, event, tx| {
            let target = match event.key {
                rune::Key::Down | rune::Key::Enter => &first,
                rune::Key::Up => &last,
                _ => return false,
            };
            if event.mods != rune::Mods::default() {
                return false;
            }
            open(s, at, &key_action, tx);
            if let Some(target) = target {
                tx.focus(format!("{}:item:{target}", key_action.key), true);
            }
            true
        });
    if !state.is_open(&menu.key) {
        return (control, None);
    }
    let rows = items.into_iter().map(|item| {
        let metric = |name| t.metric("actionMenuItem", name).px();
        let key = format!("{}:item:{}", menu.key, item.key);
        let icon_size = t.metric("actionMenuIcon", "width").px();
        let mut slot = rune::row()
            .size(icon_size, t.metric("actionMenuIcon", "height").px())
            .center()
            .a11y_hidden();
        if let Some(icon) = &item.icon {
            slot = slot.child(icon());
        }
        let label = rune::text(&item.label)
            .font(
                rune::TextStyle::new(metric("fontSize"), metric("fontWeight"))
                    .lh(metric("lineHeight")),
            )
            .color(t.color("text-primary"))
            .wrap_anywhere()
            .min_w(0.0)
            .grow(1.0);
        let mut row = rune::row()
            .key(key)
            .w_full()
            .min_h(metric("minHeight"))
            .px(metric("paddingLeft"))
            .py(metric("paddingTop"))
            .gap(metric("columnGap"))
            .items_center()
            .radius(metric("borderRadius"))
            .role("menuitem")
            .label(&item.label)
            .aria_disabled(item.disabled)
            .focusable(true)
            .no_focus_ring()
            .focus_highlight(t.color("menu-item-hover-bg"))
            .child(slot)
            .child(label);
        if let Some(checked) = item.checked {
            row = row.role("menuitemcheckbox").checked(checked);
        }
        if let Some(description) = &item.description {
            row = row.description(description).help(description);
        }
        if item.disabled {
            return row.opacity(t.metric("actionMenuDisabled", "opacity").px());
        }
        let hovered = item.clone();
        let owner = menu.key.clone();
        row = row.on_hover_change(move |s, inside, tx| {
            if inside {
                clear_hover(s, at, &owner, tx);
                if let Some(state) = at(s).and_then(|m| m.menus.get_mut(&owner)) {
                    state.hovered = Some((hovered.key.clone(), hovered.on_mouse_leave.clone()));
                }
                if let Some(enter) = &hovered.on_mouse_enter {
                    enter(s, tx);
                }
            } else if at(s).and_then(|m| m.menus.get(&owner)).is_some_and(|m| {
                m.hovered
                    .as_ref()
                    .is_some_and(|(key, _)| key == &hovered.key)
            }) {
                clear_hover(s, at, &owner, tx);
            }
        });
        let menu = menu.clone();
        row.on_press_tx(move |s, tx| {
            clear_hover(s, at, &menu.key, tx);
            if item.select_before_close {
                (item.on_select)(s, tx);
                tx.return_focus(format!("{}:trigger", menu.key), false);
                close(s, at, &menu, None, item.focus_after_select.clone(), tx);
            } else {
                close(s, at, &menu, Some(item.on_select.clone()), None, tx);
            }
        })
    });
    let dismiss = menu.clone();
    let surface = rune::col()
        .key(format!("{}:menu", menu.key))
        .role("menu")
        .label(&menu.label)
        .focus_group()
        .focusable(true)
        .tab_index(-1)
        .focus_return(&trigger_key)
        .modal_tx(true, move |s, tx| close(s, at, &dismiss, None, None, tx))
        .min_w(t.metric("actionMenu", "minWidth").px())
        .max_w((viewport_width - t.metric("actionMenu", "viewportInset").px()).max(0.0))
        .px(t.metric("actionMenu", "paddingLeft").px())
        .py(t.metric("actionMenu", "paddingTop").px())
        .border(
            t.metric("actionMenu", "borderTopWidth").px(),
            t.color("border-base"),
        )
        .border_layout()
        .radius(t.metric("actionMenu", "borderRadius").px())
        .fill(t.color("surface-overlay"))
        .children(rows);
    let surface = k.elevate(surface, &k.elevation.floating);
    let surface = popover::anchored(
        k,
        surface,
        &trigger_key,
        Placement::BottomEnd,
        t.metric("actionMenu", "gutter").px(),
    )
    .transition(rune::Transition::identity());
    (control, Some(surface))
}

#[cfg(test)]
#[path = "action_menu_tests.rs"]
mod tests;
