use super::*;
use crate::{action_menu, kit};
use rune::{Color, El, Icon};
use rune_kit::{Button, ButtonVariant};

static MORE: Icon = Icon {
    name: "lucide-more-horizontal",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></g>"#,
};

fn button<S: 'static>(
    state: &State,
    at: StateAt<S>,
    owner: &str,
    key: String,
    item: Rc<Item<S>>,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let hover = state.hovered.as_deref() == Some(key.as_str()) && !item.disabled;
    let focus =
        state.focused.as_deref() == Some(key.as_str()) && state.focus_visible && !item.disabled;
    let active = item.checked == Some(true) && !item.disabled;
    let bg = if active {
        t.color(if hover {
            "file-row-active-hover-bg"
        } else {
            "file-row-active-bg"
        })
    } else {
        Color::TRANSPARENT
    };
    let ink = t.color(if active || hover || focus {
        "text-primary"
    } else {
        "text-muted"
    });
    let alpha = if active || hover || focus {
        1.0
    } else {
        t.metric("fileRowAction", "opacity").px()
    };
    let glyph = item.icon.clone();
    let label = item.label.clone();
    let mut e = Button::new(&label)
        .variant(ButtonVariant::Ghost)
        .label_with(move |_, _| {
            glyph.map_or_else(rune::el, |glyph| {
                glyph()
                    .size(
                        t.metric("fileRowActionGlyph", "width").px(),
                        t.metric("fileRowActionGlyph", "height").px(),
                    )
                    .color(ink)
            })
        })
        .build(&kit(dark))
        .disabled(item.disabled)
        .key(&key)
        .help(&label)
        .size(
            t.metric("fileRowAction", "minWidth").px(),
            t.metric("fileRowAction", "minHeight").px(),
        )
        .padding(t.metric("fileRowAction", "paddingLeft").px())
        .gap(0.0)
        .radius(0.0)
        .fill(bg)
        .hover(Color::TRANSPARENT)
        .press(Color::TRANSPARENT)
        .opacity(alpha)
        .motion(rune::Spring::NONE)
        .focus_ring(
            t.metric("fileRowActionFocus", "outlineWidth").px(),
            t.metric("fileRowActionFocus", "outlineOffset").px(),
            t.color("accent-primary"),
        );
    if let Some(on) = item.checked {
        e = e.checked(on)
    }
    if !item.disabled {
        let action = item.on_select.clone();
        let enter = action.clone();
        e = e
            .on_press_tx(move |s, tx| action(s, tx))
            .on_key(move |s: &mut S, event, tx| {
                if event.key != rune::Key::Enter || event.mods != rune::Mods::default() {
                    return false;
                }
                if !tx.key_repeat() {
                    enter(s, tx);
                }
                true
            });
        let owner = owner.to_owned();
        e = e.on_hover_change(move |s, inside, _| {
            if let Some(state) = at(s, &owner) {
                if inside {
                    state.hovered = Some(key.clone())
                } else if state.hovered.as_deref() == Some(key.as_str()) {
                    state.hovered = None
                }
            }
        });
    }
    e
}
pub fn view<S: 'static>(
    state: &State,
    at: StateAt<S>,
    menus: &action_menu::State<S>,
    menu_at: action_menu::StateAt<S>,
    actions: Rc<Actions<S>>,
    visibility: Visibility,
    viewport: f32,
) -> (El, Option<El>) {
    let t = tokens(layout::dark());
    let key = &actions.menu.key;
    let open = menus.is_open(key);
    let compact = state.compact || open;
    let buttons = |items: &[Rc<Item<S>>], kind: &str| {
        rune::row()
            .gap(
                t.metric(
                    "fileRowActions",
                    if kind == "pinned" {
                        "pinnedGap"
                    } else {
                        "inlineGap"
                    },
                )
                .px(),
            )
            .center_y()
            .children(items.iter().map(|item| {
                button(
                    state,
                    at,
                    key,
                    format!("{key}:{kind}:{}", item.key),
                    item.clone(),
                )
            }))
    };
    let pinned = buttons(&actions.pinned, "pinned").key(format!("{key}:pinned"));
    let inline = buttons(&actions.menu.items, "inline").key(format!("{key}:inline"));
    let inline = if compact {
        inline
            .pin(None, Some(0.0), Some(0.0), None)
            .inert()
            .a11y_hidden()
            .opacity(0.0)
    } else {
        inline
    };
    let mut trigger_item = Item::new("trigger", &actions.menu.label, |_, _| {});
    trigger_item.icon = Some(Rc::new(move || {
        rune::icon(&MORE, t.metric("fileRowActionGlyph", "width").px())
    }));
    let trigger = button(
        state,
        at,
        key,
        format!("{key}:trigger"),
        Rc::new(trigger_item),
    );
    let (trigger, popup) =
        action_menu::view(menus, menu_at, actions.menu.clone(), trigger, viewport);
    let has_menu = actions.menu.items.len() >= actions.menu.min_items;
    let trigger = if compact && has_menu {
        trigger
    } else {
        trigger
            .pin(None, Some(0.0), Some(0.0), None)
            .inert()
            .a11y_hidden()
            .opacity(0.0)
    };
    let mut root = rune::row()
        .key(format!("{key}:actions"))
        .gap(t.metric("fileRowActions", "gap").px())
        .center_y()
        .motion(rune::Spring::NONE)
        .on_background_press(|_: &mut S| {})
        .child(pinned)
        .child(inline);
    if has_menu {
        root = root.child(trigger)
    }
    let reveal = visibility.coarse_pointer
        || visibility.focus_within
        || open
        || actions.pinned.iter().any(|item| item.checked == Some(true));
    root = root.group_opacity(if reveal { 1.0 } else { 0.0 }, 1.0);
    (root, popup)
}
