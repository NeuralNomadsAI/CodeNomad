//! Launcher recent-tab overflow menu with single-line items and generous width.
use crate::{Space, kit, layout, tokens};
use rune::{El, Tx};
use rune_kit::{Placement, popover};
use std::{collections::HashMap, rc::Rc, time::Duration};

const RECENT_MENU_MIN_WIDTH: f32 = 256.0;
const RECENT_MENU_MIN_PAD_Y: f32 = 6.0;

pub type Action<S> = Rc<dyn Fn(&mut S, &mut Tx)>;
pub type Focus<S> = Rc<dyn Fn(&S) -> Option<String>>;
pub type StateAt<S> = fn(&mut S) -> Option<&mut State<S>>;

pub struct Item<S> {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
    pub icon: Option<Rc<dyn Fn() -> El>>,
    pub disabled: bool,
    pub on_select: Action<S>,
}

impl<S> Item<S> {
    pub fn new(key: &str, label: &str, select: impl Fn(&mut S, &mut Tx) + 'static) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            description: None,
            icon: None,
            disabled: false,
            on_select: Rc::new(select),
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
            pending: Vec::new(),
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
    pub on_open_change: Option<Rc<dyn Fn(&mut S, bool, &mut Tx)>>,
    pub on_focus_restored: Option<Action<S>>,
}

impl<S> Menu<S> {
    pub fn new(key: &str, label: &str, items: Vec<Rc<Item<S>>>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            items,
            on_open_change: None,
            on_focus_restored: None,
        }
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
            restored: menu.on_focus_restored.clone(),
        },
    );
    if let Some(change) = &menu.on_open_change {
        change(s, true, tx);
    }
}

fn close<S>(
    s: &mut S,
    at: StateAt<S>,
    menu: &Menu<S>,
    action: Option<Action<S>>,
    focus: Option<Focus<S>>,
    tx: &mut Tx,
) {
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
            if pending.restored.is_some()
                && let Some(state) = at(s)
            {
                state.pending.push(Pending {
                    action: None,
                    ..pending
                });
                tx.wake_after(Duration::ZERO);
            }
        } else if let Some(restored) = pending.restored {
            restored(s, tx);
        }
        delivered = true;
    }
    delivered
}

pub fn clear<S>(s: &mut S, at: StateAt<S>, key: &str, tx: &mut Tx) {
    if let Some(state) = at(s)
        && let Some(open) = state.menus.remove(key)
    {
        state.pending.push(Pending {
            action: None,
            restored: open.restored,
            focus: None,
            menu: key.into(),
        });
        tx.wake_after(Duration::ZERO);
    }
}

pub fn view<S: 'static>(
    state: &State<S>,
    at: StateAt<S>,
    menu: Rc<Menu<S>>,
    trigger: El,
    viewport_width: f32,
) -> (El, Option<El>) {
    if menu.items.is_empty() {
        return (rune::el(), None);
    }
    let t = tokens(layout::dark());
    let k = &*kit(layout::dark());
    let trigger_key = format!("{}:trigger", menu.key);
    let first = menu.items.first().map(|item| item.key.clone());
    let last = menu.items.last().map(|item| item.key.clone());
    let action = menu.clone();
    let pressed_first = first.clone();
    let key_action = menu.clone();
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
                if (tx.by_keys() || tx.press_point().is_none())
                    && let Some(first) = &pressed_first
                {
                    tx.focus(format!("{}:item:{first}", action.key), true);
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
    let item_h = t.metric("actionMenuItem", "minHeight").px();
    let item_px = t.metric("actionMenuItem", "paddingLeft").px();
    let item_gap = t.metric("actionMenuItem", "columnGap").px();
    let item_radius = t.metric("actionMenuItem", "borderRadius").px();
    let item_font = rune::TextStyle::new(
        t.metric("actionMenuItem", "fontSize").px(),
        t.metric("actionMenuItem", "fontWeight").px(),
    )
    .lh(t.metric("actionMenuItem", "lineHeight").px());
    let icon_w = t.metric("actionMenuIcon", "width").px();
    let icon_h = t.metric("actionMenuIcon", "height").px();

    let rows = menu.items.iter().cloned().map(|item| {
        let key = format!("{}:item:{}", menu.key, item.key);
        let mut slot = rune::row().size(icon_w, icon_h).center().a11y_hidden();
        if let Some(icon) = &item.icon {
            slot = slot.child(icon());
        }
        let label = rune::text(&item.label)
            .font(item_font.clone())
            .color(t.color("text-primary"))
            .truncate()
            .min_w(0.0)
            .grow(1.0);
        let mut row = rune::row()
            .key(key)
            .w_full()
            .h(item_h)
            .px(item_px)
            .gap(item_gap)
            .items_center()
            .radius(item_radius)
            .role("menuitem")
            .label(&item.label)
            .aria_disabled(item.disabled)
            .focusable(true)
            .no_focus_ring()
            .focus_highlight(t.color("menu-item-hover-bg"))
            .child(slot)
            .child(label);
        if let Some(description) = &item.description {
            row = row.description(description).help(description);
        }
        if item.disabled {
            return row.opacity(t.metric("actionMenuDisabled", "opacity").px());
        }
        let menu = menu.clone();
        row.hover(t.color("menu-item-hover-bg"))
            .on_press_tx(move |s, tx| {
                close(s, at, &menu, Some(item.on_select.clone()), None, tx);
            })
    });
    let max_w = (viewport_width - t.metric("actionMenu", "viewportInset").px()).max(0.0);
    let min_w = t
        .metric("actionMenu", "minWidth")
        .px()
        .max(RECENT_MENU_MIN_WIDTH)
        .min(max_w);
    let pad_x = t
        .metric("actionMenu", "paddingLeft")
        .px()
        .max(t.space(Space::Xs).px());
    let pad_y = t
        .metric("actionMenu", "paddingTop")
        .px()
        .max(RECENT_MENU_MIN_PAD_Y);
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
        .min_w(min_w)
        .max_w(max_w)
        .px(pad_x)
        .py(pad_y)
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
