use crate::strings::t;
use rune::{AppSpec, Cx, El, Tx};
use rune_theme_codenomad::{action_menu as menu, action_menu_scene as scene, layout};
use std::rc::Rc;

struct Gallery {
    menu: menu::State<Gallery>,
    locale: &'static str,
    case: String,
    highlighted: bool,
    dialog: bool,
    checked: bool,
}
fn at(s: &mut Gallery) -> Option<&mut menu::State<Gallery>> {
    Some(&mut s.menu)
}
fn event(name: &str, tx: &Tx) {
    println!(
        "action-menu-event:{}",
        serde_json::json!({"event":name,"focus":tx.focused()})
    );
}
fn init() -> Gallery {
    Gallery {
        menu: Default::default(),
        locale: rune_theme_codenomad::catalogue::SUPPORTED_LOCALES
            .iter()
            .copied()
            .find(|locale| Some(*locale) == std::env::var("RUNE_MENU_LOCALE").ok().as_deref())
            .unwrap_or("en"),
        case: std::env::var("RUNE_MENU_CASE").unwrap_or_else(|_| "standard".into()),
        highlighted: false,
        dialog: false,
        checked: true,
    }
}
fn descriptor(s: &Gallery) -> Rc<menu::Menu<Gallery>> {
    let mut open = menu::Item::new(
        "open",
        t("directoryBrowser.openCurrent"),
        |s: &mut Gallery, tx| {
            event("select", tx);
            s.dialog = true;
        },
    );
    open.description = Some(t("rune.details").into());
    open.select_before_close = matches!(s.case.as_str(), "immediate" | "focus-after");
    if s.case == "focus-after" {
        open.focus_after_select = Some(Rc::new(|_| Some("dialog-second".into())));
    }
    open.on_mouse_enter = Some(Rc::new(|_, tx| event("enter", tx)));
    open.on_mouse_leave = Some(Rc::new(|_, tx| event("leave", tx)));
    let mut disabled = menu::Item::new("disabled", t("commands.common.disabled"), |_, tx| {
        event("disabled-select", tx)
    });
    disabled.disabled = true;
    let mut checked = menu::Item::new(
        "checked",
        t("window.menu.native.copy"),
        |s: &mut Gallery, tx| {
            event("checked-select", tx);
            s.checked = !s.checked;
        },
    );
    checked.checked = Some(s.checked);
    if s.case == "all-disabled" {
        open.disabled = true;
        checked.disabled = true;
    }
    let mut items = vec![Rc::new(open), Rc::new(disabled), Rc::new(checked)];
    if s.case == "duplicate" {
        items.push(Rc::new(menu::Item::new(
            "open",
            t("directoryBrowser.openCurrent"),
            |s: &mut Gallery, tx| {
                event("replacement-select", tx);
                s.dialog = true;
            },
        )));
    }
    let mut menu = menu::Menu::new("actions", t("folderSelection.recent.actions"), items);
    menu.on_open_change = Some(Rc::new(|_, open, tx| {
        event(if open { "open" } else { "close" }, tx)
    }));
    menu.on_focus_restored = Some(Rc::new(|_, tx| event("restored", tx)));
    Rc::new(menu)
}
fn view(s: &Gallery, cx: &mut Cx<Gallery>) -> El {
    crate::strings::with_locale(s.locale, || {
        layout::render(cx, |cx| {
            let width = cx
                .window_layout("menu-scene")
                .map_or(layout::initial_window().0, |r| r[2]);
            let trigger =
                scene::trigger(s.highlighted).on_hover_change(|s: &mut Gallery, inside, _| {
                    s.highlighted = inside;
                });
            let (trigger, surface) = menu::view(&s.menu, at, descriptor(s), trigger, width);
            let mut layers: Vec<_> = surface.into_iter().collect();
            if s.dialog {
                let cancel = layout::button_tx(
                    t("alertDialog.actions.cancel"),
                    false,
                    |s: &mut Gallery, tx| {
                        event("dialog-close", tx);
                        s.dialog = false;
                    },
                )
                .key("dialog-cancel")
                .autofocus();
                let second = layout::button_tx(
                    t("directoryBrowser.openCurrent"),
                    false,
                    |_: &mut Gallery, tx| event("dialog-second", tx),
                )
                .key("dialog-second");
                layers.push(
                    scene::dialog(rune::col().child(cancel).child(second))
                        .key("dialog")
                        .role("dialog")
                        .label(t("directoryBrowser.openCurrent"))
                        .modal_tx(true, |s: &mut Gallery, tx| {
                            event("dialog-dismiss", tx);
                            s.dialog = false;
                        }),
                );
            }
            scene::surface(trigger, layers).key("menu-scene")
        })
    })
}
pub fn run() {
    let args: Vec<_> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "--tree") || !args.iter().any(|arg| arg == "--snap") {
        eprintln!("Offscreen action menu gallery requires --tree and --snap");
        std::process::exit(2);
    }
    rune::run(AppSpec {
        poll: Some(|s, _, tx| menu::poll(s, at, tx)),
        ..layout::app_spec(t("window.title.main"), init, view)
    });
}
