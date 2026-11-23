//! Offscreen shared-component gallery; every action only updates synthetic state.
use rune::{Cx, El, TextStyle, Tx};
use rune_theme_codenomad::{
    action_menu::{self, Item, Menu},
    file_row_actions::{self as actions, Actions, Budget, Visibility},
    layout, tokens,
    workspace_tree::icons,
};
use std::rc::Rc;

struct Gallery {
    row: actions::State,
    menus: action_menu::State<Gallery>,
    actions: Rc<Actions<Gallery>>,
    width: f32,
    viewport: f32,
    checked: bool,
    disabled: bool,
    count: usize,
    dark: bool,
    rtl: bool,
    coarse: bool,
    focus_within: bool,
}
fn row_at<'a>(s: &'a mut Gallery, key: &str) -> Option<&'a mut actions::State> {
    (key == "files").then_some(&mut s.row)
}
fn menu_at(s: &mut Gallery) -> Option<&mut action_menu::State<Gallery>> {
    Some(&mut s.menus)
}
fn trace(event: &str, tx: &Tx) {
    println!(
        "file-actions-event:{}",
        serde_json::json!({"event":event,"focus":tx.focused()})
    );
}
fn descriptor(checked: bool, disabled: bool, count: usize) -> Rc<Actions<Gallery>> {
    let mut pin = Item::new("preview", "Preview", |s: &mut Gallery, tx| {
        trace("preview", tx);
        s.checked = !s.checked;
        s.actions = descriptor(s.checked, s.disabled, s.count);
    });
    pin.checked = Some(checked);
    pin.icon = Some(Rc::new(|| rune::icon(&icons::EYE, 14.0)));
    let secondary = [
        ("open", "Open", &actions::icons::EXTERNAL_LINK, disabled),
        ("disabled", "Disabled", &actions::icons::TRASH, true),
        ("copy", "Copy", &icons::COPY, disabled),
    ];
    let mut items = vec![Rc::new(pin)];
    for (key, label, icon, disabled) in secondary.into_iter().take(count) {
        let mut item = Item::new(key, label, move |_: &mut Gallery, tx| trace(key, tx));
        item.disabled = disabled;
        item.icon = Some(Rc::new(move || rune::icon(icon, 14.0)));
        items.push(Rc::new(item));
    }
    let mut menu = Menu::new("files", "Actions", items);
    menu.on_open_change = Some(Rc::new(|_, open, tx| {
        trace(if open { "menu-open" } else { "menu-close" }, tx)
    }));
    menu.on_focus_restored = Some(Rc::new(|_, tx| trace("restored", tx)));
    Rc::new(Actions::new(menu))
}
fn init() -> Gallery {
    let width = std::env::var("RUNE_ACTIONS_WIDTH")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(360.0);
    assert!(width.is_finite() && (80.0..=1200.0).contains(&width));
    Gallery {
        row: Default::default(),
        menus: Default::default(),
        actions: descriptor(false, false, 3),
        width,
        viewport: 480.0,
        checked: false,
        disabled: false,
        count: 3,
        dark: false,
        rtl: std::env::var("RUNE_ACTIONS_RTL").as_deref() == Ok("true"),
        coarse: std::env::var("RUNE_ACTIONS_COARSE").as_deref() == Ok("true"),
        focus_within: false,
    }
}
fn poll(s: &mut Gallery, tx: &mut Tx) -> bool {
    let changed = action_menu::poll(s, menu_at, tx);
    let focused = tx.focused().is_some_and(|key| {
        key == "row"
            || key == "files:trigger"
            || key.starts_with("files:pinned:")
            || key.starts_with("files:inline:")
    });
    let focus_changed = s.focus_within != focused;
    s.focus_within = focused;
    let t = tokens(s.dark);
    let font = TextStyle::new(
        t.metric("workspaceRow", "fontSize").px(),
        t.metric("workspaceRow", "fontWeight").px(),
    )
    .lh(t.metric("workspaceRow", "lineHeight").px());
    let required = rune::text::measure("example.rs", &[], font, None).0
        + actions::natural_width(&s.actions)
        + t.metric("workspaceRow", "columnGap").px()
        + t.metric("workspaceRow", "paddingInlineEnd").px();
    let compact_changed = layout::with_appearance(s.dark, || {
        actions::sync(
            &mut s.row,
            &s.actions,
            s.menus.is_open("files"),
            Budget {
                available: s.width,
                required,
            },
            tx,
        )
    });
    changed || focus_changed || compact_changed
}
fn view(s: &Gallery, cx: &mut Cx<Gallery>) -> El {
    layout::render(cx, |cx| {
        let dark = layout::dark();
        let t = tokens(dark);
        let m = |key| t.metric("workspaceRow", key).px();
        let (group, popup) = actions::view(
            &s.row,
            row_at,
            &s.menus,
            menu_at,
            s.actions.clone(),
            Visibility {
                coarse_pointer: s.coarse,
                focus_within: s.focus_within,
            },
            s.viewport,
        );
        let row = rune::row()
            .key("row")
            .role("treeitem")
            .label("Synthetic row")
            .focusable(true)
            .dir(if s.rtl {
                rune::Direction::Rtl
            } else {
                rune::Direction::Ltr
            })
            .w(s.width)
            .min_h(m("minHeight"))
            .pt(m("paddingTop"))
            .pb(m("paddingBottom"))
            .pr(m("paddingInlineEnd"))
            .gap(m("columnGap"))
            .center_y()
            .hover_group()
            .motion(rune::Spring::NONE)
            .on_press_tx(|_: &mut Gallery, tx| trace("row", tx))
            .child(
                rune::el()
                    .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(t.color("surface-hover-overlay"))
                    .group_opacity(if s.focus_within { 1.0 } else { 0.0 }, 1.0)
                    .a11y_hidden(),
            )
            .child(
                rune::text("example.rs")
                    .key("label")
                    .grow(1.0)
                    .shrink()
                    .min_w(0.0)
                    .truncate()
                    .font(TextStyle::new(m("fontSize"), m("fontWeight")).lh(m("lineHeight")))
                    .color(t.color("text-secondary")),
            )
            .child(group);
        let control = |key: &'static str, label: &'static str, width| {
            layout::button_tx(label, false, move |s: &mut Gallery, tx| {
                s.width = width;
                trace(key, tx);
            })
            .key(key)
        };
        let scene = rune::col()
            .key("scene")
            .w_full()
            .h_full()
            .fill(t.color("surface-canvas"))
            .on_layout_tx(move |s: &mut Gallery, [_, _, width, _], tx| {
                s.viewport = width;
                s.dark = dark;
                poll(s, tx);
            })
            .child(row)
            .child(
                rune::row()
                    .gap(4.0)
                    .child(control("narrow", "Narrow", 110.0))
                    .child(control("wide", "Wide", 400.0)),
            )
            .child(layout::button("Outside", false, |_: &mut Gallery| {}).key("outside"));
        let _ = cx.layout_size("scene");
        rune_kit::root(scene, popup)
    })
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "--tree") || !args.iter().any(|arg| arg == "--snap") {
        std::process::exit(2);
    }
    rune::run(rune::AppSpec {
        poll: Some(|s, _, tx| poll(s, tx)),
        ..layout::app_spec("File row actions", init, view)
    });
}
