//! File-row actions share their items and popup state with the owner's menu.
use crate::{
    action_menu::{Item, Menu},
    layout, tokens,
};
use rune::Tx;
use std::rc::Rc;
pub mod icons;
mod view;
pub use view::view;

pub type StateAt<S> = for<'a> fn(&'a mut S, &str) -> Option<&'a mut State>;
pub struct Actions<S> {
    pub menu: Rc<Menu<S>>,
    pinned: Vec<Rc<Item<S>>>,
}
impl<S> Actions<S> {
    pub fn new(mut menu: Menu<S>) -> Self {
        let (pinned, secondary) = menu
            .items
            .into_iter()
            .partition(|item: &Rc<Item<S>>| item.checked.is_some());
        menu.items = secondary;
        Self {
            menu: Rc::new(menu),
            pinned,
        }
    }
}
#[derive(Default)]
pub struct State {
    compact: bool,
    hovered: Option<String>,
    focused: Option<String>,
    focus_visible: bool,
}
impl State {
    pub fn compact(&self) -> bool {
        self.compact
    }
}
#[derive(Clone, Copy)]
pub struct Budget {
    pub available: f32,
    pub required: f32,
}
#[derive(Clone, Copy, Default)]
pub struct Visibility {
    pub coarse_pointer: bool,
    pub focus_within: bool,
}

pub fn natural_width<S>(actions: &Actions<S>) -> f32 {
    let t = tokens(layout::dark());
    let count = actions.pinned.len() + actions.menu.items.len();
    count as f32 * t.metric("fileRowAction", "minWidth").px()
        + count.saturating_sub(1) as f32 * t.metric("fileRowActions", "gap").px()
}
pub fn sync<S>(
    state: &mut State,
    actions: &Actions<S>,
    open: bool,
    budget: Budget,
    tx: &mut Tx,
) -> bool {
    let prefix = format!("{}:", actions.menu.key);
    let focused = tx
        .focused()
        .filter(|key| key.starts_with(&prefix))
        .map(str::to_owned);
    let mut changed = state.focused != focused || state.focus_visible != tx.focus_visible();
    state.focused = focused;
    state.focus_visible = tx.focus_visible();
    if actions.menu.items.is_empty()
        || !budget.available.is_finite()
        || budget.available <= 0.0
        || !budget.required.is_finite()
    {
        return changed;
    }
    let next = open
        || budget.required
            > budget.available
                + tokens(layout::dark())
                    .metric("fileRowActions", "overflowSlop")
                    .px();
    if next == state.compact {
        return changed;
    }
    let trigger = format!("{}:trigger", actions.menu.key);
    let menu_prefix = format!("{}:item:", actions.menu.key);
    if !open
        && state.compact
        && tx.focused().is_some_and(|key| {
            key.starts_with(&menu_prefix) || key == format!("{}:menu", actions.menu.key)
        })
    {
        tx.wake_after(std::time::Duration::ZERO);
        return changed;
    }
    let inline_prefix = format!("{}:inline:", actions.menu.key);
    if tx
        .focused()
        .is_some_and(|key| key == trigger || key.starts_with(&inline_prefix))
    {
        let target = if next {
            Some(trigger)
        } else {
            actions
                .menu
                .items
                .iter()
                .find(|item| !item.disabled)
                .map(|item| format!("{}:inline:{}", actions.menu.key, item.key))
        };
        if let Some(target) = target {
            tx.focus(target, tx.focus_visible())
        }
    }
    state.compact = next;
    changed = true;
    changed
}

#[cfg(test)]
mod tests;
