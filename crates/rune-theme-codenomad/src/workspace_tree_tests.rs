use super::*;
use rune::{Cx, Env, Key, KeyEvent, Mods, Runtime};

#[derive(Default)]
struct App {
    rtl: bool,
    selected: bool,
    expanded: Option<bool>,
    busy: bool,
    clicks: usize,
    actions: usize,
}
fn view(s: &App, cx: &mut Cx<App>) -> El {
    cx.web_focus();
    rune::col()
        .w_full()
        .h_full()
        .dir(if s.rtl {
            rune::Direction::Rtl
        } else {
            rune::Direction::Ltr
        })
        .role("tree")
        .child(
            row(
                cx.system_dark(),
                s.rtl,
                Row {
                    label: "src",
                    depth: 1,
                    selected: s.selected,
                    expanded: s.expanded,
                    icon: &icons::CHEVRON_RIGHT,
                    busy: s.busy,
                    actions: Some(
                        rune::text("Action")
                            .h(24.0)
                            .key("action")
                            .role("button")
                            .label("Preview")
                            .focusable(true)
                            .on_press(|s: &mut App| s.actions += 1),
                    ),
                },
            )
            .key("row")
            .on_press(|s: &mut App| s.clicks += 1),
        )
}

#[test]
fn busy_folder_exposes_and_clears_accesskit_state() {
    let mut rt = runtime(false, false, Some(true));
    for busy in [true, false] {
        rt.update(move |s, _| s.busy = busy);
        rt.frame(0.02);
        let (_, row) = rt
            .accessibility_tree()
            .nodes
            .into_iter()
            .find(|(_, node)| node.author_id() == Some("row"))
            .unwrap();
        assert_eq!(row.is_busy(), busy);
    }
}
fn runtime(dark: bool, rtl: bool, expanded: Option<bool>) -> Runtime<App> {
    let mut rt = Runtime::new(
        App {
            rtl,
            expanded,
            selected: true,
            ..App::default()
        },
        view,
        (360.0, 80.0),
        Env::new(dark, 1.0),
    );
    rt.frame(0.0);
    rt
}
#[test]
fn row_retains_names_levels_selection_and_lazy_branch_semantics() {
    for dark in [false, true] {
        for rtl in [false, true] {
            for expanded in [None, Some(false), Some(true)] {
                let rt = runtime(dark, rtl, expanded);
                let tree = rt.accessibility_json();
                fn find<'a>(
                    tree: &'a serde_json::Value,
                    role: &str,
                ) -> Option<&'a serde_json::Value> {
                    if tree["role"] == role {
                        return Some(tree);
                    }
                    tree["children"]
                        .as_array()?
                        .iter()
                        .find_map(|child| find(child, role))
                }
                let row = find(&tree, "tree-item").unwrap_or_else(|| panic!("{tree}"));
                assert_eq!(row["name"], "src");
                assert_eq!(row["level"], 1);
                let states = row["states"].as_array().unwrap();
                assert!(states.iter().any(|s| s == "selected"));
                assert_eq!(
                    states.iter().any(|s| s == "expanded"),
                    expanded == Some(true)
                );
                assert_eq!(
                    states.iter().any(|s| s == "collapsed"),
                    expanded == Some(false)
                );
                assert_eq!(find(&tree, "button").unwrap()["name"], "Preview");
            }
        }
    }
}
#[test]
fn source_geometry_mirrors_indent_and_keeps_14px_icon_and_12px_chevron() {
    for rtl in [false, true] {
        let rt = runtime(false, rtl, Some(false));
        let elements = rt.elements();
        let bounds = |key: &str| {
            elements
                .iter()
                .find(|e| e.key.as_deref() == Some(key))
                .unwrap()
                .rect
        };
        let glyph = bounds("icon");
        let lane = bounds("chevron");
        let whole = bounds("row");
        assert_eq!(whole[3], 30.0, "Source 24px actions plus block padding");
        assert_eq!(glyph[2], 14.0);
        assert_eq!(lane[2], 12.0);
        if rtl {
            assert_eq!(360.0 - lane[0] - lane[2], 22.0);
            assert!(glyph[0] < lane[0]);
        } else {
            assert_eq!(lane[0], 22.0);
            assert!(glyph[0] > lane[0]);
        }
    }
}
#[test]
fn caller_owns_row_activation_and_nested_action_does_not_activate_row() {
    let mut rt = runtime(false, false, Some(false));
    let (x, y) = rt.find("row").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    assert_eq!(rt.state.clicks, 1);
    assert_eq!(rt.state.actions, 0);
    let (x, y) = rt.find("action").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    assert_eq!(rt.state.actions, 1);
    assert_eq!(rt.state.clicks, 1);
    rt.update(|_, tx| tx.focus("row", true));
    rt.frame(0.0);
    rt.key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    rt.frame(0.0);
    assert_eq!(rt.state.clicks, 2);
}
